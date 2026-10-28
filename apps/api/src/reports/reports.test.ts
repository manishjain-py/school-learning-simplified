import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { test, type TestContext } from 'node:test';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { buildReport, handleReports } from './index.js';
import { reportOriginRow } from './origins.js';
import { syncVerifiedProfile } from './identity.js';
import { handleSchool, SchoolError, type VerifiedAccount } from '../school/index.js';
import { originProgress, startOrigin } from '../recommendations/index.js';

type Row = Record<string, any>;
const directory = fileURLToPath(new URL('../../../../content/releases/m2/', import.meta.url));
const content = (path: string) => JSON.parse(readFileSync(resolve(directory, path), 'utf8'));
const chapters = content('catalog.json').chapters; const chapter = chapters[0];
const learn = content(`lessons/${chapter.id}/en.json`).cards.map((card: Row) => card.id) as string[];
const revise = content(`revise/${chapter.id}/en.json`).cards.map((card: Row) => card.id) as string[];
const questions = content(`practice/${chapter.id}/en.json`).questions.map((question: Row) => question.id) as string[];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const schoolId = id(1); const classId = id(2); const childId = id(3); const logId = id(4);
const owner: VerifiedAccount = { id: id(10), email: 'learner@example.test', emailVerified: true };
const parent: VerifiedAccount = { id: id(11), email: 'parent@example.test', emailVerified: true };
const other: VerifiedAccount = { id: id(12), email: 'other@example.test', emailVerified: true };
const admin: VerifiedAccount = { id: id(13), email: 'admin@example.test', emailVerified: true };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const rowKey = (row: Row) => JSON.stringify([row.PK, row.SK]);
const reportPath = `/api/school/family/parent/${schoolId}/${classId}/${childId}/report`;
const event = (rawPath: string, method = 'GET', body?: unknown) => ({ rawPath, requestContext: { http: { method } }, body: body === undefined ? undefined : JSON.stringify(body) }) as APIGatewayProxyEventV2WithJWTAuthorizer;
const rejected = (code: string) => (error: unknown) => error instanceof SchoolError && error.code === code;

function fixture(t: TestContext, linked = true) {
  const environment = { NODE_ENV: 'test', CONTENT_RELEASE: 'm2', LOCAL_CONTENT_DIR: directory, TABLE_NAME: 'test-only-reports' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const rows = new Map<string, Row>();
  const put = (row: Row) => { rows.set(rowKey(row), structuredClone(row)); return row; };
  const get = (PK: string, SK: string) => rows.get(rowKey({ PK, SK }));
  const erase = (PK: string, SK: string) => rows.delete(rowKey({ PK, SK }));
  const hooks: { query?: (PK: string, prefix: string) => void; transaction?: (items: Row[]) => void } = {};
  const writes: Row[] = [];
  const identities = new Map([owner, parent, other, admin].map(account => [account.id, { ...account }]));
  for (const account of identities.values()) put({ PK: `USER#${account.id}`, SK: 'PROFILE', email: account.email, emailVerified: true, updatedAt: '2099-01-01T00:00:00Z' });
  put({ PK: `USER#${owner.id}`, SK: 'LEARNER_PREFERENCES', displayName: 'Learner Name', language: 'hi', updatedAt: '2099-02-01T00:00:00Z' });
  put({ PK: `SCHOOL#${schoolId}`, SK: 'META', id: schoolId, name: 'Fixture School', timeZone: 'Asia/Kolkata', adminId: admin.id });
  put({ PK: `SCHOOL#${schoolId}`, SK: `CLASS#${classId}`, id: classId, name: 'Class 4', teacherEmails: [] });
  const child = { PK: `CLASS#${schoolId}#${classId}`, SK: `STUDENT#${childId}`, id: childId, name: 'Roster Name', studentEmail: owner.email, parentEmails: [parent.email], active: true, version: 1 };
  if (linked) {
    put(child);
    for (const [account, role] of [[owner, 'STUDENT'], [parent, 'PARENT']] as const) put({ PK: `SCHOOL_EMAIL#${hash(account.email)}`, SK: `${role}#${schoolId}#${classId}#${childId}`, schoolId, classId, studentId: childId });
  }
  const bindingKey = { PK: child.PK, SK: `LEARNER_ACCOUNT#${childId}` };
  function condition(operation: Row) {
    if (!operation.ConditionExpression) return true;
    const row = rows.get(rowKey(operation.Item || operation.Key)); const names = operation.ExpressionAttributeNames || {}; const values = operation.ExpressionAttributeValues || {};
    return operation.ConditionExpression.split(' AND ').every((clause: string) => {
      const missing = clause.match(/^attribute_not_exists\(([^)]+)\)$/); if (missing) return row?.[missing[1]] === undefined;
      const equality = clause.match(/^([#\w]+) = (:\w+)$/); assert.ok(equality, `Unsupported condition: ${clause}`);
      return isDeepStrictEqual(row?.[names[equality[1]] || equality[1]], values[equality[2]]);
    });
  }
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: structuredClone(rows.get(rowKey(command.input.Key!))) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!; const prefix = values[':prefix'] || '';
      if (!prefix) { assert.equal(command.input.KeyConditionExpression, 'PK = :pk'); assert.equal(Object.hasOwn(values, ':prefix'), false); }
      hooks.query?.(values[':pk'], prefix);
      return { Items: structuredClone([...rows.values()].filter(row => row.PK === values[':pk'] && row.SK.startsWith(prefix))) };
    }
    assert.ok(command instanceof TransactWriteCommand, 'Reports/bindings/indexes must not scan or use unguarded mutations.');
    const items = command.input.TransactItems as Row[]; hooks.transaction?.(items);
    if (!items.every(item => condition(item.Put || item.Delete || item.Update || item.ConditionCheck))) throw Object.assign(new Error('Condition changed'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
    for (const item of items) {
      if (item.Put) { writes.push(item.Put.Item); put(item.Put.Item); }
      if (item.Delete) { writes.push({ ...item.Delete.Key, deleted: true }); rows.delete(rowKey(item.Delete.Key)); }
      if (item.Update) {
        const operation = item.Update; const row = structuredClone(rows.get(rowKey(operation.Key))!);
        const [assignments, addition] = operation.UpdateExpression.replace(/^SET /, '').split(' ADD ');
        for (const assignment of assignments.split(', ')) { const [field, value] = assignment.split(' = '); row[operation.ExpressionAttributeNames?.[field] || field] = operation.ExpressionAttributeValues[value]; }
        if (addition) { const [field, value] = addition.split(' '); row[field] = new Set([...row[field] || [], ...operation.ExpressionAttributeValues[value]]); }
        writes.push(row); put(row);
      }
    }
    return {};
  });
  t.mock.method(S3Client.prototype, 'send', async () => { assert.fail('Report cards need only the local public frozen content.'); });
  t.mock.method(BedrockRuntimeClient.prototype, 'send', async () => { assert.fail('Reports do not invoke models.'); });
  t.mock.method(CognitoIdentityProviderClient.prototype, 'send', async (command: { input: { AccessToken: string } }) => {
    const account = identities.get(command.input.AccessToken)!;
    return { UserAttributes: [{ Name: 'sub', Value: account.id }, { Name: 'email', Value: account.email }, { Name: 'email_verified', Value: String(account.emailVerified) }] };
  });
  const self = async () => await handleReports(event('/api/reports/mine'), owner) as Row;
  const family = async (account = parent) => await handleReports(event(reportPath), account) as Row;
  const binding = () => get(bindingKey.PK, bindingKey.SK);
  async function edit(changes: Row) {
    const current = get(child.PK, child.SK)!;
    const response = await handleSchool(event(`/api/school/schools/${schoolId}/classes/${classId}/roster/${childId}`, 'PUT', { name: current.name, studentEmail: current.studentEmail, parentEmails: current.parentEmails, version: current.version, ...changes }), admin);
    assert.ok(typeof response !== 'string'); assert.equal(response.statusCode, 200); return JSON.parse(response.body!);
  }
  function origin(label: string, mode: string, completedCards: string[], historicalStudentId = childId) {
    const recommendationId = hash(label); const source = { PK: `RECOMMENDATION#${recommendationId}`, SK: `ACTIVITY#${historicalStudentId}#${owner.id}`, recommendationId, accountId: owner.id, studentId: historicalStudentId, studentEmailHash: hash('former-address@example.test'), completedCards: new Set(completedCards), startedAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-21T11:00:00Z' };
    put({ PK: source.PK, SK: 'META', id: recommendationId, chapterId: chapter.id, mode, schoolId: id(90), classId: id(91), logId: id(92), version: 1, date: '2026-10-20' }); put(source);
    const index = reportOriginRow(owner.id, historicalStudentId, { id: recommendationId, chapterId: chapter.id, mode }); put(index); return { source, index };
  }
  return { rows, put, get, erase, hooks, writes, identities, child, binding, bindingKey, self, family, edit, origin };
}

test('all own recorded work deduplicates ordinary/expired/former-school origins; only submitted sets count', async t => {
  const data = fixture(t, false); const PK = `USER#${owner.id}`;
  data.put({ PK, SK: `PROGRESS#${chapter.id}`, completedCards: new Set([learn[0], learn[1], 'unknown']), currentCardId: learn[1], updatedAt: '2026-10-22T12:00:00Z' });
  data.put({ PK, SK: `PROGRESS#revise#${chapter.id}`, completedCards: new Set([revise[0]]), updatedAt: '2026-10-22T13:00:00Z' });
  data.origin('expired', 'learn', [learn[1], learn[2]]); data.origin('superseded-former-child', 'learn', [learn[2], learn[3]], id(88)); data.origin('revision', 'revise', [revise[0], revise[1], 'unknown']);
  const missing = data.origin('reset', 'learn', [learn[4]]); data.erase(missing.source.PK, missing.source.SK);
  const wrong = data.origin('wrong-owner', 'learn', [learn[5]]); data.put({ ...wrong.source, accountId: other.id });
  const mismatch = data.origin('wrong-meta', 'learn', [learn[6]]); data.get(mismatch.source.PK, 'META')!.mode = 'revise';
  for (const [n, status, score] of [[1, 'submitted', 8], [2, 'submitted', 6], [3, 'draft', 10]] as const) data.put({ PK, SK: `PRACTICE_SET#${chapter.id}#SET#${id(n + 40)}`, id: id(n + 40), kind: 'practice-set', schemaVersion: 1, contentRelease: 'm2', chapterId: chapter.id, questionIds: questions.slice(0, 10), status, score, total: 10, submittedLanguage: 'hi', createdAt: `2026-10-2${n}T10:00:00Z`, updatedAt: `2026-10-2${n}T11:00:00Z`, ...(status === 'submitted' ? { submittedAt: `2026-10-2${n}T11:00:00Z` } : {}) });
  const sessionId = id(60); data.put({ PK, SK: `PRACTICE#${chapter.id}#SESSION#${sessionId}`, kind: 'practice-session', chapterId: chapter.id, sessionId, startedAt: '2026-10-25T10:00:00Z' });
  data.put({ PK, SK: `PRACTICE#${chapter.id}#SESSION#${sessionId}#ANSWER#${questions[0]}`, kind: 'practice-answer', chapterId: chapter.id, sessionId, questionId: questions[0], answeredAt: '2026-10-25T11:00:00Z' });
  const before = structuredClone([...data.rows.values()]); const report = (await data.self()).report; const result = report.subjects[0].chapters[0];
  assert.deepEqual(report.summary, { chaptersStudied: 1, ideasExplored: 4, cardsRevised: 2, practiceSetsDone: 2 });
  assert.deepEqual(result.learn, { completed: 4, total: learn.length, percent: Math.round(400 / learn.length) });
  assert.equal(result.revise.total, revise.length); assert.equal(result.practice.latest.score, 6); assert.equal(result.practice.latest.language, 'hi'); assert.equal(result.lastStudiedAt, '2026-10-25T11:00:00.000Z');
  assert.deepEqual(report.learner, { name: 'Learner Name', language: 'hi' }); assert.equal(report.readOnly, false); assert.equal(report.subjects[0].chapters[1].lastStudiedAt, null);
  for (const secret of [owner.id, owner.email, 'former-address@example.test', hash('expired')]) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.deepEqual([...data.rows.values()], before); assert.equal(data.writes.length, 0);
});

test('a current verified learner establishes the binding; parents receive the same counts without writes', async t => {
  const data = fixture(t); assert.deepEqual(await data.family(), { report: null, status: 'learner_not_connected' });
  const own = (await data.self()).report; assert.equal(data.binding()?.accountId, owner.id); assert.equal(data.binding()?.emailHash, hash(owner.email));
  const count = data.writes.length; const family = (await data.family()).report;
  assert.deepEqual(family.summary, own.summary); assert.deepEqual(family.subjects, own.subjects); assert.equal(family.readOnly, true); assert.equal(family.view, 'parent'); assert.equal(data.writes.length, count);
  const roster = await handleSchool(event(`/api/school/schools/${schoolId}/classes/${classId}/roster`), admin); assert.ok(typeof roster !== 'string'); assert.equal(JSON.stringify(JSON.parse(roster.body!)).includes(owner.id), false);
  await assert.rejects(data.family(other), rejected('CHILD_ACCESS_DENIED'));
});

test('roster name/parent changes retain binding, but email changes/reverts and deactivation clear it atomically', async t => {
  const data = fixture(t); await data.self(); const original = structuredClone(data.binding());
  await data.edit({ name: 'Corrected Name' }); assert.deepEqual(data.binding(), original);
  await data.edit({ parentEmails: [other.email] }); assert.deepEqual(data.binding(), original); await assert.rejects(data.family(), rejected('CHILD_ACCESS_DENIED')); assert.equal((await data.family(other)).report.view, 'parent');
  await data.edit({ studentEmail: 'new-learner@example.test' }); assert.equal(data.binding(), undefined); assert.equal((await data.family(other)).status, 'learner_not_connected');
  await data.edit({ studentEmail: owner.email }); assert.equal(data.binding(), undefined); assert.equal((await data.family(other)).status, 'learner_not_connected');
  await data.self(); assert.equal(data.binding()?.accountId, owner.id); await data.edit({ active: false }); assert.equal(data.binding(), undefined); await assert.rejects(data.family(other), rejected('CHILD_ACCESS_DENIED'));
});

test('stale profiles, wrong hashes and duplicate student links never grant a parent report', async t => {
  const data = fixture(t); await data.self(); const binding = structuredClone(data.binding()!);
  data.get(`USER#${owner.id}`, 'PROFILE')!.email = other.email; assert.equal((await data.family()).status, 'learner_not_connected');
  data.get(`USER#${owner.id}`, 'PROFILE')!.email = owner.email; data.get(`USER#${owner.id}`, 'PROFILE')!.emailVerified = false; assert.equal((await data.family()).status, 'learner_not_connected');
  data.get(`USER#${owner.id}`, 'PROFILE')!.emailVerified = true; data.binding()!.emailHash = hash(other.email); assert.equal((await data.family()).status, 'learner_not_connected');
  data.put(binding); const otherChild = id(80); data.put({ ...data.child, id: otherChild, SK: `STUDENT#${otherChild}` }); data.put({ PK: `SCHOOL_EMAIL#${hash(owner.email)}`, SK: `STUDENT#${otherChild}`, schoolId, classId, studentId: otherChild });
  assert.equal((await data.family()).status, 'learner_not_connected'); const before = structuredClone(data.binding()); await data.self(); assert.deepEqual(data.binding(), before);
});

test('parent revocation or account rebinding during aggregation prevents returning old account data', async t => {
  for (const change of ['parent', 'binding']) await t.test(change, async childTest => {
    const data = fixture(childTest); await data.self();
    data.hooks.query = (PK, prefix) => {
      if (PK !== `USER#${owner.id}` || prefix !== '') return; data.hooks.query = undefined;
      if (change === 'parent') data.get(data.child.PK, data.child.SK)!.parentEmails = [];
      else { data.binding()!.accountId = other.id; data.get(`USER#${other.id}`, 'PROFILE')!.email = owner.email; }
    };
    await assert.rejects(data.family(), rejected(change === 'parent' ? 'CHILD_ACCESS_DENIED' : 'REPORT_LINK_CHANGED'));
  });
});

test('binding refuses a roster change between verified discovery and the transaction', async t => {
  const data = fixture(t);
  data.hooks.transaction = items => { if (items.some(item => item.Put?.Item.kind === 'learner-account')) { data.hooks.transaction = undefined; data.get(data.child.PK, data.child.SK)!.version++; } };
  await assert.rejects(data.self(), rejected('RECORD_CHANGED')); assert.equal(data.binding(), undefined);
});

test('a concurrent identity change cannot be overwritten by stale verification evidence', async t => {
  const data = fixture(t); data.get(`USER#${owner.id}`, 'PROFILE')!.email = 'previous@example.test';
  data.hooks.transaction = items => {
    if (items.some(item => item.Put?.Item.SK === 'PROFILE')) { data.hooks.transaction = undefined; data.get(`USER#${owner.id}`, 'PROFILE')!.email = 'newer@example.test'; }
  };
  await assert.rejects(syncVerifiedProfile(owner), rejected('IDENTITY_CHANGED'));
  assert.equal(data.get(`USER#${owner.id}`, 'PROFILE')!.email, 'newer@example.test'); assert.equal(data.writes.length, 0);
});

test('origin indexes are atomic on creation and ensured for existing starts and progress', async t => {
  const data = fixture(t); const recommendationId = hash('new-origin');
  const meta = { PK: `RECOMMENDATION#${recommendationId}`, SK: 'META', id: recommendationId, schoolId, classId, logId, version: 1, chapterId: chapter.id, mode: 'learn', kind: 'lesson', audience: { type: 'class' }, date: null };
  data.put(meta); data.put({ PK: `COMM#${schoolId}#${classId}`, SK: `LOG#${logId}`, id: logId, schoolId, classId, version: 1 }); data.put({ PK: `GUIDANCE#${schoolId}#${classId}`, SK: `LOG#${logId}#V#000001`, recommendationIds: [recommendationId] });
  const expected = reportOriginRow(owner.id, childId, meta); await startOrigin(owner, recommendationId); assert.deepEqual(data.get(expected.PK, expected.SK), expected);
  data.erase(expected.PK, expected.SK); await startOrigin(owner, recommendationId); assert.deepEqual(data.get(expected.PK, expected.SK), expected);
  data.erase(expected.PK, expected.SK); await originProgress(owner, recommendationId, chapter.id, 'learn', { currentCardId: learn[1], completedCardIds: [learn[0]], language: 'en' }); assert.deepEqual(data.get(expected.PK, expected.SK), expected);
  assert.equal((await buildReport(owner.id, 'self', 'Asia/Kolkata')).summary.ideasExplored, 1);
  const another = hash('lost-create'); data.put({ ...meta, PK: `RECOMMENDATION#${another}`, id: another }); data.get(`GUIDANCE#${schoolId}#${classId}`, `LOG#${logId}#V#000001`)!.recommendationIds.push(another);
  data.hooks.transaction = () => { data.hooks.transaction = undefined; data.get(`COMM#${schoolId}#${classId}`, `LOG#${logId}`)!.version = 2; };
  await assert.rejects(startOrigin(owner, another), rejected('GUIDANCE_CHANGED')); assert.equal(data.get(`USER#${owner.id}`, `REPORT_ORIGIN#${another}#${childId}`), undefined);
});

test('real handler syncs changed identity before learning writes, establishes /me binding and rejects client account selectors', async t => {
  const data = fixture(t); const { handler } = await import('../index.js');
  async function call(path: string, account = owner, method = 'GET', body?: unknown, queryStringParameters?: Record<string, string>) {
    const request = event(path, method, body); request.headers = { authorization: `Bearer ${account.id}` }; request.queryStringParameters = queryStringParameters;
    request.requestContext.authorizer = { jwt: { claims: { sub: account.id, token_use: 'access' }, scopes: [] } };
    const response = await handler(request); assert.ok(typeof response !== 'string'); return { status: response.statusCode, data: JSON.parse(response.body!) };
  }
  const signedIn = await call('/api/me'); assert.equal(signedIn.status, 200); assert.equal(data.binding()?.accountId, owner.id);
  assert.equal((await call(reportPath, parent, 'GET', undefined, { accountId: other.id })).status, 400);
  assert.equal((await call('/api/reports/mine', owner, 'POST', { accountId: other.id })).status, 405);
  data.identities.get(owner.id)!.email = 'changed@example.test'; data.writes.length = 0;
  const created = await call(`/api/practice/${chapter.id}/sets`, owner, 'POST', { requestId: id(70), language: 'en' }); assert.equal(created.status, 200); assert.equal(data.writes[0].SK, 'PROFILE'); assert.equal(data.writes[0].email, 'changed@example.test');
  assert.equal((await call(reportPath, parent)).data.status, 'learner_not_connected');
  data.identities.get(owner.id)!.emailVerified = false; assert.equal((await call('/api/reports/mine')).status, 403);
});
