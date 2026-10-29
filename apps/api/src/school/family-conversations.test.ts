import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { test, type TestContext } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { handleCommunication } from './communication.js';
import { SchoolError, type VerifiedAccount } from './index.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = uuid(1); const classroom = uuid(2); const child = uuid(3); const otherChild = uuid(4); const updateId = uuid(5);
const teacher: VerifiedAccount = { id: uuid(10), email: 'teacher@example.test', emailVerified: true };
const otherTeacher: VerifiedAccount = { id: uuid(11), email: 'otherteacher@example.test', emailVerified: true };
const admin: VerifiedAccount = { id: uuid(12), email: 'admin@example.test', emailVerified: true };
const parent: VerifiedAccount = { id: uuid(13), email: 'priya@example.test', emailVerified: true };
const secondParent: VerifiedAccount = { id: uuid(14), email: 'secondparent@example.test', emailVerified: true };
const unrelated: VerifiedAccount = { id: uuid(15), email: 'kabirparent@example.test', emailVerified: true };
const student: VerifiedAccount = { id: uuid(16), email: 'anika@example.test', emailVerified: true };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const family = `/api/school/family/parent/${school}/${classroom}/${child}`;
const staff = `/api/school/schools/${school}/classes/${classroom}`;
const commPK = `COMM#${school}#${classroom}`;
const rosterPK = `CLASS#${school}#${classroom}`;
const rejects = (code: string) => (issue: unknown) => issue instanceof SchoolError && issue.code === code;

function harness(t: TestContext) {
  const priorTable = process.env.TABLE_NAME; process.env.TABLE_NAME = 'test-r14-family';
  t.after(() => { if (priorTable === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = priorTable; });
  t.mock.method(SESv2Client.prototype, 'send', async () => assert.fail('Family interactions must not send email.'));
  t.mock.method(CognitoIdentityProviderClient.prototype, 'send', async () => assert.fail('Family names must not mutate Cognito.'));
  const rows = new Map<string, Record<string, any>>();
  const key = (PK: string, SK: string) => JSON.stringify([PK, SK]);
  const store = (PK: string, SK: string, value: Record<string, any>) => rows.set(key(PK, SK), structuredClone({ ...value, PK, SK }));
  const read = (PK: string, SK: string) => rows.get(key(PK, SK));
  store(`SCHOOL#${school}`, 'META', { id: school, adminId: admin.id, name: 'Amaltas Public School', timeZone: 'Asia/Kolkata' });
  store(`SCHOOL#${school}`, `CLASS#${classroom}`, { id: classroom, name: 'Class 4B', subject: 'EVS', teacherEmails: [teacher.email, otherTeacher.email], version: 1 });
  for (const person of [teacher, otherTeacher]) store(`SCHOOL#${school}`, `TEACHER#${hash(person.email)}`, { email: person.email, name: person === teacher ? 'Ms Kavita Nair' : 'Other Teacher', active: true, version: 1 });
  const roster = { id: child, name: 'Anika Rao', studentEmail: student.email, parentEmails: [parent.email, secondParent.email], version: 1, active: true };
  store(rosterPK, `STUDENT#${child}`, roster);
  store(rosterPK, `STUDENT#${otherChild}`, { ...roster, id: otherChild, name: 'Kabir Joshi', studentEmail: 'kabir@example.test', parentEmails: [unrelated.email] });
  for (const [email, kind, studentId] of [[student.email, 'STUDENT', child], [parent.email, 'PARENT', child], [secondParent.email, 'PARENT', child], [unrelated.email, 'PARENT', otherChild]]) store(`SCHOOL_EMAIL#${hash(email)}`, `${kind}#${school}#${classroom}#${studentId}`, { schoolId: school, classId: classroom, studentId });
  for (const [person, displayName] of [[parent, 'Priya Rao'], [secondParent, 'Arun Rao'], [unrelated, 'Other Parent']] as const) store(`USER#${person.id}`, 'FAMILY_PROFILE', { displayName, version: 1, updatedAt: '2026-10-29T00:00:00.000Z' });
  const update = { id: updateId, schoolId: school, classId: classroom, authorId: teacher.id, authorEmail: teacher.email, authorName: 'Ms Kavita Nair', audience: 'student', studentId: child, text: 'Please practise Our Earth together.', logId: null, version: 1, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z' };
  store(commPK, `UPDATE#${updateId}`, update);
  let writes = 0;
  let beforeWrite: (() => void) | undefined;
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: structuredClone(read(command.input.Key!.PK, command.input.Key!.SK)) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      return { Items: structuredClone([...rows.values()].filter(row => row.PK === values[':pk'] && (!values[':prefix'] || row.SK.startsWith(values[':prefix'])))) };
    }
    assert(command instanceof TransactWriteCommand);
    const operations = command.input.TransactItems || [];
    const hook = beforeWrite; beforeWrite = undefined; hook?.();
    for (const operation of operations) {
      const item = operation.Put || operation.ConditionCheck;
      assert(item, 'Only reviewed puts and canonical condition checks are expected.');
      const itemKey = 'Item' in item ? item.Item! : item.Key!;
      const current = read(itemKey.PK, itemKey.SK);
      const valid = (item.ConditionExpression || '').split(' AND ').filter(Boolean).every(clause => {
        const missing = clause.match(/^attribute_not_exists\(([^)]+)\)$/);
        if (missing) return current?.[missing[1]] === undefined;
        const exists = clause.match(/^attribute_exists\(([^)]+)\)$/);
        if (exists) return current?.[exists[1]] !== undefined;
        const [field, value] = clause.split(' = ');
        assert(value, `Unexpected condition: ${clause}`);
        return isDeepStrictEqual(current?.[item.ExpressionAttributeNames?.[field] || field], item.ExpressionAttributeValues?.[value]);
      });
      if (!valid) throw Object.assign(new Error('Conditional conflict'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
    }
    for (const operation of operations) if (operation.Put) store(operation.Put.Item!.PK, operation.Put.Item!.SK, operation.Put.Item!);
    writes++;
    return {};
  });
  async function call(user: VerifiedAccount, method: string, path: string, body?: unknown) {
    const event = { rawPath: path, requestContext: { http: { method } }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) } as APIGatewayProxyEventV2WithJWTAuthorizer;
    const response = await handleCommunication(event, user) as { statusCode: number; body: string };
    assert(response); return { status: response.statusCode, ...JSON.parse(response.body) };
  }
  return { rows, store, read, call, update, writes: () => writes, race: (hook: () => void) => { beforeWrite = hook; } };
}

test('acknowledgement, named replies and observed cursors make the round trip without GET writes or a lost new message', async t => {
  const h = harness(t);
  assert.equal((await h.call(parent, 'GET', `${family}/unread`)).unreadCount, 1);
  const updates = await h.call(parent, 'GET', `${family}/updates`);
  assert.equal(updates.updates[0].isUnread, true); assert.equal(updates.updates[0].observedVersion, 1);
  assert.equal(h.writes(), 0);
  const responses = await Promise.all([h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 }), h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 })]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 201]);
  assert(responses.every(result => result.thread.observedSequence === 1 && result.thread.acknowledgement?.sequence === 1));
  const threadId = responses[0].thread.id;
  assert.equal(responses[0].acknowledgement.parentName, 'Priya Rao');
  assert.equal(h.read(commPK, `THREAD#${threadId}`)!.activitySequence, 1);
  assert.equal([...h.rows.values()].filter(row => row.SK.startsWith('ACK#')).length, 1);
  assert.equal([...h.rows.values()].filter(row => row.SK.startsWith('MESSAGE#')).length, 0, 'Acknowledgement never invents a message.');
  assert.equal((await h.call(teacher, 'GET', `${staff}/unread`)).unreadCount, 1);
  await h.call(parent, 'POST', `${family}/updates/${updateId}/read`, { observedVersion: 1 });
  assert.equal((await h.call(parent, 'GET', `${family}/unread`)).unreadCount, 0, 'Own acknowledgement is not unread.');
  const first = await h.call(parent, 'POST', `${family}/threads`, { updateId, clientId: uuid(20), text: 'We will practise together.' });
  assert.equal(first.thread.id, threadId); assert.equal(first.message.authorName, 'Priya Rao'); assert.equal(first.message.sequence, 2);
  const observed = await h.call(teacher, 'GET', `${staff}/threads/${threadId}/messages`);
  assert.equal(observed.thread.observedSequence, 2); assert.equal(observed.thread.unreadCount, 2);
  await h.call(parent, 'POST', `${family}/threads/${threadId}/messages`, { clientId: uuid(21), text: 'One more question.' });
  await h.call(teacher, 'POST', `${staff}/threads/${threadId}/read`, { observedSequence: observed.thread.observedSequence });
  assert.equal((await h.call(teacher, 'GET', `${staff}/unread`)).unreadCount, 1, 'A message arriving after rendering stays unread.');
  assert.equal((await h.call(teacher, 'POST', `${staff}/threads/${threadId}/read`, { observedSequence: 1 })).readSequence, 2, 'Older reads never regress.');
  const reply = await h.call(teacher, 'POST', `${staff}/threads/${threadId}/messages`, { clientId: uuid(22), text: 'Thank you for helping Anika.' });
  assert.equal(reply.message.sequence, 4); assert.equal(reply.message.authorName, 'Ms Kavita Nair');
  assert.equal((await h.call(parent, 'GET', `${family}/unread`)).unreadActivities, 1);
  const parentView = await h.call(parent, 'GET', `${family}/threads/${threadId}/messages`);
  assert.deepEqual(parentView.messages.map((message: any) => message.isUnread), [false, false, true]);
  await h.call(parent, 'POST', `${family}/threads/${threadId}/read`, { observedSequence: parentView.thread.observedSequence });
  assert.equal((await h.call(parent, 'GET', `${family}/unread`)).unreadCount, 0);
  assert.equal((await h.call(teacher, 'POST', `${staff}/threads/${threadId}/messages`, { clientId: uuid(22), text: 'Thank you for helping Anika.' })).status, 200);
  assert.equal(h.read(commPK, `THREAD#${threadId}`)!.activitySequence, 4);
  await assert.rejects(h.call(parent, 'POST', `${family}/threads/${threadId}/read`, { observedSequence: 999 }), rejects('OBSERVATION_CHANGED'));
  const count = h.writes(); await h.call(teacher, 'GET', `${staff}/threads`); await h.call(parent, 'GET', `${family}/updates`); assert.equal(h.writes(), count);
});

test('acknowledgements bind exact update revisions; correction and concurrent read remain unread', async t => {
  const h = harness(t);
  const ack = await h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 });
  const threadId = ack.thread.id;
  await h.call(parent, 'POST', `${family}/updates/${updateId}/read`, { observedVersion: 1 });
  h.store(commPK, `UPDATE#${updateId}`, { ...h.update, version: 2, text: 'Corrected feedback.', updatedAt: '2026-10-29T01:00:00.000Z' });
  const corrected = (await h.call(parent, 'GET', `${family}/updates`)).updates[0];
  assert.equal(corrected.isUnread, true); assert.equal(corrected.acknowledgement, null);
  await assert.rejects(h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 }), rejects('UPDATE_CHANGED'));
  const second = await h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 2 });
  assert.equal(second.thread.id, threadId); assert.equal(second.acknowledgement.updateVersion, 2);
  assert.deepEqual(second.thread.acknowledgements.map((value: any) => value.updateVersion), [1, 2]);
  const staffUpdate = (await h.call(teacher, 'GET', `${staff}/updates`)).updates[0];
  assert.deepEqual(staffUpdate.acknowledgements.map((value: any) => value.updateVersion), [1, 2]);
  assert(staffUpdate.acknowledgements.every((value: any) => value.threadId === threadId && value.childId === child && value.childName === 'Anika Rao'));
  h.race(() => h.store(commPK, `UPDATE#${updateId}`, { ...h.update, version: 3, text: 'A later correction.' }));
  await h.call(parent, 'POST', `${family}/updates/${updateId}/read`, { observedVersion: 2 });
  assert.equal((await h.call(parent, 'GET', `${family}/updates`)).updates[0].isUnread, true);
  assert.equal((await h.call(parent, 'GET', `${family}/threads/${threadId}/messages`)).thread.acknowledgement, null);
});

test('two parents have separate threads; other staff, administrators, children and stale links receive no private activity', async t => {
  const h = harness(t);
  const priya = await h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 });
  const arun = await h.call(secondParent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 });
  assert.notEqual(priya.thread.id, arun.thread.id);
  assert.equal((await h.call(parent, 'GET', `${family}/threads`)).threads.length, 1);
  assert.equal((await h.call(secondParent, 'GET', `${family}/threads`)).threads[0].parentName, 'Arun Rao');
  await assert.rejects(h.call(parent, 'GET', `${family}/threads/${arun.thread.id}/messages`), rejects('THREAD_ACCESS_DENIED'));
  for (const viewer of [otherTeacher, admin]) {
    await assert.rejects(h.call(viewer, 'GET', `${staff}/threads/${priya.thread.id}/messages`), rejects('THREAD_ACCESS_DENIED'));
    await assert.rejects(h.call(viewer, 'POST', `${staff}/threads/${priya.thread.id}/read`, { observedSequence: 1 }), rejects('THREAD_ACCESS_DENIED'));
    assert.equal((await h.call(viewer, 'GET', `${staff}/unread`)).unreadCount, 0);
    assert.equal('acknowledgements' in (await h.call(viewer, 'GET', `${staff}/updates`)).updates[0], false);
  }
  await assert.rejects(h.call(unrelated, 'GET', `${family}/unread`), rejects('CHILD_ACCESS_DENIED'));
  await assert.rejects(h.call(student, 'GET', family.replace('/parent/', '/student/') + '/unread'), rejects('PARENT_REQUIRED'));
  await assert.rejects(h.call(student, 'POST', family.replace('/parent/', '/student/') + `/updates/${updateId}/acknowledgement`, { observedVersion: 1 }), rejects('PARENT_REQUIRED'));
  const studentUpdate = (await h.call(student, 'GET', family.replace('/parent/', '/student/') + '/updates')).updates[0];
  for (const field of ['acknowledgements', 'acknowledgement', 'isUnread', 'threadId']) assert.equal(field in studentUpdate, false);
  const roster = h.read(rosterPK, `STUDENT#${child}`)!;
  h.store(rosterPK, `STUDENT#${child}`, { ...roster, parentEmails: [secondParent.email], version: 2 });
  await assert.rejects(h.call(parent, 'GET', `${family}/threads/${priya.thread.id}/messages`), rejects('CHILD_ACCESS_DENIED'));
  await assert.rejects(h.call(teacher, 'GET', `${staff}/threads/${priya.thread.id}/messages`), rejects('CHILD_ACCESS_DENIED'));
  assert.deepEqual((await h.call(teacher, 'GET', `${staff}/threads`)).threads.map((value: any) => value.id), [arun.thread.id]);
});

test('canonical roster, author membership and update conditions block writes racing authorization', async t => {
  for (const kind of ['roster', 'staff', 'update'] as const) await t.test(kind, async sub => {
    const h = harness(sub);
    h.race(() => {
      if (kind === 'roster') h.store(rosterPK, `STUDENT#${child}`, { ...h.read(rosterPK, `STUDENT#${child}`), parentEmails: [], version: 2 });
      if (kind === 'staff') h.store(`SCHOOL#${school}`, `TEACHER#${hash(teacher.email)}`, { ...h.read(`SCHOOL#${school}`, `TEACHER#${hash(teacher.email)}`), active: false });
      if (kind === 'update') h.store(commPK, `UPDATE#${updateId}`, { ...h.update, version: 2, text: 'Changed before commit.' });
    });
    await assert.rejects(h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 }), (issue: unknown) => issue instanceof SchoolError);
    assert.equal([...h.rows.values()].some(row => row.SK.startsWith('ACK#') || row.SK.startsWith('THREAD#')), false);
  });
});

test('family profile is account-owned, parent-only and versioned; a name is required before new activity', async t => {
  const h = harness(t); h.rows.delete(JSON.stringify([`USER#${parent.id}`, 'FAMILY_PROFILE']));
  assert.equal((await h.call(parent, 'GET', '/api/school/family/profile')).profile, null);
  await assert.rejects(h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 }), rejects('FAMILY_NAME_REQUIRED'));
  await assert.rejects(h.call(parent, 'POST', `${family}/threads`, { updateId, clientId: uuid(20), text: 'Reply.' }), rejects('FAMILY_NAME_REQUIRED'));
  const saved = await h.call(parent, 'PUT', '/api/school/family/profile', { displayName: '  Priya Rao  ', version: 0 });
  assert.equal(saved.profile.displayName, 'Priya Rao'); assert.equal(saved.profile.version, 1);
  assert.equal(h.read(`USER#${secondParent.id}`, 'FAMILY_PROFILE')!.displayName, 'Arun Rao');
  await assert.rejects(h.call(parent, 'PUT', '/api/school/family/profile', { displayName: 'New name', version: 0 }), rejects('PROFILE_CHANGED'));
  await assert.rejects(h.call(parent, 'PUT', '/api/school/family/profile', { displayName: 'New name', version: 1, accountId: secondParent.id }), rejects('INVALID_FIELDS'));
  await assert.rejects(h.call(parent, 'PUT', '/api/school/family/profile', { displayName: 'a'.repeat(101), version: 1 }), rejects('INVALID_FIELD'));
  await assert.rejects(h.call(student, 'PUT', '/api/school/family/profile', { displayName: 'Student', version: 0 }), rejects('PARENT_REQUIRED'));
  await assert.rejects(h.call({ ...parent, emailVerified: false }, 'GET', '/api/school/family/profile'), rejects('EMAIL_NOT_VERIFIED'));
});

test('legacy threads retain messages and resolve parent names without unread floods or migration', async t => {
  const h = harness(t);
  const threadId = hash([school, classroom, child, parent.id, teacher.id, updateId].join(':'));
  const thread = { id: threadId, schoolId: school, classId: classroom, childId: child, parentId: parent.id, parentEmail: parent.email, teacherId: teacher.id, teacherEmail: teacher.email, teacherName: 'Ms Kavita Nair', updateId, createdAt: '2026-10-27T00:00:00.000Z' };
  h.store(commPK, `THREAD#${threadId}`, thread);
  h.store(`THREAD#${school}#${classroom}#${threadId}`, `MESSAGE#${uuid(20)}`, { id: uuid(20), text: 'Historical reply.', authorId: parent.id, authorRole: 'parent', authorName: 'Parent', createdAt: '2026-10-28T00:00:00.000Z' });
  const old = await h.call(teacher, 'GET', `${staff}/threads/${threadId}/messages`);
  assert.equal(old.thread.observedSequence, 0); assert.equal(old.thread.unreadCount, 0);
  assert.equal(old.thread.latestActivityAt, '2026-10-28T00:00:00.000Z');
  assert.equal(old.messages[0].authorName, 'Priya Rao'); assert.equal(old.messages[0].sequence, 0); assert.equal(old.messages[0].isUnread, false);
  assert.equal(h.writes(), 0);
  await h.call(teacher, 'POST', `${staff}/threads/${threadId}/read`, { observedSequence: 0 });
  assert.equal(h.read(`USER#${teacher.id}`, `FAMILY_THREAD_READ#${school}#${classroom}#${threadId}`)!.readSequence, 0);
  const reply = await h.call(parent, 'POST', `${family}/threads/${threadId}/messages`, { clientId: uuid(21), text: 'A new reply.' });
  assert.equal(reply.message.sequence, 1);
  assert.equal((await h.call(teacher, 'GET', `${staff}/threads/${threadId}/messages`)).messages.length, 2);
  assert.equal((await h.call(teacher, 'GET', `${staff}/unread`)).unreadCount, 1);
});

test('concurrent replies allocate distinct sequences and concurrent cursors keep the highest observed sequence', async t => {
  const h = harness(t);
  const initial = await h.call(parent, 'POST', `${family}/updates/${updateId}/acknowledgement`, { observedVersion: 1 });
  const threadId = initial.thread.id;
  const replies = await Promise.all([
    h.call(parent, 'POST', `${family}/threads/${threadId}/messages`, { clientId: uuid(20), text: 'First line.\nSecond line.' }),
    h.call(parent, 'POST', `${family}/threads/${threadId}/messages`, { clientId: uuid(21), text: 'A simultaneous reply.' }),
  ]);
  assert.deepEqual(replies.map(reply => reply.message.sequence).sort(), [2, 3]);
  assert.equal(h.read(commPK, `THREAD#${threadId}`)!.activitySequence, 3);
  await Promise.all([
    h.call(teacher, 'POST', `${staff}/threads/${threadId}/read`, { observedSequence: 2 }),
    h.call(teacher, 'POST', `${staff}/threads/${threadId}/read`, { observedSequence: 3 }),
  ]);
  assert.equal(h.read(`USER#${teacher.id}`, `FAMILY_THREAD_READ#${school}#${classroom}#${threadId}`)!.readSequence, 3);
  assert.equal((await h.call(teacher, 'GET', `${staff}/unread`)).unreadCount, 0);
});
