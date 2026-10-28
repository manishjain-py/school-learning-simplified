import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { handleCommunication } from './communication.js';
import { SchoolError, type VerifiedAccount } from './index.js';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { isDeepStrictEqual } from 'node:util';

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
  const priorEnabled = process.env.PARENT_EMAIL_ENABLED; process.env.PARENT_EMAIL_ENABLED = 'false';
  t.after(() => { if (priorTable === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = priorTable; if (priorEnabled === undefined) delete process.env.PARENT_EMAIL_ENABLED; else process.env.PARENT_EMAIL_ENABLED = priorEnabled; });
  t.mock.method(SESv2Client.prototype, 'send', async () => { assert.fail('Disabled parent email must not send.'); });
  t.mock.method(CognitoIdentityProviderClient.prototype, 'send', async () => { assert.fail('Disabled parent email must not look up recipients.'); });
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
  assert.equal(manual.statusCode, 201); assert.equal(writes, 2); assert.equal(JSON.parse(manual.body).update.assistance, undefined);
  const notifications = [...rows.values()].filter(row => row.PK === `PARENT_EMAIL#${schoolId}#${classId}#${newUpdateId}`);
  assert.equal(notifications.length, 1); assert.equal(notifications[0].status, 'not_sent'); assert.equal(notifications[0].code, 'EMAIL_DISABLED');
  assert(!JSON.stringify(JSON.parse(manual.body).update).includes('parent@example.test'));
  assert.deepEqual(rows.get(key(`COMM#${schoolId}#${classId}`, `UPDATE#${updateId}`))?.assistance, published.assistance);

  const source = { chapter: { id: 'earth', title: 'Our Earth', description: 'Earth rotates.', subject: 'EVS' }, cards: [{ id: 'rotation', title: 'Rotation', kind: 'concept', partId: 'rotation', lines: [{ display: 'With an adult, gently turn an orange near a lamp.' }] }] };
  t.mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    assert(command instanceof GetObjectCommand);
    const data = command.input.Key!.endsWith('catalog.json') ? { chapters: [{ ...source.chapter, languages: ['en'], modes: ['learn'] }] } : { id: 'earth', language: 'en', cards: source.cards };
    return { Body: { transformToString: async () => JSON.stringify(data) } };
  });
  store(`PARENT_DRAFT#${schoolId}#${classId}`, `DRAFT#${draftId}`, { ...draft, contentFingerprint: hash(JSON.stringify(source)), result: { status: 'ready', text: 'Newest generated text.', language: 'en', activity: { chapterId: 'earth', cardId: 'rotation', chapterTitle: 'Our Earth', cardTitle: 'Rotation' } } });
  const assistedId = '77777777-7777-4777-8777-777777777777';
  const assisted = await handleCommunication(event('POST', '', { ...request, clientId: assistedId, draftVersion: 7, text: 'Teacher edited the generated draft.' }), teacher) as { statusCode: number; body: string };
  assert.equal(assisted.statusCode, 201); assert.equal(JSON.parse(assisted.body).update.assistance.draftVersion, 7);
  const assistedEmail = [...rows.values()].find(row => row.PK === `PARENT_EMAIL#${schoolId}#${classId}#${assistedId}`)!;
  assert.equal(assistedEmail.status, 'not_sent'); assert.equal(assistedEmail.code, 'EMAIL_DISABLED'); assert(assistedEmail.html.includes('Teacher edited the generated draft.'));
});

test('manual publication atomically guards child/staff/class changes and email storage failures cannot undo a committed update', async t => {
  const priorTable = process.env.TABLE_NAME; const priorEnabled = process.env.PARENT_EMAIL_ENABLED;
  process.env.TABLE_NAME = 'test-r5-publication'; process.env.PARENT_EMAIL_ENABLED = 'false';
  t.after(() => { if (priorTable === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = priorTable; if (priorEnabled === undefined) delete process.env.PARENT_EMAIL_ENABLED; else process.env.PARENT_EMAIL_ENABLED = priorEnabled; });
  const child = { id: studentId, name: 'Anika Rao', studentEmail: 'anika@example.test', parentEmails: ['parent@example.test'], version: 1, active: true };
  const key = (PK: string, SK: string) => JSON.stringify([PK, SK]);
  for (const race of ['child', 'teacher', 'class', 'school', 'delivery-store'] as const) {
    const rows = new Map<string, Record<string, any>>();
    const store = (PK: string, SK: string, value: Record<string, any>) => rows.set(key(PK, SK), structuredClone({ PK, SK, ...value }));
    store(`SCHOOL#${schoolId}`, 'META', { id: schoolId, adminId: 'admin', timeZone: 'Asia/Kolkata' });
    store(`SCHOOL#${schoolId}`, `CLASS#${classId}`, { id: classId, subject: 'EVS', teacherEmails: [teacher.email], version: 1 });
    store(`SCHOOL#${schoolId}`, `TEACHER#${hash(teacher.email)}`, { active: true, email: teacher.email, name: 'Teacher', version: 1 });
    store(`CLASS#${schoolId}#${classId}`, `STUDENT#${studentId}`, child);
    const mocked = t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: structuredClone(rows.get(key(command.input.Key!.PK, command.input.Key!.SK))) };
      if (command instanceof QueryCommand) { const values = command.input.ExpressionAttributeValues!; return { Items: [...rows.values()].filter(row => row.PK === values[':pk'] && row.SK.startsWith(values[':prefix'])) }; }
      assert(command instanceof TransactWriteCommand);
      const operations = command.input.TransactItems || [];
      const publication = operations.some(operation => operation.Put?.Item?.SK === `UPDATE#${newUpdateId}`);
      if (!publication && race === 'delivery-store') throw new Error('Delivery storage unavailable after publication');
      if (publication) {
        if (race === 'child') rows.get(key(`CLASS#${schoolId}#${classId}`, `STUDENT#${studentId}`))!.parentEmails = ['changed@example.test'];
        if (race === 'teacher') rows.get(key(`SCHOOL#${schoolId}`, `TEACHER#${hash(teacher.email)}`))!.active = false;
        if (race === 'class') rows.get(key(`SCHOOL#${schoolId}`, `CLASS#${classId}`))!.version++;
        if (race === 'school') rows.get(key(`SCHOOL#${schoolId}`, 'META'))!.adminId = 'different-admin';
      }
      for (const operation of operations) if (operation.ConditionCheck) {
        const check = operation.ConditionCheck; const current = rows.get(key(check.Key!.PK, check.Key!.SK));
        const matches = (check.ConditionExpression || '').split(' AND ').every(clause => {
          const [field, value] = clause.split(' = '); const name = check.ExpressionAttributeNames?.[field] || field;
          return isDeepStrictEqual(current?.[name], check.ExpressionAttributeValues?.[value]);
        });
        if (!matches) throw Object.assign(new Error('Conditional race'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
      }
      for (const operation of operations) if (operation.Put) store(operation.Put.Item!.PK, operation.Put.Item!.SK, operation.Put.Item!);
      return {};
    });
    const request = handleCommunication(event('POST', '', { audience: 'student', studentId, clientId: newUpdateId, text: 'Private manual feedback.' }), teacher);
    if (race === 'delivery-store') {
      const response = await request as { statusCode: number; body: string };
      assert.equal(response.statusCode, 201); assert.equal(JSON.parse(response.body).update.text, 'Private manual feedback.');
      assert(rows.has(key(`COMM#${schoolId}#${classId}`, `UPDATE#${newUpdateId}`)));
      assert([...rows.values()].some(row => row.PK.startsWith('PARENT_EMAIL#')));
    } else {
      await assert.rejects(request, rejects('RECORD_CHANGED'));
      assert.equal(rows.has(key(`COMM#${schoolId}#${classId}`, `UPDATE#${newUpdateId}`)), false);
      assert.equal(rows.has(key(`COMM#${schoolId}#${classId}`, `UPDATEREV#${newUpdateId}#000001`)), false);
      assert.equal([...rows.values()].some(row => row.PK.startsWith('PARENT_EMAIL#')), false);
    }
    mocked.mock.restore();
  }
});
