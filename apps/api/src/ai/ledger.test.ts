import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoUsageLedger, type Reservation } from './ledger.js';
import { interpretTeacherLog } from './interpret.js';
import { emptyResult, PROJECT_LIMIT_MICRO_USD, type InterpretationInput } from './types.js';

const schoolId = 'judge-school-fixture';
const policyKey = `SCHOOL#${schoolId}|DEMO_AI_POLICY`;
const projectKey = 'AI_BUDGET#2026-10-27_2026-11-09|PROJECT';
const policy = { kind: 'judge-demo-ai-policy', enabled: true, noteDailyLimit: 20, draftDailyLimit: 20 };
const now = new Date('2026-10-30T08:00:00.000Z');
const reservation = (requestKey: string, overrides: Partial<Reservation> = {}): Reservation => ({ requestKey, fingerprint: requestKey, actorId: 'teacher-fixture', schoolId, operation: 'note', now, ...overrides });
const key = (value: { PK: string; SK: string }) => `${value.PK}|${value.SK}`;
const schoolCounter = (operation: string, day = '2026-10-30', school = schoolId) => `AI_DEMO_SCHOOL#${school}|DAY#${day}#${operation}`;
const actorCounter = (actorId = 'teacher-fixture', day = '2026-10-30') => `AI_ACTOR#${createHash('sha256').update(actorId).digest('hex')}|DAY#${day}`;

/** All transaction conditions are checked before any mutation, as DynamoDB does. */
function fixture(withPolicy = true) {
  const records = new Map<string, any>([[projectKey, { reservedMicroUsd: 520_000, requests: 26 }]]);
  if (withPolicy) records.set(policyKey, { ...policy });
  const reads: string[] = []; const transactions: any[][] = [];
  let beforeTransaction: (() => void) | undefined;
  let loseResponse = false;
  const send = async (command: { input: any }) => {
    const value = command.input;
    if (value.Key) {
      assert.equal(value.ConsistentRead, true);
      reads.push(key(value.Key));
      return { Item: structuredClone(records.get(key(value.Key))) };
    }
    const items = value.TransactItems;
    transactions.push(items);
    beforeTransaction?.(); beforeTransaction = undefined;
    const reasons = items.map((item: any) => {
      const operation = item.Update || item.Put || item.ConditionCheck;
      const prior = records.get(key(operation.Key || operation.Item));
      const values = operation.ExpressionAttributeValues || {};
      if (item.Put) return prior ? 'ConditionalCheckFailed' : 'None';
      if (item.ConditionCheck) return prior?.kind === values[':kind'] && prior?.enabled === values[':enabled'] && prior?.noteDailyLimit === values[':limit'] && prior?.draftDailyLimit === values[':limit'] ? 'None' : 'ConditionalCheckFailed';
      if (values[':remaining'] !== undefined && (prior?.reservedMicroUsd || 0) > values[':remaining']) return 'ConditionalCheckFailed';
      if (values[':limit'] !== undefined && (prior?.requests || 0) >= values[':limit']) return 'ConditionalCheckFailed';
      if (values[':fingerprint'] !== undefined && (prior?.state !== 'running' || prior?.fingerprint !== values[':fingerprint'])) return 'ConditionalCheckFailed';
      return 'None';
    });
    if (reasons.some((reason: string) => reason !== 'None')) throw Object.assign(new Error('Transaction cancelled'), { CancellationReasons: reasons.map((Code: string) => ({ Code })) });
    for (const item of items) {
      if (item.ConditionCheck) continue;
      if (item.Put) { records.set(key(item.Put.Item), { ...item.Put.Item }); continue; }
      const update = item.Update; const values = update.ExpressionAttributeValues;
      const prior = { ...(records.get(key(update.Key)) || {}) };
      for (const [field, token] of [['requests', ':one'], ['reservedMicroUsd', ':reserve'], ['inputTokens', ':input'], ['outputTokens', ':output'], ['estimatedMicroUsd', ':cost'], ['knownUsageRequests', ':known']]) {
        if (values[token] !== undefined) prior[field] = (prior[field] || 0) + values[token];
      }
      if (values[':complete']) Object.assign(prior, { state: values[':complete'], result: values[':result'] });
      records.set(key(update.Key), prior);
    }
    if (loseResponse) { loseResponse = false; throw new Error('Response lost after commit'); }
    return {};
  };
  const db = { send } as unknown as DynamoDBDocumentClient;
  return { records, reads, transactions, ledger: new DynamoUsageLedger('sls-hackathon-2026-data', db), beforeTransaction: (hook: () => void) => { beforeTransaction = hook; }, loseNextResponse: () => { loseResponse = true; } };
}

test('ordinary schools keep their existing reservation, actor cap and budget key', async () => {
  const f = fixture(false);
  assert.deepEqual(await f.ledger.claim(reservation('ordinary')), { claimed: true });
  assert.equal(f.transactions[0].length, 3);
  assert.equal(f.records.get(projectKey).reservedMicroUsd, 540_000);
  assert.equal(f.records.get(actorCounter()).requests, 1);
  assert(![...f.records.keys()].some(value => value.startsWith('AI_DEMO_SCHOOL#')));
  assert.equal([...f.records.keys()].filter(value => value.startsWith('AI_BUDGET#')).length, 1);
  assert(f.reads.includes(policyKey));
});

test('20 notes across shared-school actors are allowed; the next atomically changes nothing', async () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) assert.deepEqual(await f.ledger.claim(reservation(`note-${index}`, { actorId: `teacher-${index}` })), { claimed: true });
  const before = JSON.stringify([...f.records]);
  const blocked = await f.ledger.claim(reservation('note-over-cap', { actorId: 'new-teacher' }));
  assert.equal(blocked.claimed, false);
  if (!blocked.claimed) assert.equal(blocked.result.unresolved[0].code, 'DEMO_SCHOOL_AI_LIMIT');
  assert.equal(JSON.stringify([...f.records]), before);
  assert.equal(f.records.get(schoolCounter('note')).requests, 20);
  assert.deepEqual(await f.ledger.claim(reservation('independent-draft', { operation: 'draft' })), { claimed: true });
  assert.equal(f.records.get(schoolCounter('draft')).requests, 1);
  assert.equal(f.transactions[0].length, 5);
});

test('draft school cap and the unchanged combined actor/project caps all apply', async () => {
  for (const cap of ['draft', 'actor', 'project']) {
    const f = fixture();
    if (cap === 'draft') f.records.set(schoolCounter('draft'), { requests: 20 });
    if (cap === 'actor') f.records.set(actorCounter(), { requests: 25 });
    if (cap === 'project') f.records.set(projectKey, { requests: 900, reservedMicroUsd: PROJECT_LIMIT_MICRO_USD });
    const before = JSON.stringify([...f.records]);
    const blocked = await f.ledger.claim(reservation(`blocked-${cap}`, { operation: 'draft' }));
    assert.equal(blocked.claimed, false);
    if (!blocked.claimed) assert.equal(blocked.result.unresolved[0].code, { draft: 'DEMO_SCHOOL_AI_LIMIT', actor: 'TEACHER_AI_LIMIT', project: 'PROJECT_AI_LIMIT' }[cap]);
    assert.equal(JSON.stringify([...f.records]), before);
  }
});

test('concurrent final-slot requests cannot exceed the school limit', async () => {
  const f = fixture(); f.records.set(schoolCounter('note'), { requests: 19 });
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => f.ledger.claim(reservation(`last-slot-${index}`, { actorId: `actor-${index}` }))));
  assert.equal(results.filter(result => result.claimed).length, 1);
  assert.equal(f.records.get(schoolCounter('note')).requests, 20);
  assert.equal(f.records.get(projectKey).requests, 27);
  assert.equal([...f.records.keys()].filter(value => value.startsWith('AI_REQUEST#')).length, 1);
});

test('concurrent duplicates and a lost commit response reserve only once', async () => {
  const f = fixture(); f.loseNextResponse();
  const value = reservation('same-request');
  const results = await Promise.all(Array.from({ length: 6 }, () => f.ledger.claim(value)));
  assert(results.every(result => !result.claimed));
  assert.equal(f.records.get(schoolCounter('note')).requests, 1);
  assert.equal(f.records.get(projectKey).requests, 27);
  const result = emptyResult(value.requestKey, 'failed', 'MODEL_UNAVAILABLE', 'Preserved uncertain attempt.', true);
  await f.ledger.complete(value, result);
  f.records.set(policyKey, { ...policy, enabled: false });
  assert.deepEqual(await f.ledger.claim(value), { claimed: false, result });
  assert.equal(f.records.get(schoolCounter('note')).requests, 1, 'Completion and readback never refund or reserve again.');
  const changedScope = await f.ledger.claim({ ...value, operation: 'draft' });
  assert.equal(changedScope.claimed, false);
  if (!changedScope.claimed) assert.equal(changedScope.result.unresolved[0].code, 'REQUEST_CHANGED');
});

test('present malformed or disabled policy fails closed before any reservation', async () => {
  for (const malformed of [{}, { ...policy, kind: 'other' }, { ...policy, enabled: false }, { ...policy, noteDailyLimit: 21 }, { ...policy, draftDailyLimit: 19 }, { ...policy, noteDailyLimit: '20' }]) {
    const f = fixture(); f.records.set(policyKey, malformed);
    const before = JSON.stringify([...f.records]);
    const result = await f.ledger.claim(reservation('malformed-policy'));
    assert.equal(result.claimed, false);
    if (!result.claimed) assert.equal(result.result.unresolved[0].code, 'DEMO_AI_POLICY_INVALID');
    assert.equal(f.transactions.length, 0); assert.equal(JSON.stringify([...f.records]), before);
  }
});

test('policy deletion or modification between read and transaction changes no quota or attempt', async () => {
  for (const remove of [false, true]) {
    const f = fixture();
    f.beforeTransaction(() => { if (remove) f.records.delete(policyKey); else f.records.set(policyKey, { ...policy, noteDailyLimit: 1 }); });
    const result = await f.ledger.claim(reservation('policy-race'));
    assert.equal(result.claimed, false);
    if (!result.claimed) assert.equal(result.result.unresolved[0].code, 'DEMO_AI_POLICY_CHANGED');
    assert.equal(f.records.get(projectKey).requests, 26);
    assert(!f.records.has(schoolCounter('note'))); assert(!f.records.has(actorCounter()));
    assert(!f.records.has('AI_REQUEST#policy-race|META'));
  }
});

test('school counters are isolated and roll over at India midnight', async () => {
  const f = fixture(); f.records.set(schoolCounter('note'), { requests: 20 });
  const beforeMidnight = await f.ledger.claim(reservation('before-midnight', { now: new Date('2026-10-30T18:29:59.999Z') }));
  assert.equal(beforeMidnight.claimed, false);
  assert.deepEqual(await f.ledger.claim(reservation('after-midnight', { now: new Date('2026-10-30T18:30:00.000Z') })), { claimed: true });
  assert.equal(f.records.get(schoolCounter('note', '2026-10-31')).requests, 1);
  assert.equal(f.records.get(schoolCounter('note')).requests, 20);
  const other = 'other-school-fixture'; f.records.set(`SCHOOL#${other}|DEMO_AI_POLICY`, { ...policy });
  assert.deepEqual(await f.ledger.claim(reservation('other-school', { schoolId: other })), { claimed: true });
  assert.equal(f.records.get(schoolCounter('note', '2026-10-30', other)).requests, 1);
});

test('missing or forged internal scope is rejected before reading or writing', async () => {
  for (const scope of [{ schoolId: '' }, { schoolId: 123 }, { schoolId: 'school#forged' }, { operation: 'other' }, { operation: undefined }]) {
    const f = fixture();
    const result = await f.ledger.claim({ ...reservation('scope'), ...scope } as Reservation);
    assert.equal(result.claimed, false);
    if (!result.claimed) assert.equal(result.result.unresolved[0].code, 'AI_SCOPE_REQUIRED');
    assert.equal(f.reads.length, 0); assert.equal(f.transactions.length, 0);
  }
});

test('teacher interpretation uses canonical school note scope and stops before inference at its cap', async () => {
  const f = fixture(); f.records.set(schoolCounter('note'), { requests: 20 }); let calls = 0;
  const input: InterpretationInput = { schoolId, classId: 'class-fixture', logId: 'log-fixture', actorId: 'teacher-fixture', version: 1, attempt: 1, subject: 'EVS', note: 'Finished Our Earth.', localDate: '2026-10-30', timeZone: 'Asia/Kolkata', roster: [], catalog: [{ id: 'earth', title: 'Our Earth', subject: 'EVS', modes: ['learn', 'practice', 'revise'] }] };
  const result = await interpretTeacherLog(input, { enabled: true, now, ledger: f.ledger, invoke: async () => { calls++; throw new Error('Must not invoke'); } });
  assert.equal(result.unresolved[0].code, 'DEMO_SCHOOL_AI_LIMIT'); assert.equal(calls, 0);
  assert.equal(f.records.get(projectKey).requests, 26);
});
