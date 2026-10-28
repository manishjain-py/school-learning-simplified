import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handlePracticeSets, type PracticeContent } from './index.js';
import { selectQuestions, type SetQuestion } from './selection.js';
import { handleRecommendations, startOrigin } from '../recommendations/index.js';
import { SchoolError, type VerifiedAccount } from '../school/index.js';

type Row = Record<string, any>;
const directory = fileURLToPath(new URL('../../../../content/releases/m2/', import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(resolve(directory, path), 'utf8'));
const chapters = read('catalog.json').chapters as { id: string; title: string }[];
const chapterId = chapters[0].id;
const owner: VerifiedAccount = { id: 'owner-account', email: 'owner@example.test', emailVerified: true };
const stranger: VerifiedAccount = { id: 'other-account', email: 'other@example.test', emailVerified: true };
const teacher: VerifiedAccount = { id: 'teacher-account', email: 'teacher@example.test', emailVerified: true };
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const setKey = (setId: string) => ({ PK: `USER#${owner.id}`, SK: `PRACTICE_SET#${chapterId}#SET#${setId}` });
const mapKey = (key: Row) => JSON.stringify([key.PK, key.SK]);
function event(method: string, suffix: string, body?: unknown, queryStringParameters?: Record<string, string>): APIGatewayProxyEventV2WithJWTAuthorizer {
  return { rawPath: `/api/practice/${chapterId}/${suffix}`, requestContext: { http: { method } }, body: body === undefined ? undefined : JSON.stringify(body), queryStringParameters } as APIGatewayProxyEventV2WithJWTAuthorizer;
}
function setup(t: TestContext) {
  const settings = { NODE_ENV: 'test', CONTENT_RELEASE: 'm2', LOCAL_CONTENT_DIR: directory, LOCAL_PRIVATE_CONTENT_DIR: undefined, TABLE_NAME: 'test-only-practice', CONTENT_BUCKET: 'test-only-content' };
  const before = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const rows = new Map<string, Row>();
  const put = (row: Row) => { rows.set(mapKey(row), structuredClone(row)); return row; };
  const get = (key: Row) => rows.get(mapKey(key));
  let privateReads = 0; let transactionCount = 0;
  const keys = (language: string) => ({ answers: Object.fromEntries(read(`practice/${chapterId}/${language}.json`).questions.map((question: SetQuestion) => [question.id, { correctOptionIds: [question.options[0].id], correctAnswerText: question.options[0].text, reason: `Prepared ${language} explanation for ${question.id}` }])) });
  const content: PracticeContent = { bank: async language => read(`practice/${chapterId}/${language}.json`), keys: async language => { privateReads++; return keys(language); }, legacy: async (_user, _chapter, session, language) => ({ id: session, language, legacy: true }) };
  const hooks: { beforeTransaction?: (items: Row[]) => void | Promise<void> } = {};
  function condition(operation: Row) {
    if (!operation.ConditionExpression) return true;
    const row = get(operation.Item || operation.Key);
    const names = operation.ExpressionAttributeNames || {}; const values = operation.ExpressionAttributeValues || {};
    return operation.ConditionExpression.split(' AND ').every((clause: string) => {
      const exists = clause.match(/^attribute_(not_)?exists\(([^)]+)\)$/);
      if (exists) return exists[1] ? row?.[names[exists[2]] || exists[2]] === undefined : row?.[names[exists[2]] || exists[2]] !== undefined;
      const equals = clause.match(/^([#\w]+) = (:\w+)$/);
      assert.ok(equals, `Unsupported test condition: ${clause}`);
      return row?.[names[equals[1]] || equals[1]] === values[equals[2]];
    });
  }
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: structuredClone(get(command.input.Key!)) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      return { Items: structuredClone([...rows.values()].filter(row => row.PK === values[':pk'] && row.SK.startsWith(values[':prefix']))) };
    }
    assert.ok(command instanceof TransactWriteCommand, 'All practice writes must be conditional transactions.');
    const items = command.input.TransactItems as Row[]; transactionCount++;
    await hooks.beforeTransaction?.(items);
    if (!items.every(item => condition(item.Put || item.Update || item.ConditionCheck))) throw Object.assign(new Error('Conditional write lost'), { name: 'TransactionCanceledException' });
    for (const item of items) {
      if (item.Put) put(item.Put.Item);
      if (item.Update) {
        const operation = item.Update; const next = structuredClone(get(operation.Key)!);
        for (const assignment of operation.UpdateExpression.replace(/^SET /, '').split(', ')) {
          const [field, value] = assignment.split(' = '); next[operation.ExpressionAttributeNames?.[field] || field] = operation.ExpressionAttributeValues[value];
        }
        put(next);
      }
    }
    return {};
  });
  t.mock.method(S3Client.prototype, 'send', async (command: { input: { Key: string } }) => {
    assert.ok(command.input.Key.startsWith('private/releases/m2/practice/'), 'Only synthetic private keys may use the mocked S3 reader.');
    const language = command.input.Key.endsWith('/hi.json') ? 'hi' : 'en'; privateReads++;
    return { Body: { transformToString: async () => JSON.stringify(keys(language)) } };
  });
  t.mock.method(BedrockRuntimeClient.prototype, 'send', async () => { assert.fail('Practice must not call a model.'); });
  t.mock.method(CognitoIdentityProviderClient.prototype, 'send', async (command: { input: { AccessToken: string } }) => {
    const account = command.input.AccessToken === 'stranger-token' ? stranger : owner;
    return { UserAttributes: [{ Name: 'sub', Value: account.id }, { Name: 'email', Value: account.email }, { Name: 'email_verified', Value: command.input.AccessToken === 'unverified-token' ? 'false' : 'true' }] };
  });
  const call = async (method: string, suffix: string, body?: unknown, query?: Record<string, string>, user = owner) => await handlePracticeSets(event(method, suffix, body, query), user, chapterId, content) as Row;
  const create = async (requestId = id(1), recommendationId?: string) => (await call('POST', 'sets', { requestId, language: 'en', ...(recommendationId ? { recommendationId } : {}) })).set as Row;
  return { rows, put, get, keys, content, hooks, call, create, privateReads: () => privateReads, transactionCount: () => transactionCount };
}
const rejected = (code: string) => (error: unknown) => error instanceof SchoolError && error.code === code;
const picks = (set: Row) => Object.fromEntries(set.questionIds.map((questionId: string) => [questionId, [read(`practice/${chapterId}/en.json`).questions.find((question: SetQuestion) => question.id === questionId).options[0].id]]));
const draft = (set: Row, answers = picks(set)) => ({ version: set.version, currentIndex: 4, language: 'en', answers });
function originFixture(data: ReturnType<typeof setup>) {
  const schoolId = id(80); const classId = id(81); const childId = id(82); const logId = id(83); const recommendationId = 'a'.repeat(64);
  data.put({ PK: `SCHOOL#${schoolId}`, SK: 'META', id: schoolId, name: 'Fixture School', timeZone: 'Asia/Kolkata', adminId: teacher.id });
  data.put({ PK: `SCHOOL#${schoolId}`, SK: `CLASS#${classId}`, id: classId, name: 'Class 4', teacherEmails: [teacher.email] });
  const child = data.put({ PK: `CLASS#${schoolId}#${classId}`, SK: `STUDENT#${childId}`, id: childId, name: 'Fixture Learner', studentEmail: owner.email, parentEmails: [stranger.email], active: true });
  for (const [account, role] of [[owner, 'STUDENT'], [stranger, 'PARENT']] as const) data.put({ PK: `SCHOOL_EMAIL#${hash(account.email)}`, SK: `${role}#${childId}`, schoolId, classId, studentId: childId });
  const log = data.put({ PK: `COMM#${schoolId}#${classId}`, SK: `LOG#${logId}`, id: logId, schoolId, classId, version: 1, authorId: teacher.id, guidance: { status: 'published' } });
  data.put({ PK: `GUIDANCE#${schoolId}#${classId}`, SK: `LOG#${logId}#V#000001`, recommendationIds: [recommendationId], allRecommendationIds: [recommendationId], status: 'published', unresolved: [], startedAt: '2026-10-28T00:00:00Z' });
  data.put({ PK: `RECOMMENDATION#${recommendationId}`, SK: 'META', id: recommendationId, schoolId, classId, logId, version: 1, chapterId, mode: 'practice', kind: 'test', date: '2026-10-29', title: 'Practise Our Earth', reason: 'Your teacher recorded a test.', audience: { type: 'class' } });
  const activity = { PK: `RECOMMENDATION#${recommendationId}`, SK: `ACTIVITY#${childId}#${owner.id}` };
  return { schoolId, classId, childId, logId, recommendationId, activity, child, log };
}

test('frozen banks yield six distinct sets with suitable difficulty and format mixes', () => {
  for (const chapter of chapters) {
    const bank = read(`practice/${chapter.id}/en.json`).questions as SetQuestion[];
    const seen = new Map<string, number>();
    for (let round = 0; round < 6; round++) {
      const ids = selectQuestions(bank, seen, () => 0); const chosen = ids.map(id => bank.find(question => question.id === id)!);
      assert.equal(ids.length, 10); assert.equal(new Set(ids).size, 10); assert.ok(ids.every(id => !seen.has(id)));
      assert.equal(chosen.filter(question => question.difficulty === 'easy').length, round === 5 && chapter.title === 'Animal Life' ? 3 : 4);
      const maxFormat = Math.max(...[...new Set(chosen.map(question => question.format))].map(format => chosen.filter(question => question.format === format).length));
      if (maxFormat <= 5) assert.ok(chosen.every((question, index) => !index || question.format !== chosen[index - 1].format));
      ids.forEach(id => seen.set(id, 1));
    }
    assert.equal(seen.size, 60);
    const repeated = selectQuestions(bank, seen, () => 0); assert.equal(new Set(repeated).size, 10);
    const hindi = read(`practice/${chapter.id}/hi.json`).questions as SetQuestion[];
    assert.deepEqual(bank.map(question => [question.id, question.format, question.options.map(option => option.id)]), hindi.map(question => [question.id, question.format, question.options.map(option => option.id)]));
  }
});

test('an unlucky selection swaps format alternatives before accepting adjacent repeats', () => {
  const bank: SetQuestion[] = Array.from({ length: 20 }, (_, index) => ({ id: String(index), difficulty: index < 8 ? 'easy' : 'medium', format: index % 3 ? 'pick_one' : 'true_false', options: [{ id: 'yes', text: 'Yes' }] }));
  const chosen = selectQuestions(bank, new Map(), max => max - 1).map(id => bank.find(question => question.id === id)!);
  assert.equal(chosen.filter(question => question.difficulty === 'easy').length, 4);
  assert.ok(chosen.every((question, index) => !index || question.format !== chosen[index - 1].format));
});

test('create/resume, versioned picks and current position never expose draft grading', async t => {
  const data = setup(t); const set = await data.create();
  assert.equal(set.status, 'draft'); assert.equal(set.total, 10); assert.equal(data.privateReads(), 0);
  for (const field of ['score', 'results', 'verdicts', 'submittedAt', 'correctOptionIds', 'reason']) assert.equal(field in set, false);
  const saved = (await data.call('PUT', `sets/${set.id}`, { ...draft(set), language: 'hi', currentIndex: 7 })).set;
  assert.equal(saved.version, 2); assert.equal(saved.language, 'hi'); assert.equal(saved.currentIndex, 7); assert.equal(data.privateReads(), 0);
  assert.deepEqual((await data.call('GET', 'sets/current')).set, saved);
  assert.deepEqual(await data.create(id(2)), saved);
  await assert.rejects(data.call('PUT', `sets/${set.id}`, draft(set)), rejected('SET_CHANGED'));
  assert.equal(data.transactionCount(), 2);
});

test('draft saves reject forged sets/scores, unknown options, duplicates and invalid cardinality', async t => {
  const data = setup(t); const set = await data.create();
  const bank = (await data.content.bank('en')).questions;
  const single = set.questionIds.map((id: string) => bank.find(question => question.id === id)!).find((question: SetQuestion) => question.format !== 'multi_select')!;
  for (const bad of [{ unknown: ['one'] }, { [single.id]: ['not-an-option'] }, { [single.id]: [single.options[0].id, single.options[0].id] }, { [single.id]: single.options.slice(0, 2).map((option: Row) => option.id) }]) await assert.rejects(data.call('PUT', `sets/${set.id}`, draft(set, bad)), rejected('INVALID_ANSWER'));
  for (const injected of [{ score: 10 }, { questionIds: [single.id] }, { recommendationId: 'b'.repeat(64) }]) await assert.rejects(data.call('PUT', `sets/${set.id}`, { ...draft(set), ...injected }), rejected('INVALID_REQUEST'));
  await assert.rejects(data.call('POST', 'sets', { requestId: id(3), language: 'en', questionIds: set.questionIds }), rejected('INVALID_REQUEST'));
  assert.equal(data.transactionCount(), 1); assert.equal(data.privateReads(), 0);
});

test('final Submit grades stored picks, includes skipped reviews, and is immutable across retries/languages', async t => {
  const data = setup(t); const set = await data.create(); const answers = picks(set);
  const bank = (await data.content.bank('en')).questions;
  answers[set.questionIds[0]] = [bank.find(question => question.id === set.questionIds[0])!.options[1].id];
  answers[set.questionIds[1]] = [];
  const saved = (await data.call('PUT', `sets/${set.id}`, draft(set, answers))).set;
  const final = (await data.call('POST', `sets/${set.id}/submit`, { version: saved.version })).set;
  assert.equal(final.score, 8); assert.equal(final.answered, 9); assert.equal(final.results[0].verdict, 'incorrect'); assert.equal(final.results[1].verdict, 'skipped'); assert.equal(final.results.length, 10);
  assert.deepEqual((await data.call('POST', `sets/${set.id}/submit`, { version: 1 })).set, final);
  const before = structuredClone(data.get(setKey(set.id)));
  const hindi = (await data.call('GET', `sets/${set.id}`, undefined, { language: 'hi' })).set;
  assert.equal(hindi.language, 'hi'); assert.equal(hindi.submittedLanguage, 'en'); assert.equal(hindi.score, 8); assert.match(hindi.results[0].reason, /Prepared hi/); assert.deepEqual(data.get(setKey(set.id)), before);
  await assert.rejects(data.call('PUT', `sets/${set.id}`, draft(saved)), rejected('SET_FINAL'));
  await assert.rejects(data.call('POST', `sets/${set.id}/submit`, { version: final.version, score: 10 }), rejected('INVALID_REQUEST'));
  assert.equal(data.transactionCount(), 3);
});

test('concurrent creation returns one draft and old create retries never rewind current', async t => {
  const data = setup(t);
  const [one, two] = await Promise.all([data.create(id(1)), data.create(id(2))]);
  assert.equal(one.id, two.id); assert.equal([...data.rows.values()].filter(row => row.kind === 'practice-set').length, 1);
  await data.call('POST', `sets/${one.id}/submit`, { version: one.version });
  const next = await data.create(id(3)); assert.notEqual(next.id, one.id);
  const replay = await data.create(one.id); assert.equal(replay.status, 'submitted');
  assert.equal((await data.call('GET', 'sets/current')).set.id, next.id);
  assert.ok(next.questionIds.every((questionId: string) => !one.questionIds.includes(questionId)));
});

test('concurrent submits record one result and a competing autosave cannot rewrite it', async t => {
  const data = setup(t); let set = await data.create(); set = (await data.call('PUT', `sets/${set.id}`, draft(set))).set;
  const [one, two] = await Promise.all([data.call('POST', `sets/${set.id}/submit`, { version: set.version }), data.call('POST', `sets/${set.id}/submit`, { version: set.version })]);
  assert.deepEqual(one, two); assert.equal(one.set.score, 10); assert.equal(one.set.version, set.version + 1);
  await assert.rejects(data.call('PUT', `sets/${set.id}`, draft(set, {})), rejected('SET_FINAL'));
});

test('a newer autosave winning the submit transaction forces a reload instead of grading stale picks', async t => {
  const data = setup(t); const set = await data.create();
  data.hooks.beforeTransaction = items => {
    if (items.some(item => item.Put?.Item.status === 'submitted')) {
      data.hooks.beforeTransaction = undefined;
      data.put({ ...data.get(setKey(set.id)), answers: picks(set), version: set.version + 1 });
    }
  };
  await assert.rejects(data.call('POST', `sets/${set.id}/submit`, { version: set.version }), rejected('SET_CHANGED'));
  assert.equal(data.get(setKey(set.id))?.status, 'draft'); assert.equal(data.get(setKey(set.id))?.version, 2);
});

test('an in-flight autosave loses its condition when Submit wins first', async t => {
  const data = setup(t); let set = await data.create(); set = (await data.call('PUT', `sets/${set.id}`, draft(set))).set;
  data.hooks.beforeTransaction = async items => {
    if (items.some(item => item.Put?.Item.status === 'draft')) {
      data.hooks.beforeTransaction = undefined;
      await data.call('POST', `sets/${set.id}/submit`, { version: set.version });
    }
  };
  await assert.rejects(data.call('PUT', `sets/${set.id}`, draft(set, {})), rejected('SET_CHANGED'));
  const saved = data.get(setKey(set.id))!;
  assert.equal(saved.status, 'submitted'); assert.equal(saved.score, 10); assert.equal(saved.version, set.version + 1);
});

test('legacy answers inform unseen selection and old rows stay unchanged in history', async t => {
  const data = setup(t); const bank = (await data.content.bank('en')).questions; const sessionId = id(70);
  data.put({ PK: `USER#${owner.id}`, SK: `PRACTICE#${chapterId}#SESSION#${sessionId}`, kind: 'practice-session', chapterId, sessionId, startedAt: '2026-10-27T12:00:00Z' });
  for (const question of bank.slice(0, 10)) data.put({ PK: `USER#${owner.id}`, SK: `PRACTICE#${chapterId}#SESSION#${sessionId}#ANSWER#${question.id}`, kind: 'practice-answer', chapterId, sessionId, questionId: question.id, correct: true });
  const old = structuredClone([...data.rows.values()]); const set = await data.create(); assert.ok(set.questionIds.every((questionId: string) => !bank.slice(0, 10).some(question => question.id === questionId)));
  const history = await data.call('GET', 'sets'); assert.equal(history.legacyRounds[0].answered, 10); assert.equal(history.legacyRounds[0].correctCount, 10); assert.equal(history.sets[0].status, 'draft'); assert.equal('score' in history.sets[0], false);
  for (const row of old) assert.deepEqual(data.get(row), row);
});

test('new recommendation origins bind one set, publish canonical teacher results, and preserve submitted history after correction', async t => {
  const data = setup(t); const origin = originFixture(data);
  await startOrigin(owner, origin.recommendationId);
  assert.equal(data.get(origin.activity)?.sessionId, undefined); assert.equal([...data.rows.values()].some(row => row.kind === 'practice-session'), false);
  assert.equal((await data.call('GET', 'sets/current', undefined, { recommendation: origin.recommendationId })).set, null);
  let set = await data.create(id(1), origin.recommendationId);
  assert.equal(data.get(origin.activity)?.practiceSetId, set.id); assert.equal((await data.create(id(2), origin.recommendationId)).id, set.id);
  assert.equal((await data.call('GET', 'sets/current')).set, null);
  set = (await data.call('PUT', `sets/${set.id}`, draft(set))).set;
  const final = (await data.call('POST', `sets/${set.id}/submit`, { version: set.version })).set;
  const reportEvent = { rawPath: `/api/school/recommendations/${origin.schoolId}/${origin.classId}/logs/${origin.logId}/results`, requestContext: { http: { method: 'GET' } } } as APIGatewayProxyEventV2WithJWTAuthorizer;
  const report = await handleRecommendations(reportEvent, teacher) as Row;
  assert.equal(report.recommendations[0].learners[0].results[0].status, 'submitted'); assert.equal(report.recommendations[0].learners[0].results[0].correct, 10); assert.equal(report.recommendations[0].learners[0].results[0].total, 10);
  data.put({ ...origin.log, version: 2 });
  assert.deepEqual((await data.call('GET', `sets/${set.id}`)).set, final);
  await assert.rejects(data.call('GET', 'sets/current', undefined, { recommendation: origin.recommendationId }), rejected('GUIDANCE_SUPERSEDED'));
});

test('parent, wrong chapter/audience and revoked recommendation links cannot create or mutate a set', async t => {
  const data = setup(t); const origin = originFixture(data);
  await assert.rejects(data.call('POST', 'sets', { requestId: id(1), language: 'en', recommendationId: origin.recommendationId }, undefined, stranger), rejected('STUDENT_LINK_REQUIRED'));
  const metaKey = { PK: `RECOMMENDATION#${origin.recommendationId}`, SK: 'META' }; const meta = structuredClone(data.get(metaKey)!);
  data.put({ ...meta, chapterId: chapters[1].id }); await assert.rejects(startOrigin(owner, origin.recommendationId).then(() => data.create(id(1), origin.recommendationId)), rejected('ORIGIN_MISMATCH'));
  data.put({ ...meta, audience: { type: 'student', studentId: 'another-child' } }); await assert.rejects(startOrigin(owner, origin.recommendationId), rejected('GUIDANCE_ACCESS_DENIED'));
  data.put(meta); await startOrigin(owner, origin.recommendationId); const set = await data.create();
  await assert.rejects(data.create(set.id, origin.recommendationId), rejected('REQUEST_CONFLICT'));
  const linked = await data.create(id(2), origin.recommendationId);
  data.put({ ...origin.child, active: false });
  await assert.rejects(data.call('PUT', `sets/${linked.id}`, draft(linked)), rejected('STUDENT_LINK_REQUIRED'));
  await assert.rejects(data.call('POST', `sets/${linked.id}/submit`, { version: linked.version }), rejected('STUDENT_LINK_REQUIRED'));
});

test('the real handler checks gateway identity, verified email and owner partition; legacy writes are frozen', async t => {
  const data = setup(t);
  for (const account of [owner, stranger]) data.put({ PK: `USER#${account.id}`, SK: 'PROFILE', email: account.email, emailVerified: true });
  const { handler } = await import('../index.js');
  const call = async (method: string, suffix: string, body?: unknown, token = 'owner-token', claims = owner.id) => {
    const request = event(method, suffix, body);
    request.headers = token ? { authorization: `Bearer ${token}` } : {};
    request.requestContext.authorizer = { jwt: { claims: { sub: claims, token_use: 'access' }, scopes: [] } };
    const response = await handler(request); assert.ok(typeof response !== 'string'); return { status: response.statusCode, data: JSON.parse(response.body!) };
  };
  assert.equal((await call('GET', 'sets/current', undefined, '')).status, 401);
  assert.equal((await call('GET', 'sets/current', undefined, 'owner-token', stranger.id)).status, 401);
  assert.equal((await call('GET', 'sets/current', undefined, 'unverified-token')).status, 403);
  const created = await call('POST', 'sets', { requestId: id(1), language: 'en' }); assert.equal(created.status, 200);
  assert.equal((await call('GET', `sets/${created.data.set.id}`, undefined, 'stranger-token', stranger.id)).status, 404);
  for (const [method, suffix] of [['POST', 'sessions'], ['PUT', 'session'], ['POST', 'attempts']]) {
    const response = await call(method, suffix, {}); assert.equal(response.status, 409); assert.equal(response.data.error, 'ROUND_READ_ONLY');
  }
  const sessionId = id(70); const question = (await data.content.bank('en')).questions[0];
  data.put({ PK: `USER#${owner.id}`, SK: `PRACTICE#${chapterId}#SESSION#${sessionId}`, kind: 'practice-session', chapterId, sessionId, startedAt: '2026-10-27T12:00:00Z' });
  const answer = data.put({ PK: `USER#${owner.id}`, SK: `PRACTICE#${chapterId}#SESSION#${sessionId}#ANSWER#${question.id}`, kind: 'practice-answer', chapterId, sessionId, questionId: question.id, selectedOptionIds: [question.options[0].id], correct: true, answeredAt: '2026-10-27T12:01:00Z' });
  data.put({ PK: `USER#${owner.id}`, SK: `PRACTICE_STATE#${chapterId}`, sessionId, language: 'en' });
  for (const suffix of ['session', `rounds/${sessionId}`]) {
    const response = await call('GET', suffix); assert.equal(response.status, 200); assert.equal(response.data.session.answered, 1); assert.equal(response.data.session.correctCount, 1); assert.match(response.data.session.answers[0].reason, /Prepared en/);
  }
  assert.deepEqual(data.get(answer), answer);
  assert.equal(data.transactionCount(), 1);
});
