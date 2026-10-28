import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { pairTestGuidance } from './test-plans.js';
import { handleRecommendations } from './index.js';
import { SchoolError, type VerifiedAccount } from '../school/index.js';

type Row = Record<string, any>;
type Candidate = Parameters<typeof pairTestGuidance>[0][number];
const directory = fileURLToPath(new URL('../../../../content/releases/m2/', import.meta.url));
const catalog = JSON.parse(readFileSync(resolve(directory, 'catalog.json'), 'utf8')).chapters;
const chapter = catalog[0];
const cards = JSON.parse(readFileSync(resolve(directory, `revise/${chapter.id}/en.json`), 'utf8')).cards.map((card: Row) => card.id) as string[];
const schoolId = '11111111-1111-4111-8111-111111111111';
const classId = '22222222-2222-4222-8222-222222222222';
const childId = '33333333-3333-4333-8333-333333333333';
const logId = '44444444-4444-4444-8444-444444444444';
const owner: VerifiedAccount = { id: 'student-account', email: 'student@example.test', emailVerified: true };
const parent: VerifiedAccount = { id: 'parent-account', email: 'parent@example.test', emailVerified: true };
const stranger: VerifiedAccount = { id: 'stranger-account', email: 'stranger@example.test', emailVerified: true };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (row: Row) => JSON.stringify([row.PK, row.SK]);
const candidate = (mode: 'revise' | 'practice', changes: Partial<Candidate> = {}): Candidate => ({ id: hash(mode), schoolId, classId, logId, version: 1, chapterId: chapter.id, mode, kind: 'test', date: '2026-10-30', audience: { type: 'class' }, ...changes });
const request = (method: string, path: string, body?: unknown) => ({ rawPath: `/api/school/recommendations/${path}`, requestContext: { http: { method } }, body: body === undefined ? undefined : JSON.stringify(body) }) as APIGatewayProxyEventV2WithJWTAuthorizer;
const rejects = (code: string) => (error: unknown) => error instanceof SchoolError && error.code === code;

function setup(t: TestContext) {
  const environment = { NODE_ENV: 'test', CONTENT_RELEASE: 'm2', LOCAL_CONTENT_DIR: directory, TABLE_NAME: 'test-only-test-plans' };
  const oldEnvironment = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]])); Object.assign(process.env, environment);
  t.after(() => { for (const [name, value] of Object.entries(oldEnvironment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-28T19:00:00Z') });
  const rows = new Map<string, Row>();
  const put = (row: Row) => { rows.set(key(row), row); return row; };
  put({ PK: `SCHOOL#${schoolId}`, SK: 'META', id: schoolId, name: 'Fixture School', timeZone: 'Asia/Kolkata' });
  put({ PK: `SCHOOL#${schoolId}`, SK: `CLASS#${classId}`, id: classId, name: 'Class 4' });
  const child = put({ PK: `CLASS#${schoolId}#${classId}`, SK: `STUDENT#${childId}`, id: childId, name: 'Fixture Learner', active: true, studentEmail: owner.email, parentEmails: [parent.email] });
  for (const [account, role] of [[owner, 'STUDENT'], [parent, 'PARENT']] as const) put({ PK: `SCHOOL_EMAIL#${hash(account.email)}`, SK: `${role}#${childId}`, schoolId, classId, studentId: childId });
  const log = put({ PK: `COMM#${schoolId}#${classId}`, SK: `LOG#${logId}`, id: logId, schoolId, classId, version: 1, note: 'Private classroom note.' });
  const snapshot = put({ PK: `GUIDANCE#${schoolId}#${classId}`, SK: `LOG#${logId}#V#000001`, recommendationIds: [hash('revise'), hash('practice')] });
  for (const mode of ['revise', 'practice'] as const) put({ ...candidate(mode), PK: `RECOMMENDATION#${hash(mode)}`, SK: 'META', title: 'Untrusted display wording', reason: 'Your teacher recorded a test.', sourceText: 'Private evidence.' });
  const hooks: { beforeTransaction?: () => void } = {};
  let writes = 0;
  function condition(operation: Row) {
    if (!operation.ConditionExpression) return true;
    const row = rows.get(key(operation.Item || operation.Key)); const names = operation.ExpressionAttributeNames || {}; const values = operation.ExpressionAttributeValues || {};
    return operation.ConditionExpression.split(' AND ').every((clause: string) => {
      const missing = clause.match(/^attribute_not_exists\(([^)]+)\)$/);
      if (missing) return row?.[missing[1]] === undefined;
      const equality = clause.match(/^([#\w]+) = (:\w+)$/); assert.ok(equality, `Unsupported condition: ${clause}`);
      return isDeepStrictEqual(row?.[names[equality[1]] || equality[1]], values[equality[2]]);
    });
  }
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: structuredClone(rows.get(key(command.input.Key!))) };
    if (command instanceof QueryCommand) { const values = command.input.ExpressionAttributeValues!; return { Items: structuredClone([...rows.values()].filter(row => row.PK === values[':pk'] && row.SK.startsWith(values[':prefix']))) }; }
    assert.ok(command instanceof TransactWriteCommand, 'Only guarded start transactions may write.');
    hooks.beforeTransaction?.();
    const items = command.input.TransactItems as Row[];
    if (!items.every(item => condition(item.Put || item.ConditionCheck))) throw Object.assign(new Error('Guard changed'), { name: 'TransactionCanceledException' });
    for (const item of items) if (item.Put) { writes++; put(structuredClone(item.Put.Item)); }
    return {};
  });
  t.mock.method(S3Client.prototype, 'send', async () => { assert.fail('Test plans use the local frozen catalog and revision deck.'); });
  t.mock.method(BedrockRuntimeClient.prototype, 'send', async () => { assert.fail('Test plans must not invoke a model.'); });
  t.mock.method(CognitoIdentityProviderClient.prototype, 'send', async (command: { input: { AccessToken: string } }) => {
    const account = command.input.AccessToken === 'parent-token' ? parent : owner;
    return { UserAttributes: [{ Name: 'sub', Value: account.id }, { Name: 'email', Value: account.email }, { Name: 'email_verified', Value: command.input.AccessToken === 'unverified-token' ? 'false' : 'true' }] };
  });
  const mine = async (account = owner) => await handleRecommendations(request('GET', 'mine'), account) as Row;
  const start = async (planId: string, step: string, recommendationId?: string, account = owner) => await handleRecommendations(request('POST', `test-plans/${planId}/start`, { step, ...(recommendationId ? { recommendationId } : {}) }), account) as Row;
  const activityKey = (mode: 'revise' | 'practice') => ({ PK: `RECOMMENDATION#${hash(mode)}`, SK: `ACTIVITY#${childId}#${owner.id}` });
  const activity = (mode: 'revise' | 'practice') => rows.get(key(activityKey(mode)));
  return { rows, put, child, log, snapshot, hooks, mine, start, activity, activityKey, writes: () => writes };
}

test('test pairs require the exact source, chapter, date and audience; labels come only from the catalog', () => {
  const revise = candidate('revise'); const practice = candidate('practice');
  const plans = pairTestGuidance([revise, practice], catalog, '2026-10-29');
  assert.equal(plans.length, 1); assert.equal(plans[0].plan.chapterTitle, chapter.title); assert.equal(plans[0].plan.subject, chapter.subject); assert.match(plans[0].plan.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(plans[0].plan).sort(), ['id', 'chapterId', 'chapterTitle', 'subject', 'date', 'reviseId', 'practiceId'].sort());
  for (const patch of [{ schoolId: 'other' }, { classId: 'other' }, { logId: 'other' }, { version: 2 }, { chapterId: catalog[1].id }, { date: '2026-10-31' }, { audience: { type: 'student' as const, studentId: childId } }, { kind: 'assignment' as const }]) assert.equal(pairTestGuidance([revise, { ...practice, ...patch }], catalog, '2026-10-29').length, 0);
  for (const date of [null, '2026-10-28', '2026-02-30']) assert.equal(pairTestGuidance([candidate('revise', { date }), candidate('practice', { date })], catalog, '2026-10-29').length, 0);
  assert.equal(pairTestGuidance([revise], catalog, '2026-10-29').length, 0);
  assert.equal(pairTestGuidance([revise, revise, practice], catalog, '2026-10-29').length, 1, 'Duplicate references to one ID are not ambiguous.');
  assert.equal(pairTestGuidance([revise, { ...revise, id: hash('second-revise') }, practice], catalog, '2026-10-29').length, 0);
});

test('family plans use canonical labels, retain ordinary cards and are read-only for parents', async t => {
  const data = setup(t); const student = await data.mine(); const parentView = await data.mine(parent);
  const group = student.student[0]; assert.equal(group.recommendations.length, 2); assert.equal(group.testPlans.length, 1); assert.equal(group.testPlans[0].chapterTitle, chapter.title);
  assert.deepEqual(parentView.parent[0].testPlans, group.testPlans);
  const planBody = JSON.stringify(group.testPlans);
  for (const privateValue of [schoolId, classId, logId, childId, 'Private evidence.', 'Private classroom note.', owner.email, 'Untrusted display wording']) assert.equal(planBody.includes(privateValue), false);
  await assert.rejects(data.start(group.testPlans[0].id, 'revise', undefined, parent), rejects('STUDENT_LINK_REQUIRED'));
  await assert.rejects(data.start(group.testPlans[0].id, 'revise', undefined, stranger), rejects('STUDENT_LINK_REQUIRED'));
  assert.equal(data.writes(), 0);
});

test('Practice starts only from the exact saved revision origin, with all canonical cards completed', async t => {
  const data = setup(t); const plan = (await data.mine()).student[0].testPlans[0];
  const opened = await data.start(plan.id, 'revise'); assert.equal(opened.recommendation.id, plan.reviseId); assert.equal(opened.recommendation.mode, 'revise');
  const first = structuredClone(data.activity('revise')); await data.start(plan.id, 'revise'); assert.deepEqual(data.activity('revise'), first); assert.equal(data.writes(), 1);
  await assert.rejects(data.start(plan.id, 'practice', hash('other-revision')), rejects('ORIGIN_MISMATCH'));
  await assert.rejects(data.start(plan.id, 'practice'), rejects('ORIGIN_MISMATCH'));
  data.put({ PK: `USER#${owner.id}`, SK: `PROGRESS#revise#${chapter.id}`, completedCards: new Set(cards) });
  await assert.rejects(data.start(plan.id, 'practice', plan.reviseId), rejects('REVISION_INCOMPLETE'));
  data.activity('revise')!.completedCards = new Set(cards.slice(0, -1));
  await assert.rejects(data.start(plan.id, 'practice', plan.reviseId), rejects('REVISION_INCOMPLETE'));
  data.activity('revise')!.completedCards = new Set(cards.map((_, index) => `unrelated-card-${index}`));
  await assert.rejects(data.start(plan.id, 'practice', plan.reviseId), rejects('REVISION_INCOMPLETE'));
  data.activity('revise')!.completedCards = new Set(cards); data.activity('revise')!.studentEmailHash = hash('old@example.test');
  await assert.rejects(data.start(plan.id, 'practice', plan.reviseId), rejects('REVISION_INCOMPLETE'));
  data.activity('revise')!.studentEmailHash = hash(owner.email);
  const practice = await data.start(plan.id, 'practice', plan.reviseId); assert.equal(practice.recommendation.id, plan.practiceId); assert.equal(practice.recommendation.mode, 'practice');
  const saved = structuredClone(data.activity('practice')); await data.start(plan.id, 'practice', plan.reviseId); assert.deepEqual(data.activity('practice'), saved); assert.equal(data.writes(), 2);
  assert.equal([...data.rows.values()].some(row => row.kind === 'practice-session'), false);
  assert.deepEqual(Object.keys(practice), ['recommendation']);
});

test('correction, expiry, revoked and ambiguous links invalidate previously shown plans', async t => {
  for (const change of ['revision', 'expiry', 'revoked', 'ambiguous']) await t.test(change, async childTest => {
    const data = setup(childTest); const plan = (await data.mine()).student[0].testPlans[0];
    if (change === 'revision') data.log.version = 2;
    if (change === 'expiry') childTest.mock.timers.setTime(Date.parse('2026-10-30T18:30:00Z'));
    if (change === 'revoked') data.child.active = false;
    if (change === 'ambiguous') {
      const otherId = '55555555-5555-4555-8555-555555555555'; data.put({ ...data.child, id: otherId, SK: `STUDENT#${otherId}` });
      data.put({ PK: `SCHOOL_EMAIL#${hash(owner.email)}`, SK: `STUDENT#${otherId}`, schoolId, classId, studentId: otherId });
    }
    await assert.rejects(data.start(plan.id, 'revise'), rejects(['revoked', 'ambiguous'].includes(change) ? 'STUDENT_LINK_REQUIRED' : 'TEST_PLAN_CHANGED'));
    assert.equal(data.writes(), 0);
  });
});

test('guards reject correction, retry, roster changes and progress resets between validation and start', async t => {
  for (const change of ['revision', 'snapshot', 'roster', 'completion']) await t.test(change, async childTest => {
    const data = setup(childTest); const plan = (await data.mine()).student[0].testPlans[0]; await data.start(plan.id, 'revise'); data.activity('revise')!.completedCards = new Set(cards);
    data.hooks.beforeTransaction = () => {
      data.hooks.beforeTransaction = undefined;
      if (change === 'revision') data.log.version = 2;
      if (change === 'snapshot') data.snapshot.recommendationIds = [plan.reviseId];
      if (change === 'roster') data.child.active = false;
      if (change === 'completion') delete data.activity('revise')!.completedCards;
    };
    await assert.rejects(data.start(plan.id, 'practice', plan.reviseId), rejects('GUIDANCE_CHANGED'));
    assert.equal(data.activity('practice'), undefined); assert.equal(data.writes(), 1);
  });
});

test('guards also protect an idempotent Practice start after the activity already exists', async t => {
  const data = setup(t); const plan = (await data.mine()).student[0].testPlans[0]; await data.start(plan.id, 'revise'); data.activity('revise')!.completedCards = new Set(cards); await data.start(plan.id, 'practice', plan.reviseId);
  const previous = structuredClone(data.activity('practice'));
  data.hooks.beforeTransaction = () => { data.hooks.beforeTransaction = undefined; delete data.activity('revise')!.completedCards; };
  await assert.rejects(data.start(plan.id, 'practice', plan.reviseId), rejects('GUIDANCE_CHANGED'));
  assert.deepEqual(data.activity('practice'), previous); assert.equal(data.writes(), 2);
});

test('concurrent duplicate plan starts preserve one origin activity for each step', async t => {
  const data = setup(t); const plan = (await data.mine()).student[0].testPlans[0];
  const revision = await Promise.all([data.start(plan.id, 'revise'), data.start(plan.id, 'revise')]);
  assert.deepEqual(revision[0], revision[1]); assert.equal(data.writes(), 1);
  data.activity('revise')!.completedCards = new Set(cards);
  const practice = await Promise.all([data.start(plan.id, 'practice', plan.reviseId), data.start(plan.id, 'practice', plan.reviseId)]);
  assert.deepEqual(practice[0], practice[1]); assert.equal(data.writes(), 2);
});

test('the real authenticated handler rejects forged identity and client completion claims', async t => {
  const data = setup(t); const plan = (await data.mine()).student[0].testPlans[0]; const { handler } = await import('../index.js');
  async function call(body: unknown, token = 'owner-token', subject = owner.id) {
    const event = request('POST', `test-plans/${plan.id}/start`, body); event.headers = token ? { authorization: `Bearer ${token}` } : {};
    event.requestContext.authorizer = { jwt: { claims: { sub: subject, token_use: 'access' }, scopes: [] } };
    const result = await handler(event); assert.ok(typeof result !== 'string'); return { status: result.statusCode, body: JSON.parse(result.body!) };
  }
  assert.equal((await call({ step: 'revise' }, '')).status, 401);
  assert.equal((await call({ step: 'revise' }, 'owner-token', parent.id)).status, 401);
  assert.equal((await call({ step: 'revise' }, 'unverified-token')).status, 403);
  assert.equal((await call({ step: 'revise' }, 'parent-token', parent.id)).status, 403);
  assert.equal((await call({ step: 'revise' })).status, 200);
  const forged = await call({ step: 'practice', recommendationId: plan.reviseId, completed: 25 }); assert.equal(forged.status, 400);
  const unsaved = await call({ step: 'practice', recommendationId: plan.reviseId }); assert.equal(unsaved.status, 409); assert.equal(unsaved.body.error, 'REVISION_INCOMPLETE');
  assert.equal(data.writes(), 1);
});
