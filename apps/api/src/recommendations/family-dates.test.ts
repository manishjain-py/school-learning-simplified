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
import { requireFamilyChild, SchoolError, type VerifiedAccount } from '../school/index.js';

const contentDirectory = fileURLToPath(new URL('../../../../content/releases/m2/', import.meta.url));
const chapter = JSON.parse(readFileSync(resolve(contentDirectory, 'catalog.json'), 'utf8')).chapters[0] as { id: string; title: string };
const revisionCards = JSON.parse(readFileSync(resolve(contentDirectory, `revise/${chapter.id}/en.json`), 'utf8')).cards as { id: string }[];
const schoolId = '11111111-1111-4111-8111-111111111111';
const classId = '22222222-2222-4222-8222-222222222222';
const childId = '33333333-3333-4333-8333-333333333333';
const logId = '44444444-4444-4444-8444-444444444444';
const student: VerifiedAccount = { id: 'student-account', email: 'student@example.test', emailVerified: true };
const parent: VerifiedAccount = { id: 'parent-account', email: 'parent@example.test', emailVerified: true };
const teacher: VerifiedAccount = { id: 'teacher-account', email: 'teacher@example.test', emailVerified: true };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const rowKey = (PK: string, SK: string) => JSON.stringify([PK, SK]);
type Row = { PK: string; SK: string; [key: string]: any };
type SafeRecommendation = { id: string; chapterId: string; mode: string; kind: string; date: string | null; title: string; reason: string };
type FamilyGroup = { child: { id: string; name: string; className: string; schoolName: string }; timeZone: string; localToday: string; recommendations: SafeRecommendation[] };
type Mine = { studentStatus: string; student: FamilyGroup[]; parent: FamilyGroup[] };

function fixture(timeZone = 'Asia/Kolkata') {
  const rows = new Map<string, Row>();
  function put(PK: string, SK: string, value: Record<string, unknown>): Row {
    const row: Row = { PK, SK, ...value }; rows.set(rowKey(PK, SK), row); return row;
  }
  const school = put(`SCHOOL#${schoolId}`, 'META', { id: schoolId, name: 'Fixture School', timeZone, adminId: teacher.id });
  put(`SCHOOL#${schoolId}`, `CLASS#${classId}`, { id: classId, name: 'Class 4', subject: 'EVS', teacherEmails: [teacher.email] });
  const child = put(`CLASS#${schoolId}#${classId}`, `STUDENT#${childId}`, { id: childId, name: 'Fixture Child', studentEmail: student.email, parentEmails: [parent.email], active: true });
  const link = { schoolId, classId, studentId: childId };
  function addIndex(account: VerifiedAccount, role: 'STUDENT' | 'PARENT') {
    put(`SCHOOL_EMAIL#${digest(account.email)}`, `${role}#${schoolId}#${classId}#${childId}`, link);
  }
  addIndex(student, 'STUDENT'); addIndex(parent, 'PARENT');
  const log = put(`COMM#${schoolId}#${classId}`, `LOG#${logId}`, {
    id: logId, schoolId, classId, authorId: teacher.id, authorEmail: teacher.email,
    authorName: 'Fixture Teacher', subject: 'EVS', note: 'Private classroom note.',
    localDate: '2026-10-28', timeZone, version: 1, guidance: { status: 'published' },
  });
  function addRecommendation(label: string, date: string | null, version = 1, audience: Record<string, string> = { type: 'class' }) {
    const id = digest(`${label}:${version}`);
    const record = put(`RECOMMENDATION#${id}`, 'META', {
      id, schoolId, classId, logId, version, authorId: teacher.id, createdAt: '2026-10-27T12:00:00Z',
      chapterId: chapter.id, mode: 'revise', kind: 'assignment', date, title: `Revise: ${label}`, reason: 'Your teacher assigned work on this chapter.', audience,
      datePhrase: 'Private extracted phrase.', sourceText: 'Private evidence.',
    });
    const PK = `GUIDANCE#${schoolId}#${classId}`; const SK = `LOG#${logId}#V#${String(version).padStart(6, '0')}`;
    const snapshot = rows.get(rowKey(PK, SK)) || put(PK, SK, { version, attempt: 1, status: 'published', startedAt: '2026-10-27T12:00:00Z', recommendationIds: [], allRecommendationIds: [], unresolved: [], retryable: false });
    snapshot.recommendationIds.push(id); snapshot.allRecommendationIds.push(id);
    return record;
  }
  return { rows, put, school, child, log, addIndex, addRecommendation };
}

function mockReads(t: TestContext, data: ReturnType<typeof fixture>, instant: string, beforeGet?: (key: { PK: string; SK: string }) => void) {
  const environment = { NODE_ENV: 'test', CONTENT_RELEASE: 'm2', LOCAL_CONTENT_DIR: contentDirectory, TABLE_NAME: 'test-only-family-guidance' };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(instant) });
  const calls: string[] = [];
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    calls.push((command as object).constructor.name);
    if (command instanceof GetCommand) {
      const key = command.input.Key as { PK: string; SK: string };
      beforeGet?.(key);
      return { Item: structuredClone(data.rows.get(rowKey(key.PK, key.SK))) };
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      return { Items: structuredClone([...data.rows.values()].filter(row => row.PK === values[':pk'] && row.SK.startsWith(values[':prefix']))) };
    }
    assert.fail(`Read-only recommendation checks must not issue ${calls.at(-1)}.`);
  });
  t.mock.method(S3Client.prototype, 'send', async () => { assert.fail('Use the checked-in catalog; do not call S3.'); });
  t.mock.method(BedrockRuntimeClient.prototype, 'send', async () => { assert.fail('Reading guidance must not invoke a model.'); });
  t.after(() => assert.ok(calls.every(name => name === 'GetCommand' || name === 'QueryCommand'), 'No database writes are allowed.'));
  return calls;
}
const event = (rawPath: string) => ({ rawPath, requestContext: { http: { method: 'GET' } } }) as APIGatewayProxyEventV2WithJWTAuthorizer;
async function mine(account: VerifiedAccount) { return await handleRecommendations(event('/api/school/recommendations/mine'), account) as Mine; }
const offsetDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

test('family expiry follows school midnight, including UTC and 23/25-hour DST days', async t => {
  const cases = [
    ['UTC', '2026-10-28T23:59:59.999Z', '2026-10-28'],
    ['UTC', '2026-10-29T00:00:00.000Z', '2026-10-29'],
    ['Asia/Kolkata', '2026-10-28T18:29:59.999Z', '2026-10-28'],
    ['Asia/Kolkata', '2026-10-28T18:30:00.000Z', '2026-10-29'],
    ['America/New_York', '2026-03-08T06:59:59.999Z', '2026-03-08'],
    ['America/New_York', '2026-03-08T07:00:00.000Z', '2026-03-08'],
    ['America/New_York', '2026-03-09T03:59:59.999Z', '2026-03-08'],
    ['America/New_York', '2026-03-09T04:00:00.000Z', '2026-03-09'],
    ['America/New_York', '2026-11-01T05:59:59.999Z', '2026-11-01'],
    ['America/New_York', '2026-11-01T06:00:00.000Z', '2026-11-01'],
    ['America/New_York', '2026-11-02T04:59:59.999Z', '2026-11-01'],
    ['America/New_York', '2026-11-02T05:00:00.000Z', '2026-11-02'],
  ];
  for (const [timeZone, instant, today] of cases) await t.test(`${timeZone} at ${instant}`, async childTest => {
    const data = fixture(timeZone); mockReads(childTest, data, instant);
    data.addRecommendation('Yesterday', offsetDate(today, -1));
    const dueToday = data.addRecommendation('Today', today);
    const future = data.addRecommendation('Future', offsetDate(today, 1));
    const undated = data.addRecommendation('At your pace', null);
    const group = (await mine(student)).student[0];
    assert.equal(group.timeZone, timeZone); assert.equal(group.localToday, today);
    assert.deepEqual(group.recommendations.map(item => item.id), [dueToday.id, future.id, undated.id]);
  });
});

test('linked parent and student receive the same safe projection, excluding another child’s guidance', async t => {
  const data = fixture(); mockReads(t, data, '2026-10-28T19:00:00Z');
  const visible = data.addRecommendation('Today', '2026-10-29', 1, { type: 'student', studentId: childId });
  data.addRecommendation('Another child', '2026-10-29', 1, { type: 'student', studentId: 'another-child' });
  const studentData = await mine(student); const parentData = await mine(parent);
  assert.equal(studentData.studentStatus, 'linked'); assert.equal(parentData.studentStatus, 'missing');
  assert.deepEqual(parentData.parent, studentData.student);
  assert.deepEqual(studentData.student[0].recommendations, [{ id: visible.id, chapterId: chapter.id, mode: 'revise', kind: 'assignment', date: '2026-10-29', title: visible.title, reason: visible.reason }]);
  const body = JSON.stringify(parentData);
  for (const privateValue of [student.email, parent.email, teacher.email, teacher.id, 'Private classroom note.', 'Private extracted phrase.', 'Private evidence.', 'another-child']) assert.equal(body.includes(privateValue), false, `Do not expose ${privateValue}`);
});

test('stale discovery indexes do not grant unrelated or revoked parents access', async t => {
  const data = fixture(); mockReads(t, data, '2026-10-28T19:00:00Z');
  data.addRecommendation('Today', '2026-10-29');
  const unrelated: VerifiedAccount = { id: 'unrelated-account', email: 'unrelated@example.test', emailVerified: true };
  data.addIndex(unrelated, 'PARENT');
  for (const account of [unrelated, parent]) {
    if (account === parent) data.child.parentEmails = [];
    assert.deepEqual(await mine(account), { studentStatus: 'missing', student: [], parent: [] });
    await assert.rejects(requireFamilyChild(account, schoolId, classId, childId, 'parent'), error => error instanceof SchoolError && error.status === 403 && error.code === 'CHILD_ACCESS_DENIED');
  }
});

test('family listing rechecks a link revoked after initial discovery', async t => {
  const data = fixture(); let childReads = 0;
  mockReads(t, data, '2026-10-28T19:00:00Z', key => {
    if (key.PK === data.child.PK && key.SK === data.child.SK && ++childReads === 2) data.child.parentEmails = [];
  });
  data.addRecommendation('Today', '2026-10-29');
  await assert.rejects(mine(parent), error => error instanceof SchoolError && error.status === 403 && error.code === 'CHILD_ACCESS_DENIED');
  assert.equal(childReads, 2);
});

test('family dates use the school context from the current-link recheck', async t => {
  const data = fixture('UTC'); let schoolReads = 0;
  mockReads(t, data, '2026-10-28T19:00:00Z', key => {
    if (key.PK === data.school.PK && key.SK === data.school.SK && ++schoolReads === 2) data.school.timeZone = 'Asia/Kolkata';
  });
  data.addRecommendation('UTC today but school yesterday', '2026-10-28');
  const current = data.addRecommendation('School today', '2026-10-29');
  const group = (await mine(parent)).parent[0];
  assert.equal(group.timeZone, 'Asia/Kolkata'); assert.equal(group.localToday, '2026-10-29');
  assert.deepEqual(group.recommendations.map(item => item.id), [current.id]);
});

test('corrected guidance is omitted while its active replacement is retained', async t => {
  const data = fixture(); mockReads(t, data, '2026-10-28T19:00:00Z');
  data.addRecommendation('Old revision', '2026-10-30', 1);
  const current = data.addRecommendation('Current revision', '2026-10-30', 2); data.log.version = 2;
  assert.deepEqual((await mine(student)).student[0].recommendations.map(item => item.id), [current.id]);
});

test('past family guidance retains teacher history and is not marked superseded just because its date passed', async t => {
  const data = fixture(); mockReads(t, data, '2026-10-28T19:00:00Z');
  const old = data.addRecommendation('Old revision', '2026-10-27', 1);
  const current = data.addRecommendation('Current revision', '2026-10-28', 2); data.log.version = 2;
  data.put(`RECOMMENDATION#${current.id}`, `ACTIVITY#${childId}#${student.id}`, {
    studentId: childId, accountId: student.id, studentEmailHash: digest(student.email),
    startedAt: '2026-10-28T09:00:00Z', completedCards: new Set([revisionCards[0].id]),
  });
  assert.deepEqual((await mine(student)).student[0].recommendations, []);
  const report = await handleRecommendations(event(`/api/school/recommendations/${schoolId}/${classId}/logs/${logId}/results`), teacher) as {
    recommendations: { id: string; superseded: boolean; learners: { results: { completed?: number; total?: number }[] }[] }[];
  };
  assert.equal(report.recommendations.find(item => item.id === old.id)?.superseded, true);
  const currentHistory = report.recommendations.find(item => item.id === current.id);
  assert.equal(currentHistory?.superseded, false);
  assert.equal(currentHistory?.learners[0].results[0].completed, 1);
  assert.equal(currentHistory?.learners[0].results[0].total, revisionCards.length);
});
