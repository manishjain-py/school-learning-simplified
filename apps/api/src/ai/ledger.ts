import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { ACTOR_DAILY_LIMIT, PROJECT_LIMIT_MICRO_USD, RESERVE_MICRO_USD, emptyResult, type InterpretationResult } from './types.js';
import { schoolLocalDate } from './dates.js';

/** School and operation come from the authorized server-side input, never a client quota option. */
export type Reservation = { requestKey: string; fingerprint: string; actorId: string; schoolId: string; operation: 'note' | 'draft'; now: Date };
export type UsageResult = Pick<InterpretationResult, 'requestKey' | 'model'>;
export type Claim<Result extends UsageResult = InterpretationResult> = { claimed: true } | { claimed: false; result: Result };
export type LedgerResultFactory<Result extends UsageResult> = (requestKey: string, status: 'processing' | 'failed', code: string, message: string, retryable?: boolean) => Result;
export interface UsageLedger<Result extends UsageResult = InterpretationResult> {
  claim(value: Reservation): Promise<Claim<Result>>;
  complete(value: Reservation, result: Result): Promise<void>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const project = { PK: 'AI_BUDGET#2026-10-27_2026-11-09', SK: 'PROJECT' };
const request = (key: string) => ({ PK: `AI_REQUEST#${key}`, SK: 'META' });
type RequestRecord<Result extends UsageResult> = { fingerprint: string; schoolId?: string; operation?: Reservation['operation']; state: 'running' | 'complete'; startedAt: string; result?: Result };
const demoPolicyKey = (schoolId: string) => ({ PK: `SCHOOL#${schoolId}`, SK: 'DEMO_AI_POLICY' });
const validDemoPolicy = (policy: Record<string, unknown>) => policy.kind === 'judge-demo-ai-policy' && policy.enabled === true && policy.noteDailyLimit === 20 && policy.draftDailyLimit === 20;

/** Reservations are never refunded: ambiguous network/timeout outcomes remain charged to the cap. */
export class DynamoUsageLedger<Result extends UsageResult = InterpretationResult> implements UsageLedger<Result> {
  private resultFactory: LedgerResultFactory<Result>;
  constructor(private tableName: string, private db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' })), ...factory: Result extends InterpretationResult ? [resultFactory?: LedgerResultFactory<Result>] : [resultFactory: LedgerResultFactory<Result>]) {
    // Custom result shapes must supply their own factory; legacy callers retain their exact defaults.
    this.resultFactory = (factory[0] || emptyResult) as unknown as LedgerResultFactory<Result>;
    if (tableName !== 'sls-hackathon-2026-data') throw new Error('AI ledger requires this project’s independent table.');
  }
  private async existing(value: Reservation): Promise<Result | null> {
    const response = await this.db.send(new GetCommand({ TableName: this.tableName, Key: request(value.requestKey), ConsistentRead: true }));
    const item = response.Item as RequestRecord<Result> | undefined;
    if (!item) return null;
    if (item.fingerprint !== value.fingerprint || (item.schoolId !== undefined && item.schoolId !== value.schoolId) || (item.operation !== undefined && item.operation !== value.operation)) return this.resultFactory(value.requestKey, 'failed', 'REQUEST_CHANGED', 'This log attempt has different inputs. Correct the log to create a new version.');
    if (item.state === 'complete' && item.result) return item.result;
    if (value.now.getTime() - Date.parse(item.startedAt) > 60_000) return this.resultFactory(value.requestKey, 'failed', 'ATTEMPT_INTERRUPTED', 'This attempt was interrupted. Retry with a new attempt; its original usage reservation remains.', true);
    return this.resultFactory(value.requestKey, 'processing', 'IN_PROGRESS', 'This log is already being interpreted. Refresh shortly.');
  }
  async claim(value: Reservation): Promise<Claim<Result>> {
    if (typeof value.schoolId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.schoolId) || !['note', 'draft'].includes(value.operation)) return { claimed: false, result: this.resultFactory(value.requestKey, 'failed', 'AI_SCOPE_REQUIRED', 'AI usage could not be matched to its school and action. No model request was started.') };
    const prior = await this.existing(value);
    if (prior) return { claimed: false, result: prior };
    // Only an operator can create this private record. Public school forms do not
    // accept quota policy fields. An absent record preserves ordinary-school caps.
    const policyKey = demoPolicyKey(value.schoolId);
    const policy = (await this.db.send(new GetCommand({ TableName: this.tableName, Key: policyKey, ConsistentRead: true }))).Item;
    if (policy && !validDemoPolicy(policy)) return { claimed: false, result: this.resultFactory(value.requestKey, 'failed', 'DEMO_AI_POLICY_INVALID', 'This demo school’s AI limits need an operator check. No model request was started.') };
    const day = schoolLocalDate(value.now, 'Asia/Kolkata');
    const actor = { PK: `AI_ACTOR#${digest(value.actorId)}`, SK: `DAY#${day}` };
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      { Update: { TableName: this.tableName, Key: project, UpdateExpression: 'ADD reservedMicroUsd :reserve, requests :one', ConditionExpression: 'attribute_not_exists(reservedMicroUsd) OR reservedMicroUsd <= :remaining', ExpressionAttributeValues: { ':reserve': RESERVE_MICRO_USD, ':one': 1, ':remaining': PROJECT_LIMIT_MICRO_USD - RESERVE_MICRO_USD } } },
      { Update: { TableName: this.tableName, Key: actor, UpdateExpression: 'ADD requests :one', ConditionExpression: 'attribute_not_exists(requests) OR requests < :limit', ExpressionAttributeValues: { ':one': 1, ':limit': ACTOR_DAILY_LIMIT } } },
      { Put: { TableName: this.tableName, Item: { ...request(value.requestKey), fingerprint: value.fingerprint, schoolId: value.schoolId, operation: value.operation, state: 'running', startedAt: value.now.toISOString(), reservedMicroUsd: RESERVE_MICRO_USD }, ConditionExpression: 'attribute_not_exists(PK)' } },
    ];
    if (policy) items.push(
      { ConditionCheck: { TableName: this.tableName, Key: policyKey, ConditionExpression: '#kind = :kind AND #enabled = :enabled AND noteDailyLimit = :limit AND draftDailyLimit = :limit', ExpressionAttributeNames: { '#kind': 'kind', '#enabled': 'enabled' }, ExpressionAttributeValues: { ':kind': 'judge-demo-ai-policy', ':enabled': true, ':limit': 20 } } },
      { Update: { TableName: this.tableName, Key: { PK: `AI_DEMO_SCHOOL#${value.schoolId}`, SK: `DAY#${day}#${value.operation}` }, UpdateExpression: 'ADD requests :one', ConditionExpression: 'attribute_not_exists(requests) OR requests < :limit', ExpressionAttributeValues: { ':one': 1, ':limit': 20 } } },
    );
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return { claimed: true };
    } catch (issue) {
      // A lost response or concurrent duplicate may have committed: reread before classifying it.
      const existing = await this.existing(value);
      if (existing) return { claimed: false, result: existing };
      const reasons = (issue as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed') return { claimed: false, result: this.resultFactory(value.requestKey, 'failed', 'PROJECT_AI_LIMIT', 'The project’s current AI allowance is exhausted. Guidance was not generated.') };
      if (reasons?.[1]?.Code === 'ConditionalCheckFailed') return { claimed: false, result: this.resultFactory(value.requestKey, 'failed', 'TEACHER_AI_LIMIT', 'This account has reached today’s AI limit. Retry tomorrow.', true) };
      if (policy && reasons?.[3]?.Code === 'ConditionalCheckFailed') return { claimed: false, result: this.resultFactory(value.requestKey, 'failed', 'DEMO_AI_POLICY_CHANGED', 'This demo school’s AI settings changed. Refresh before trying again.') };
      if (policy && reasons?.[4]?.Code === 'ConditionalCheckFailed') return { claimed: false, result: this.resultFactory(value.requestKey, 'failed', 'DEMO_SCHOOL_AI_LIMIT', `This demo school has reached today’s ${value.operation === 'note' ? 'classroom-note' : 'parent-draft'} AI limit. Try tomorrow.`, true) };
      throw issue;
    }
  }
  async complete(value: Reservation, result: Result): Promise<void> {
    const { inputTokens, outputTokens, usageKnown } = result.model;
    // 0.72 micro-USD/token at the recorded Ohio tariff, rounded upward only for the ledger estimate.
    const estimatedMicroUsd = usageKnown ? Math.ceil((inputTokens + outputTokens) * 0.72) : 0;
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.tableName, Key: request(value.requestKey), UpdateExpression: 'SET #state = :complete, #result = :result, completedAt = :at', ConditionExpression: '#state = :running AND fingerprint = :fingerprint', ExpressionAttributeNames: { '#state': 'state', '#result': 'result' }, ExpressionAttributeValues: { ':complete': 'complete', ':running': 'running', ':result': result, ':at': new Date().toISOString(), ':fingerprint': value.fingerprint } } },
      { Update: { TableName: this.tableName, Key: project, UpdateExpression: 'ADD inputTokens :input, outputTokens :output, estimatedMicroUsd :cost, knownUsageRequests :known', ExpressionAttributeValues: { ':input': inputTokens, ':output': outputTokens, ':cost': estimatedMicroUsd, ':known': usageKnown ? 1 : 0 } } },
    ] }));
  }
}
