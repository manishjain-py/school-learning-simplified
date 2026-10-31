import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handleSchool, type VerifiedAccount } from './index.js';

type Row = Record<string, any>;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const account: VerifiedAccount = { id: uuid(10), email: 'teacher@example.test', emailVerified: true };
const otherAdmin = uuid(11);
const event = { rawPath: '/api/school/workspaces', requestContext: { http: { method: 'GET' } } } as APIGatewayProxyEventV2WithJWTAuthorizer;

function harness(t: TestContext) {
  const previous = process.env.TABLE_NAME; process.env.TABLE_NAME = 'test-school-workspaces';
  t.after(() => { if (previous === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = previous; });
  const rows: Row[] = [];
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    if (command instanceof GetCommand) return { Item: structuredClone(rows.find((row) => row.PK === command.input.Key!.PK && row.SK === command.input.Key!.SK)) };
    assert.ok(command instanceof QueryCommand, 'Listing workspaces only reads.');
    const values = command.input.ExpressionAttributeValues!;
    // Like DynamoDB, a query returns rows in sort-key order.
    return { Items: structuredClone(rows.filter((row) => row.PK === values[':pk'] && row.SK.startsWith(values[':prefix'] || '')).sort((a, b) => a.SK.localeCompare(b.SK))) };
  });
  function school(id: string, createdAt: string, adminId: string) {
    rows.push({ PK: `SCHOOL#${id}`, SK: 'META', id, name: `School ${id.slice(-2)}`, timeZone: 'Asia/Kolkata', createdAt, adminId });
    if (adminId === account.id) rows.push({ PK: `USER#${account.id}`, SK: `SCHOOL#${id}`, schoolId: id });
  }
  function teacherAt(schoolId: string) {
    rows.push({ PK: `SCHOOL#${schoolId}`, SK: `TEACHER#${hash(account.email)}`, email: account.email, name: 'Ms Teacher', active: true, version: 1 });
    rows.push({ PK: `SCHOOL_EMAIL#${hash(account.email)}`, SK: `TEACHER#${schoolId}`, schoolId });
  }
  function schoolClass(schoolId: string, classId: string, teacherEmails: string[]) {
    rows.push({ PK: `SCHOOL#${schoolId}`, SK: `CLASS#${classId}`, id: classId, name: 'Class 4A', subject: 'EVS', teacherEmails, version: 1 });
  }
  async function order() {
    const response = await handleSchool(event, account) as { statusCode: number; body: string };
    assert.equal(response.statusCode, 200);
    const { staff } = JSON.parse(response.body) as { staff: Row[] };
    for (const item of staff) assert.deepEqual(Object.keys(item).sort(), ['role', 'school'], 'The workspace list keeps its shape.');
    return staff.map((item) => [item.school.id, item.role]);
  }
  return { school, teacherAt, schoolClass, order };
}

test('a teacher opens the school where they teach, not a newer school they registered', async t => {
  const data = harness(t);
  // The newer school's id sorts first, and administered schools used to be listed first.
  const teaching = uuid(3); const registered = uuid(1);
  data.school(teaching, '2026-10-01T00:00:00.000Z', otherAdmin); data.teacherAt(teaching); data.schoolClass(teaching, uuid(4), [account.email]);
  data.school(registered, '2026-10-30T00:00:00.000Z', account.id);
  assert.deepEqual(await data.order(), [[teaching, 'teacher'], [registered, 'admin']]);
  // A class in the newer school does not change the default: the longest-standing school wins the tie.
  data.schoolClass(registered, uuid(2), [account.email]);
  assert.deepEqual(await data.order(), [[teaching, 'teacher'], [registered, 'admin']]);
});

test('schools with classes this account can open come before older schools without any', async t => {
  const data = harness(t);
  const empty = uuid(5); const unassigned = uuid(6); const active = uuid(7);
  data.school(empty, '2026-09-01T00:00:00.000Z', account.id);
  // A teacher sees only assigned classes, so another teacher's class does not count.
  data.school(unassigned, '2026-09-15T00:00:00.000Z', otherAdmin); data.teacherAt(unassigned); data.schoolClass(unassigned, uuid(8), ['other@example.test']);
  data.school(active, '2026-10-01T00:00:00.000Z', account.id); data.schoolClass(active, uuid(9), []);
  assert.deepEqual(await data.order(), [[active, 'admin'], [empty, 'admin'], [unassigned, 'teacher']]);
});
