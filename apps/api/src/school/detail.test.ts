import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { handleSchool, type VerifiedAccount } from './index.js';

const schoolId = '11111111-1111-4111-8111-111111111111';
const teacher: VerifiedAccount = { id: 'teacher-account', email: 'Kavita@Example.test', emailVerified: true };
const member = { email: 'kavita@example.test', name: 'Ms Kavita Nair', active: true, version: 3 };
const other = { email: 'other@example.test', name: 'Other Teacher', active: true, version: 2 };
const inactive = { email: 'inactive@example.test', name: 'Inactive Teacher', active: false, version: 4 };
const school = { id: schoolId, name: 'School', adminId: 'admin-account', timeZone: 'Asia/Kolkata', createdAt: '2026-10-29' };
const assignedClass = { id: '22222222-2222-4222-8222-222222222222', name: 'Class 4B', subject: 'EVS', teacherEmails: [member.email], version: 1 };
const otherClass = { ...assignedClass, id: '33333333-3333-4333-8333-333333333333', name: 'Class 4C', teacherEmails: [other.email] };
const event = { rawPath: `/api/school/schools/${schoolId}`, requestContext: { http: { method: 'GET' } } } as APIGatewayProxyEventV2WithJWTAuthorizer;
const publicTeacher = ({ email, name, version }: typeof member) => ({ email, name, version });

test('school detail resolves only the current teacher name while admin retains its directory', async t => {
  const previous = process.env.TABLE_NAME; process.env.TABLE_NAME = 'test-school-detail';
  t.after(() => { if (previous === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = previous; });
  for (const role of ['teacher', 'admin', 'revoked', 'changed-email'] as const) await t.test(role, async sub => {
    let membershipReads = 0; const queries: string[] = [];
    const ownKey = `TEACHER#${createHash('sha256').update(member.email).digest('hex')}`;
    sub.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
      if (command instanceof GetCommand) {
        assert.equal(command.input.Key?.PK, `SCHOOL#${schoolId}`);
        assert.equal(command.input.ConsistentRead, true);
        if (command.input.Key?.SK === 'META') return { Item: school };
        assert.equal(command.input.Key?.SK, ownKey, 'A teacher may look up only their exact membership.');
        membershipReads++;
        // Revoke or change the canonical membership after the initial access check.
        if (membershipReads > 1 && role === 'revoked') return { Item: { ...member, active: false } };
        if (membershipReads > 1 && role === 'changed-email') return { Item: { ...member, email: other.email } };
        return { Item: member };
      }
      assert.ok(command instanceof QueryCommand, 'The read must not write or scan.');
      assert.equal(command.input.ExpressionAttributeValues?.[':pk'], `SCHOOL#${schoolId}`);
      const prefix = command.input.ExpressionAttributeValues?.[':prefix']; queries.push(prefix);
      if (prefix === 'CLASS#') return { Items: [assignedClass, otherClass] };
      assert.equal(role, 'admin', 'Only an administrator queries the staff directory.');
      assert.equal(prefix, 'TEACHER#'); return { Items: [member, other, inactive] };
    });
    const user = role === 'admin' ? { ...teacher, id: school.adminId } : teacher;
    const response = await handleSchool(event, user) as { statusCode: number; body: string };
    const body = JSON.parse(response.body);
    if (role === 'revoked' || role === 'changed-email') {
      assert.equal(response.statusCode, 403); assert.equal(body.error, 'SCHOOL_ACCESS_DENIED');
      assert.equal(body.teachers, undefined); assert.equal(body.classes, undefined);
    } else {
      assert.equal(response.statusCode, 200); assert.equal(body.role, role);
      assert.deepEqual(body.teachers, role === 'admin' ? [publicTeacher(member), publicTeacher(other)] : [publicTeacher(member)]);
      assert.deepEqual(body.classes, role === 'admin' ? [assignedClass, otherClass] : [assignedClass]);
      if (role === 'teacher') assert.equal(response.body.includes(other.email), false);
    }
    assert.deepEqual(queries, role === 'admin' ? ['CLASS#', 'TEACHER#'] : ['CLASS#']);
  });
});
