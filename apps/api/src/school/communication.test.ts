import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { handleCommunication } from './communication.js';
import { SchoolError, type VerifiedAccount } from './index.js';

const schoolId = '11111111-1111-4111-8111-111111111111';
const classId = '22222222-2222-4222-8222-222222222222';
const studentId = '33333333-3333-4333-8333-333333333333';
const draftId = '44444444-4444-4444-8444-444444444444';
const updateId = '55555555-5555-4555-8555-555555555555';
const newUpdateId = '66666666-6666-4666-8666-666666666666';
const teacher: VerifiedAccount = { id: 'teacher', email: 'teacher@example.test', emailVerified: true };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const base = `/api/school/schools/${schoolId}/classes/${classId}/updates`;
const event = (method: string, suffix = '', body?: unknown) => ({ rawPath: base + suffix, requestContext: { http: { method } }, body: body ? JSON.stringify(body) : undefined }) as APIGatewayProxyEventV2WithJWTAuthorizer;
const rejects = (code: string) => (issue: unknown) => issue instanceof SchoolError && issue.code === code;

test('feedback publication requires the reviewed draft generation while manual updates and old snapshots still work', async t => {
  const priorTable = process.env.TABLE_NAME; process.env.TABLE_NAME = 'test-parent-note-publication';
  t.after(() => { if (priorTable === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = priorTable; });
  const child = { id: studentId, name: 'Anika Rao', studentEmail: 'anika@example.test', parentEmails: ['parent@example.test'], version: 1, active: true };
  const activity = { chapterId: 'earth', cardId: 'rotation', chapterTitle: 'Our Earth', cardTitle: 'Rotation', href: '/learn/earth?card=rotation' };
  const published = { id: updateId, schoolId, classId, authorId: teacher.id, authorName: 'Teacher', audience: 'student', studentId, text: 'Previously edited and published text.', logId: null, version: 1, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', assistance: { draftId, language: 'en', activity } };
  const draft = { id: draftId, schoolId, classId, authorId: teacher.id, version: 7, attempt: 3, fields: { studentId, chapterId: 'earth', cardId: 'rotation', observation: 'Mixed up day and night.', language: 'en' }, childFingerprint: hash(JSON.stringify([child.id, child.name, child.studentEmail, [...child.parentEmails].sort(), child.version, child.active])), result: { status: 'ready', text: 'Newest generated text.' } };
  const rows = new Map<string, Record<string, any>>();
  const key = (PK: string, SK: string) => JSON.stringify([PK, SK]);
  const store = (PK: string, SK: string, value: Record<string, any>) => rows.set(key(PK, SK), { PK, SK, ...value });
  store(`SCHOOL#${schoolId}`, 'META', { id: schoolId, adminId: 'admin', timeZone: 'Asia/Kolkata' });
  store(`SCHOOL#${schoolId}`, `CLASS#${classId}`, { id: classId, teacherEmails: [teacher.email], version: 1 });
  store(`SCHOOL#${schoolId}`, `TEACHER#${hash(teacher.email)}`, { active: true, email: teacher.email, name: 'Teacher', version: 1 });
  store(`CLASS#${schoolId}#${classId}`, `STUDENT#${studentId}`, child);
  store(`PARENT_DRAFT#${schoolId}#${classId}`, `DRAFT#${draftId}`, draft);
  store(`COMM#${schoolId}#${classId}`, `UPDATE#${updateId}`, published);
  let writes = 0;
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: structuredClone(rows.get(key(command.input.Key!.PK, command.input.Key!.SK))) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      return { Items: [...rows.values()].filter(row => row.PK === values[':pk'] && row.SK.startsWith(values[':prefix'])) };
    }
    assert.ok(command instanceof TransactWriteCommand);
    writes++;
    for (const item of command.input.TransactItems || []) if (item.Put) store(item.Put.Item!.PK, item.Put.Item!.SK, item.Put.Item!);
    return {};
  });
  const request = { audience: 'student', studentId, text: 'A stale editor still holds these words.', draftId, clientId: newUpdateId };
  await assert.rejects(handleCommunication(event('POST', '', request), teacher), rejects('VERSION_REQUIRED'));
  await assert.rejects(handleCommunication(event('POST', '', { ...request, draftVersion: 4 }), teacher), rejects('DRAFT_CHANGED'));
  await assert.rejects(handleCommunication(event('PUT', `/${updateId}`, { ...request, version: 1, draftVersion: 4 }), teacher), rejects('DRAFT_CHANGED'));
  assert.equal(writes, 0, 'Missing or stale reviewed generation never writes UPDATE or UPDATEREV.');
  const response = await handleCommunication(event('GET'), teacher) as { body: string };
  const old = JSON.parse(response.body).updates[0];
  assert.equal(old.text, published.text); assert.deepEqual(old.assistance, published.assistance);
  assert.equal('observation' in old, false);
  const manual = await handleCommunication(event('POST', '', { audience: 'student', studentId, text: 'Manually written feedback.', clientId: newUpdateId }), teacher) as { statusCode: number; body: string };
  assert.equal(manual.statusCode, 201); assert.equal(writes, 1); assert.equal(JSON.parse(manual.body).update.assistance, undefined);
  assert.deepEqual(rows.get(key(`COMM#${schoolId}#${classId}`, `UPDATE#${updateId}`))?.assistance, published.assistance);
});
