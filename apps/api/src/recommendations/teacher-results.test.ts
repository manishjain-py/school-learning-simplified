import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handleRecommendations } from './index.js';
import { SchoolError, type VerifiedAccount } from '../school/index.js';

type Row = { PK: string; SK: string; [key: string]: any };
type Result = { status: string; source?: string; correct?: number; completed?: number; total?: number; answered?: number; recordedAt?: string };
type Report = { recommendations: { id: string; learners: { studentId: string; results: Result[] }[] }[] };
const contentDirectory = fileURLToPath(new URL('../../../../content/releases/m2/', import.meta.url));
const content = (path: string) => JSON.parse(readFileSync(resolve(contentDirectory, path), 'utf8'));
const chapters = content('catalog.json').chapters as { id: string; title: string }[];
const chapter = chapters[0];
const questions = content(`practice/${chapter.id}/en.json`).questions.map((question: Row) => question.id) as string[];
const learn = content(`lessons/${chapter.id}/en.json`).cards.map((card: Row) => card.id) as string[];
const revise = content(`revise/${chapter.id}/en.json`).cards.map((card: Row) => card.id) as string[];
const schoolId = '11111111-1111-4111-8111-111111111111';
const classId = '22222222-2222-4222-8222-222222222222';
const childId = '33333333-3333-4333-8333-333333333333';
const logId = '44444444-4444-4444-8444-444444444444';
const teacher: VerifiedAccount = { id: 'teacher', email: 'teacher@example.test', emailVerified: true };
const learner: VerifiedAccount = { id: 'learner', email: 'learner@example.test', emailVerified: true };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const key = (PK: string, SK: string) => JSON.stringify([PK, SK]);
const event = () => ({ rawPath: `/api/school/recommendations/${schoolId}/${classId}/logs/${logId}/results`, requestContext: { http: { method: 'GET' } } }) as APIGatewayProxyEventV2WithJWTAuthorizer;

function fixture() {
  const rows = new Map<string, Row>();
  const put = (row: Row) => { rows.set(key(row.PK, row.SK), row); return row; };
  const school = put({ PK: `SCHOOL#${schoolId}`, SK: 'META', id: schoolId, name: 'Fixture School', timeZone: 'Asia/Kolkata', adminId: teacher.id });
  put({ PK: school.PK, SK: `CLASS#${classId}`, id: classId, name: 'Class 4', subject: 'EVS', teacherEmails: [teacher.email], version: 1 });
  const child = put({ PK: `CLASS#${schoolId}#${classId}`, SK: `STUDENT#${childId}`, id: childId, name: 'Fixture Child', studentEmail: learner.email, parentEmails: ['parent@example.test'], active: true, version: 1 });
  put({ PK: `SCHOOL_EMAIL#${hash(learner.email)}`, SK: `STUDENT#${schoolId}#${classId}#${childId}`, schoolId, classId, studentId: childId });
  const binding = put({ PK: child.PK, SK: `LEARNER_ACCOUNT#${childId}`, kind: 'learner-account', schemaVersion: 1, schoolId, classId, studentId: childId, accountId: learner.id, emailHash: hash(learner.email), boundAt: '2026-10-28T10:00:00Z' });
  const profile = put({ PK: `USER#${learner.id}`, SK: 'PROFILE', email: learner.email, emailVerified: true });
  const log = put({ PK: `COMM#${schoolId}#${classId}`, SK: `LOG#${logId}`, id: logId, schoolId, classId, authorId: teacher.id, authorEmail: teacher.email, authorName: 'Fixture Teacher', note: 'Private note', version: 1, guidance: { status: 'published' } });
  const snapshot = put({ PK: `GUIDANCE#${schoolId}#${classId}`, SK: `LOG#${logId}#V#000001`, version: 1, attempt: 1, status: 'published', startedAt: '2026-10-29T10:00:00Z', recommendationIds: [], allRecommendationIds: [], unresolved: [], retryable: false });
  function recommendation(mode: 'learn' | 'revise' | 'practice' = 'practice', label: string = mode, changes: Record<string, unknown> = {}) {
    const id = hash(label);
    const row = put({ PK: `RECOMMENDATION#${id}`, SK: 'META', id, schoolId, classId, logId, version: 1, authorId: teacher.id, createdAt: '2026-10-29T10:00:00Z', chapterId: chapter.id, mode, kind: 'assignment', date: null, title: `Try ${mode}`, reason: 'Your teacher recommended this.', audience: { type: 'class' }, ...changes });
    snapshot.recommendationIds.push(id); snapshot.allRecommendationIds.push(id); return row;
  }
  function set(label = 'set-1', changes: Record<string, unknown> = {}) {
    return put({ PK: `USER#${learner.id}`, SK: `PRACTICE_SET#${chapter.id}#SET#${label}`, id: label, kind: 'practice-set', schemaVersion: 1, contentRelease: 'm2', chapterId: chapter.id, questionIds: questions.slice(0, 10), status: 'submitted', score: 8, total: 10, submittedAt: '2026-10-29T11:00:00Z', createdAt: '2026-10-29T10:30:00Z', updatedAt: '2026-10-29T11:00:00Z', ...changes });
  }
  return { rows, put, school, child, binding, profile, log, recommendation, set };
}

function reads(t: TestContext, data: ReturnType<typeof fixture>, hooks: { get?: (key: { PK: string; SK: string }) => void; query?: (PK: string, prefix: string) => void; paginate?: boolean } = {}) {
  const environment = { NODE_ENV: 'test', CONTENT_RELEASE: 'm2', LOCAL_CONTENT_DIR: contentDirectory, TABLE_NAME: 'test-only-teacher-results' };
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const queries: { PK: string; prefix: string }[] = [];
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    if (command instanceof GetCommand) {
      const Key = command.input.Key as { PK: string; SK: string }; hooks.get?.(Key);
      return { Item: structuredClone(data.rows.get(key(Key.PK, Key.SK))) };
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!; const PK = values[':pk'] as string; const prefix = (values[':prefix'] || '') as string;
      queries.push({ PK, prefix }); hooks.query?.(PK, prefix);
      const matches = [...data.rows.values()].filter(row => row.PK === PK && row.SK.startsWith(prefix));
      if (hooks.paginate && prefix.startsWith('PRACTICE_SET#') && matches.length > 1) return command.input.ExclusiveStartKey ? { Items: structuredClone(matches.slice(1)) } : { Items: structuredClone(matches.slice(0, 1)), LastEvaluatedKey: { PK, SK: matches[0].SK } };
      return { Items: structuredClone(matches) };
    }
    assert.fail(`Teacher results must remain read-only, got ${(command as object).constructor.name}.`);
  });
  t.mock.method(S3Client.prototype, 'send', async () => assert.fail('Use local prepared content.'));
  t.mock.method(BedrockRuntimeClient.prototype, 'send', async () => assert.fail('Teacher results must not invoke Llama.'));
  return queries;
}
const report = async () => await handleRecommendations(event(), teacher) as Report;
const results = (report: Report, index = 0) => report.recommendations[index].learners.find(child => child.studentId === childId)!.results;
const conflict = (issue: unknown) => issue instanceof SchoolError && issue.status === 409 && issue.code === 'RESULTS_LINK_CHANGED';

test('a canonical library submission shows 8/10 without creating recommendation activity', async t => {
  const data = fixture(); data.recommendation(); data.set(); reads(t, data);
  const before = structuredClone(data.rows);
  assert.deepEqual(results(await report()), [{ source: 'library', status: 'submitted', recordedAt: '2026-10-29T11:00:00.000Z', correct: 8, total: 10 }]);
  assert.deepEqual(data.rows, before);
});

test('latest submitted library result is explicit even before the note; newer drafts do not hide it', async t => {
  const data = fixture(); data.recommendation();
  data.set('older', { score: 4, submittedAt: '2026-10-27T10:00:00Z' });
  data.set('latest', { score: 8, submittedAt: '2026-10-28T15:00:00+05:30' });
  data.set('draft', { status: 'draft', score: 10, updatedAt: '2026-10-30T10:00:00Z' });
  reads(t, data, { paginate: true });
  assert.deepEqual(results(await report()), [{ source: 'library', status: 'submitted', recordedAt: '2026-10-28T09:30:00.000Z', correct: 8, total: 10 }]);
});

test('a draft is started without any purported score or completion', async t => {
  const data = fixture(); data.recommendation(); data.set('draft', { status: 'draft', score: 10, answers: Object.fromEntries(questions.slice(0, 10).map(id => [id, ['pick']])) }); reads(t, data);
  assert.deepEqual(results(await report()), [{ source: 'library', status: 'started', recordedAt: '2026-10-29T11:00:00.000Z', answered: 10, total: 10 }]);
});

test('only valid canonical library sets can become submitted teacher results', async t => {
  const invalid = [
    { schemaVersion: 2 }, { contentRelease: 'other' }, { kind: 'practice-answer' }, { chapterId: chapters[1].id }, { questionIds: Array(10).fill(questions[0]) },
    { questionIds: [...questions.slice(0, 9), 'not-in-chapter'] }, { total: 9 }, { score: 11 }, { score: -1 }, { score: 8.5 }, { submittedAt: 'invalid' },
    { recommendationId: hash('another-recommendation'), studentId: childId, studentEmailHash: hash(learner.email) }, { studentId: 'another-child' }, { status: 'unknown' },
  ];
  for (const patch of invalid) await t.test(JSON.stringify(patch), async sub => {
    const data = fixture(); data.recommendation(); data.set('invalid', patch); reads(sub, data);
    assert.deepEqual(results(await report()), [{ status: 'not_started' }]);
  });
});

test('Learn and Revise use only canonical saved coverage and stay distinct from origin work', async t => {
  const data = fixture(); const learnRec = data.recommendation('learn'); data.recommendation('revise');
  data.put({ PK: `USER#${learner.id}`, SK: `PROGRESS#${chapter.id}`, chapterId: chapter.id, currentCardId: learn[1], completedCards: [learn[0], learn[0], 'unknown'], updatedAt: '2026-10-27T11:00:00Z' });
  data.put({ PK: `USER#${learner.id}`, SK: `PROGRESS#revise#${chapter.id}`, chapterId: chapter.id, currentCardId: revise[0], completedCards: new Set(revise), updatedAt: '2026-10-29T11:00:00Z' });
  data.put({ PK: `RECOMMENDATION#${learnRec.id}`, SK: `ACTIVITY#${childId}#${learner.id}`, recommendationId: learnRec.id, studentId: childId, accountId: learner.id, studentEmailHash: hash(learner.email), startedAt: '2026-10-29T10:00:00Z', completedCards: new Set([learn[2]]) });
  reads(t, data);
  const response = await report();
  assert.deepEqual(results(response), [
    { status: 'started', source: 'recommendation', startedAt: '2026-10-29T10:00:00Z', completed: 1, total: learn.length },
    { status: 'started', source: 'library', recordedAt: '2026-10-27T11:00:00.000Z', completed: 1, total: learn.length },
  ]);
  assert.deepEqual(results(response, 1), [{ status: 'completed', source: 'library', recordedAt: '2026-10-29T11:00:00.000Z', completed: revise.length, total: revise.length }]);
});

test('no valid saved card or timestamp means no library activity', async t => {
  for (const patch of [{ currentCardId: 'unknown', completedCards: ['unknown'] }, { updatedAt: 'invalid' }, { chapterId: chapters[1].id }]) await t.test(JSON.stringify(patch), async sub => {
    const data = fixture(); data.recommendation('learn');
    data.put({ PK: `USER#${learner.id}`, SK: `PROGRESS#${chapter.id}`, chapterId: chapter.id, currentCardId: learn[0], completedCards: new Set([learn[0]]), updatedAt: '2026-10-29T11:00:00Z', ...patch }); reads(sub, data);
    assert.deepEqual(results(await report()), [{ status: 'not_started' }]);
  });
});

test('missing, stale, unverified and ambiguous account bindings never authorize a library query', async t => {
  const cases: [string, (data: ReturnType<typeof fixture>) => void][] = [
    ['missing binding', data => data.rows.delete(key(data.binding.PK, data.binding.SK))],
    ['wrong email hash', data => { data.binding.emailHash = hash('other@example.test'); }],
    ['wrong class binding', data => { data.binding.classId = 'other-class'; }],
    ['unverified profile', data => { data.profile.emailVerified = false; }],
    ['changed profile email', data => { data.profile.email = 'other@example.test'; }],
    ['missing discovery link', data => { data.rows.delete(key(`SCHOOL_EMAIL#${hash(learner.email)}`, `STUDENT#${schoolId}#${classId}#${childId}`)); }],
    ['ambiguous link', data => { const other = '55555555-5555-4555-8555-555555555555'; data.put({ ...data.child, SK: `STUDENT#${other}`, id: other }); data.put({ PK: `SCHOOL_EMAIL#${hash(learner.email)}`, SK: `STUDENT#${schoolId}#${classId}#${other}`, schoolId, classId, studentId: other }); }],
  ];
  for (const [label, change] of cases) await t.test(label, async sub => {
    const data = fixture(); data.recommendation(); data.set(); change(data); const queries = reads(sub, data);
    assert.deepEqual(results(await report()), [{ status: 'not_started' }]);
    assert.equal(queries.some(query => query.PK === `USER#${learner.id}`), false);
  });
});

test('a roster or binding changed during library reading discards the response', async t => {
  for (const change of ['roster', 'binding', 'profile'] as const) await t.test(change, async sub => {
    const data = fixture(); data.recommendation(); data.set();
    reads(sub, data, { query: (_PK, prefix) => { if (prefix.startsWith('PRACTICE_SET#')) { if (change === 'roster') data.child.active = false; else if (change === 'binding') data.binding.accountId = 'replacement'; else data.profile.emailVerified = false; } } });
    await assert.rejects(report(), conflict);
  });
});

test('current author and staff access remain mandatory, including after library reads', async t => {
  await t.test('another author', async sub => {
    const data = fixture(); data.log.authorId = 'another-teacher'; data.recommendation(); data.set(); const queries = reads(sub, data);
    await assert.rejects(report(), issue => issue instanceof SchoolError && issue.code === 'LOG_AUTHOR_REQUIRED');
    assert.equal(queries.some(query => query.PK === `USER#${learner.id}`), false);
  });
  await t.test('removed teacher', async sub => {
    const data = fixture(); data.recommendation(); data.set(); reads(sub, data, { query: (_PK, prefix) => { if (prefix.startsWith('PRACTICE_SET#')) data.school.adminId = 'replacement'; } });
    await assert.rejects(report(), issue => issue instanceof SchoolError && issue.code === 'SCHOOL_ACCESS_DENIED');
  });
});

test('one child/chapter/mode read is reused without exposing other children or chapters', async t => {
  const data = fixture(); data.recommendation('practice', 'first'); data.recommendation('practice', 'second'); data.set();
  data.put({ ...data.child, id: '55555555-5555-4555-8555-555555555555', SK: 'STUDENT#55555555-5555-4555-8555-555555555555', name: 'Another Child', studentEmail: 'other@example.test' });
  data.set('other-chapter', { chapterId: chapters[1].id, score: 10 });
  data.put({ PK: `USER#${learner.id}`, SK: 'PRIVATE_UNRELATED', secret: 'unrelated-private-data' });
  const queries = reads(t, data); const response = await report();
  assert.equal(queries.filter(query => query.PK === `USER#${learner.id}` && query.prefix === `PRACTICE_SET#${chapter.id}#SET#`).length, 1);
  for (const rec of response.recommendations) { assert.equal(rec.learners.find(child => child.studentId === childId)!.results[0].correct, 8); assert.deepEqual(rec.learners.find(child => child.studentId !== childId)!.results, [{ status: 'not_started' }]); }
  const serialized = JSON.stringify(response);
  for (const hidden of [learner.email, 'unrelated-private-data', 'other-chapter']) assert.equal(serialized.includes(hidden), false);
});
