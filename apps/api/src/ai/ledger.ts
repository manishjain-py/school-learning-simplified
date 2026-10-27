import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ACTOR_DAILY_LIMIT, PROJECT_LIMIT_MICRO_USD, RESERVE_MICRO_USD, emptyResult, type InterpretationResult } from './types.js';
import { schoolLocalDate } from './dates.js';

export type Reservation = { requestKey: string; fingerprint: string; actorId: string; now: Date };
export type Claim = { claimed: true } | { claimed: false; result: InterpretationResult };
export interface UsageLedger {
  claim(value: Reservation): Promise<Claim>;
  complete(value: Reservation, result: InterpretationResult): Promise<void>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const project = { PK: 'AI_BUDGET#2026-10-27_2026-11-09', SK: 'PROJECT' };
const request = (key: string) => ({ PK: `AI_REQUEST#${key}`, SK: 'META' });
type RequestRecord = { fingerprint: string; state: 'running' | 'complete'; startedAt: string; result?: InterpretationResult };

/** Reservations are never refunded: ambiguous network/timeout outcomes remain charged to the cap. */
export class DynamoUsageLedger implements UsageLedger {
  constructor(private tableName: string, private db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-2' }))) {
    if (tableName !== 'sls-hackathon-2026-data') throw new Error('AI ledger requires this project’s independent table.');
  }
  private async existing(value: Reservation): Promise<InterpretationResult | null> {
    const response = await this.db.send(new GetCommand({ TableName: this.tableName, Key: request(value.requestKey), ConsistentRead: true }));
    const item = response.Item as RequestRecord | undefined;
    if (!item) return null;
    if (item.fingerprint !== value.fingerprint) return emptyResult(value.requestKey, 'failed', 'REQUEST_CHANGED', 'This log attempt has different inputs. Correct the log to create a new version.');
    if (item.state === 'complete' && item.result) return item.result;
    if (value.now.getTime() - Date.parse(item.startedAt) > 60_000) return emptyResult(value.requestKey, 'failed', 'ATTEMPT_INTERRUPTED', 'This attempt was interrupted. Retry with a new attempt; its original usage reservation remains.', true);
    return emptyResult(value.requestKey, 'processing', 'IN_PROGRESS', 'This log is already being interpreted. Refresh shortly.');
  }
  async claim(value: Reservation): Promise<Claim> {
    const prior = await this.existing(value);
    if (prior) return { claimed: false, result: prior };
    const day = schoolLocalDate(value.now, 'Asia/Kolkata');
    const actor = { PK: `AI_ACTOR#${digest(value.actorId)}`, SK: `DAY#${day}` };
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: this.tableName, Key: project, UpdateExpression: 'ADD reservedMicroUsd :reserve, requests :one', ConditionExpression: 'attribute_not_exists(reservedMicroUsd) OR reservedMicroUsd <= :remaining', ExpressionAttributeValues: { ':reserve': RESERVE_MICRO_USD, ':one': 1, ':remaining': PROJECT_LIMIT_MICRO_USD - RESERVE_MICRO_USD } } },
        { Update: { TableName: this.tableName, Key: actor, UpdateExpression: 'ADD requests :one', ConditionExpression: 'attribute_not_exists(requests) OR requests < :limit', ExpressionAttributeValues: { ':one': 1, ':limit': ACTOR_DAILY_LIMIT } } },
        { Put: { TableName: this.tableName, Item: { ...request(value.requestKey), fingerprint: value.fingerprint, state: 'running', startedAt: value.now.toISOString(), reservedMicroUsd: RESERVE_MICRO_USD }, ConditionExpression: 'attribute_not_exists(PK)' } },
      ] }));
      return { claimed: true };
    } catch (issue) {
      // A lost response or concurrent duplicate may have committed: reread before classifying it.
      const existing = await this.existing(value);
      if (existing) return { claimed: false, result: existing };
      const reasons = (issue as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed') return { claimed: false, result: emptyResult(value.requestKey, 'failed', 'PROJECT_AI_LIMIT', 'The project’s current AI allowance is exhausted. Guidance was not generated.') };
      if (reasons?.[1]?.Code === 'ConditionalCheckFailed') return { claimed: false, result: emptyResult(value.requestKey, 'failed', 'TEACHER_AI_LIMIT', 'This account has reached today’s AI limit. Retry tomorrow.', true) };
      throw issue;
    }
  }
  async complete(value: Reservation, result: InterpretationResult): Promise<void> {
    const { inputTokens, outputTokens, usageKnown } = result.model;
    // 0.72 micro-USD/token at the recorded Ohio tariff, rounded upward only for the ledger estimate.
    const estimatedMicroUsd = usageKnown ? Math.ceil((inputTokens + outputTokens) * 0.72) : 0;
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.tableName, Key: request(value.requestKey), UpdateExpression: 'SET #state = :complete, #result = :result, completedAt = :at', ConditionExpression: '#state = :running AND fingerprint = :fingerprint', ExpressionAttributeNames: { '#state': 'state', '#result': 'result' }, ExpressionAttributeValues: { ':complete': 'complete', ':running': 'running', ':result': result, ':at': new Date().toISOString(), ':fingerprint': value.fingerprint } } },
      { Update: { TableName: this.tableName, Key: project, UpdateExpression: 'ADD inputTokens :input, outputTokens :output, estimatedMicroUsd :cost, knownUsageRequests :known', ExpressionAttributeValues: { ':input': inputTokens, ':output': outputTokens, ':cost': estimatedMicroUsd, ':known': usageKnown ? 1 : 0 } } },
    ] }));
  }
}
