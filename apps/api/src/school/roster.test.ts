import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { test, type TestContext } from 'node:test';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handleSchool, linkedFamily, requireFamilyChild, type VerifiedAccount } from './index.js';

type Row = Record<string, any>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// The newer school's id sorts first, so any ordering by school age cannot come from id order.
const newerSchool = uuid(1); const newerClass = uuid(2);
const olderSchool = uuid(3); const olderClass = uuid(4); const olderSecondClass = uuid(5);
const olderAdmin: VerifiedAccount = { id: uuid(10), email: 'older-admin@example.test', emailVerified: true };
const newerAdmin: VerifiedAccount = { id: uuid(11), email: 'newer-admin@example.test', emailVerified: true };
const student: VerifiedAccount = { id: uuid(12), email: 'student@example.test', emailVerified: true };
const parent: VerifiedAccount = { id: uuid(13), email: 'parent@example.test', emailVerified: true };
const rosterPath = (schoolId: string, classId: string, studentId?: string) => `/api/school/schools/${schoolId}/classes/${classId}/roster${studentId ? `/${studentId}` : ''}`;

function harness(t: TestContext) {
  const previous = process.env.TABLE_NAME; process.env.TABLE_NAME = 'test-roster-guards';
  t.after(() => { if (previous === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = previous; });
  const rows = new Map<string, Row>();
  const key = (PK: string, SK: string) => JSON.stringify([PK, SK]);
  const store = (PK: string, SK: string, value: Row) => rows.set(key(PK, SK), structuredClone({ ...value, PK, SK }));
  store(`SCHOOL#${olderSchool}`, 'META', { id: olderSchool, name: 'Older School', timeZone: 'Asia/Kolkata', createdAt: '2026-10-01T00:00:00.000Z', adminId: olderAdmin.id });
  store(`SCHOOL#${newerSchool}`, 'META', { id: newerSchool, name: 'Newer School', timeZone: 'Asia/Kolkata', createdAt: '2026-10-30T00:00:00.000Z', adminId: newerAdmin.id });
  for (const [schoolId, classId, name] of [[olderSchool, olderClass, 'Class 4A'], [olderSchool, olderSecondClass, 'Class 4B'], [newerSchool, newerClass, 'Class 5A']]) store(`SCHOOL#${schoolId}`, `CLASS#${classId}`, { id: classId, name, subject: 'EVS', teacherEmails: [], version: 1 });
  let writes = 0;
  function allowed(operation: Row) {
    if (!operation.ConditionExpression) return true;
    const target = operation.Item || operation.Key; const current = rows.get(key(target.PK, target.SK));
    return operation.ConditionExpression.split(' AND ').every((clause: string) => {
      const missing = clause.match(/^attribute_not_exists\(([^)]+)\)$/);
      if (missing) return current?.[missing[1]] === undefined;
      const [field, value] = clause.split(' = '); assert.ok(value, `Unexpected condition: ${clause}`);
      return isDeepStrictEqual(current?.[operation.ExpressionAttributeNames?.[field] || field], operation.ExpressionAttributeValues?.[value]);
    });
  }
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: structuredClone(rows.get(key(command.input.Key!.PK, command.input.Key!.SK))) };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues!;
      // Like DynamoDB, a query returns rows in sort-key order.
      return { Items: structuredClone([...rows.values()].filter((row) => row.PK === values[':pk'] && row.SK.startsWith(values[':prefix'] || '')).sort((a, b) => a.SK.localeCompare(b.SK))) };
    }
    assert.ok(command instanceof TransactWriteCommand, 'Roster changes are written in one transaction.');
    const items = command.input.TransactItems as Row[];
    if (!items.every((item) => allowed(item.Put || item.Delete || item.ConditionCheck))) throw Object.assign(new Error('Condition changed'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
    for (const item of items) {
      if (item.Put) store(item.Put.Item.PK, item.Put.Item.SK, item.Put.Item);
      if (item.Delete) rows.delete(key(item.Delete.Key.PK, item.Delete.Key.SK));
    }
    writes++;
    return {};
  });
  async function call(user: VerifiedAccount, method: 'POST' | 'PUT', path: string, body: Row) {
    const response = await handleSchool({ rawPath: path, requestContext: { http: { method } }, body: JSON.stringify(body) } as APIGatewayProxyEventV2WithJWTAuthorizer, user) as { statusCode: number; body: string };
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }
  const enrol = (user: VerifiedAccount, schoolId: string, classId: string, studentEmail: string, parentEmails = [parent.email], name = 'Zoya Das') => call(user, 'POST', rosterPath(schoolId, classId), { name, studentEmail, parentEmails });
  const snapshot = () => structuredClone([...rows.entries()]);
  return { store, call, enrol, snapshot, writes: () => writes };
}

test('another school cannot enrol a student who is already enrolled, so their school link keeps working', async t => {
  const data = harness(t);
  const enrolled = await data.enrol(olderAdmin, olderSchool, olderClass, student.email);
  assert.equal(enrolled.status, 201); assert.equal(enrolled.body.warning, undefined);
  const before = data.snapshot(); const writes = data.writes();
  // Letter case and spaces do not get around the rule.
  const repeated = await data.enrol(newerAdmin, newerSchool, newerClass, ' Student@Example.TEST ');
  assert.equal(repeated.status, 409);
  assert.deepEqual(repeated.body, { error: 'STUDENT_AT_ANOTHER_SCHOOL', message: 'This student is already enrolled at another school.' });
  assert.deepEqual(data.snapshot(), before); assert.equal(data.writes(), writes, 'A refused enrolment writes nothing.');
  // A correction cannot move another record onto the enrolled email either.
  const other = await data.enrol(newerAdmin, newerSchool, newerClass, 'another-student@example.test', ['another-parent@example.test']);
  assert.equal(other.status, 201);
  const moved = await data.call(newerAdmin, 'PUT', rosterPath(newerSchool, newerClass, other.body.student.id), { name: 'Zoya Das', studentEmail: student.email, parentEmails: ['another-parent@example.test'], version: 1 });
  assert.equal(moved.status, 409); assert.equal(moved.body.error, 'STUDENT_AT_ANOTHER_SCHOOL');
  const links = await linkedFamily(student);
  assert.equal(links.student.status, 'linked');
  assert.deepEqual(links.student.children.map((child) => child.schoolId), [olderSchool]);
  assert.equal((await requireFamilyChild(student, olderSchool, olderClass, enrolled.body.student.id, 'student')).id, enrolled.body.student.id);
});

test('the same school can still record a student twice, with the existing duplicate warning', async t => {
  const data = harness(t);
  assert.equal((await data.enrol(olderAdmin, olderSchool, olderClass, student.email)).status, 201);
  const second = await data.enrol(olderAdmin, olderSchool, olderSecondClass, student.email);
  assert.equal(second.status, 201); assert.match(second.body.warning, /multiple roster records/);
});

test('a removed enrolment or a stale index row does not block another school', async t => {
  const data = harness(t);
  const enrolled = await data.enrol(olderAdmin, olderSchool, olderClass, student.email);
  assert.equal((await data.call(olderAdmin, 'PUT', rosterPath(olderSchool, olderClass, enrolled.body.student.id), { active: false, version: 1 })).status, 200);
  // Leave a stale discovery row behind; only the current roster record counts.
  data.store(`SCHOOL_EMAIL#${hash(student.email)}`, `STUDENT#${olderSchool}#${olderClass}#${enrolled.body.student.id}`, { schoolId: olderSchool, classId: olderClass, studentId: enrolled.body.student.id });
  assert.equal((await data.enrol(newerAdmin, newerSchool, newerClass, student.email)).status, 201);
  assert.deepEqual((await linkedFamily(student)).student.children.map((child) => child.schoolId), [newerSchool]);
});

test('across schools a student email cannot be reused as a parent email, or the reverse', async t => {
  const data = harness(t);
  assert.equal((await data.enrol(olderAdmin, olderSchool, olderClass, student.email, [parent.email])).status, 201);
  const parentAsStudent = await data.enrol(newerAdmin, newerSchool, newerClass, parent.email, ['guardian@example.test']);
  assert.equal(parentAsStudent.status, 409); assert.equal(parentAsStudent.body.error, 'PARENT_AT_ANOTHER_SCHOOL');
  const studentAsParent = await data.enrol(newerAdmin, newerSchool, newerClass, 'another-student@example.test', ['guardian@example.test', student.email]);
  assert.equal(studentAsParent.status, 409); assert.equal(studentAsParent.body.error, 'STUDENT_AT_ANOTHER_SCHOOL'); assert.match(studentAsParent.body.message, /parent email/);
  // The same check applies when a correction adds a parent email.
  const other = await data.enrol(newerAdmin, newerSchool, newerClass, 'another-student@example.test', ['guardian@example.test']);
  assert.equal(other.status, 201);
  const corrected = await data.call(newerAdmin, 'PUT', rosterPath(newerSchool, newerClass, other.body.student.id), { name: 'Zoya Das', studentEmail: 'another-student@example.test', parentEmails: ['guardian@example.test', student.email], version: 1 });
  assert.equal(corrected.status, 409); assert.equal(corrected.body.error, 'STUDENT_AT_ANOTHER_SCHOOL');
  assert.equal((await linkedFamily(parent)).student.status, 'missing');
  assert.deepEqual((await linkedFamily(student)).parent.children, []);
});

test('a parent can have children at different schools, and the longest-standing school stays first', async t => {
  const data = harness(t);
  assert.equal((await data.enrol(olderAdmin, olderSchool, olderClass, student.email, [parent.email], 'Zoya Das')).status, 201);
  assert.equal((await data.enrol(newerAdmin, newerSchool, newerClass, 'sibling@example.test', [parent.email], 'Kiran Das')).status, 201);
  const links = await linkedFamily(parent);
  assert.deepEqual(links.parent.children.map((child) => [child.schoolId, child.name]), [[olderSchool, 'Zoya Das'], [newerSchool, 'Kiran Das']]);
});

test('records that already share an email across schools can still be corrected or removed', async t => {
  const data = harness(t);
  const enrolled = await data.enrol(olderAdmin, olderSchool, olderClass, student.email);
  // A duplicate saved before this rule existed.
  const legacyId = uuid(20);
  data.store(`CLASS#${newerSchool}#${newerClass}`, `STUDENT#${legacyId}`, { id: legacyId, name: 'Zoya Das', studentEmail: student.email, parentEmails: [parent.email], version: 1, active: true });
  for (const [kind, email] of [['STUDENT', student.email], ['PARENT', parent.email]]) data.store(`SCHOOL_EMAIL#${hash(email)}`, `${kind}#${newerSchool}#${newerClass}#${legacyId}`, { schoolId: newerSchool, classId: newerClass, studentId: legacyId });
  assert.equal((await data.call(newerAdmin, 'PUT', rosterPath(newerSchool, newerClass, legacyId), { name: 'Zoya D.', studentEmail: student.email, parentEmails: [parent.email], version: 1 })).status, 200);
  assert.equal((await data.call(olderAdmin, 'PUT', rosterPath(olderSchool, olderClass, enrolled.body.student.id), { name: 'Zoya Das', studentEmail: student.email, parentEmails: [parent.email, 'second-parent@example.test'], version: 1 })).status, 200);
  assert.equal((await data.call(newerAdmin, 'PUT', rosterPath(newerSchool, newerClass, legacyId), { active: false, version: 2 })).status, 200);
  const links = await linkedFamily(student);
  assert.equal(links.student.status, 'linked'); assert.deepEqual(links.student.children.map((child) => child.schoolId), [olderSchool]);
});
