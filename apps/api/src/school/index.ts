import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

export type VerifiedAccount = { id: string; email: string; emailVerified: boolean };
export type RecordValue = Record<string, any>;
type School = { id: string; name: string; timeZone: string; createdAt: string; adminId: string };
type Teacher = { email: string; name: string; active: boolean; version: number };
type SchoolClass = { id: string; name: string; subject: string; teacherEmails: string[]; version: number };
export type Student = { id: string; name: string; studentEmail: string; parentEmails: string[]; version: number; active: boolean };
export type ChildLink = { id: string; schoolId: string; schoolName: string; timeZone: string; classId: string; className: string; name: string };
export type LearnerAccountBinding = { kind: 'learner-account'; schemaVersion: 1; schoolId: string; classId: string; studentId: string; accountId: string; emailHash: string; boundAt: string };
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-2' }));
const table = () => process.env.TABLE_NAME!;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const schoolPK = (schoolId: string) => `SCHOOL#${schoolId}`;
export const classPK = (schoolId: string, classId: string) => `CLASS#${schoolId}#${classId}`;
const emailPK = (email: string) => `SCHOOL_EMAIL#${hash(email)}`;
export const now = () => new Date().toISOString();

export class SchoolError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const fail = (status: number, code: string, message: string): never => { throw new SchoolError(status, code, message); };
export const json = (statusCode: number, data: unknown): APIGatewayProxyResultV2 => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(data) });
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) return fail(400, 'INVALID_FIELD', `Enter ${label} (up to ${max} characters).`);
  return value.trim();
}
export function normalizeEmail(value: unknown): string {
  const email = text(value, 'a valid email address', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'INVALID_EMAIL', 'Enter a complete email address.');
  return email;
}
export function id(value: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) return fail(404, 'NOT_FOUND', 'This school record could not be found.');
  return value;
}
export function bodyOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): RecordValue {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  if (raw.length > 16_000) return fail(413, 'TOO_LARGE', 'This school update is too large.');
  try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* Invalid request below. */ }
  return fail(400, 'INVALID_JSON', 'The school update could not be read.');
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail(400, 'VERSION_REQUIRED', 'Refresh this record before correcting it.');
  return Number(value);
}
export async function get<T>(PK: string, SK: string): Promise<T | null> {
  const result = await db.send(new GetCommand({ TableName: table(), Key: { PK, SK }, ConsistentRead: true }));
  return result.Item as T || null;
}
export async function query(PK: string, prefix: string): Promise<RecordValue[]> {
  const items: RecordValue[] = []; let cursor: RecordValue | undefined;
  do {
    const result = await db.send(new QueryCommand({ TableName: table(), KeyConditionExpression: prefix ? 'PK = :pk AND begins_with(SK, :prefix)' : 'PK = :pk', ExpressionAttributeValues: { ':pk': PK, ...(prefix ? { ':prefix': prefix } : {}) }, ConsistentRead: true, ExclusiveStartKey: cursor }));
    items.push(...(result.Items || [])); cursor = result.LastEvaluatedKey;
  } while (cursor);
  return items;
}
export const put = (PK: string, SK: string, value: RecordValue, expected?: number | 'new') => ({ Put: {
  TableName: table(), Item: { ...value, PK, SK },
  ...(expected === 'new' ? { ConditionExpression: 'attribute_not_exists(PK)' } : typeof expected === 'number' ? { ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': expected } } : {}),
} });
const remove = (PK: string, SK: string) => ({ Delete: { TableName: table(), Key: { PK, SK } } });
export async function write(items: NonNullable<TransactWriteCommandInput['TransactItems']>) {
  try { await db.send(new TransactWriteCommand({ TransactItems: items })); }
  catch (issue) {
    if ((issue as Error).name === 'TransactionCanceledException' && (issue as { CancellationReasons?: { Code?: string }[] }).CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict')) return fail(409, 'RECORD_CHANGED', 'This record changed in another session. Refresh it and try again.');
    throw issue;
  }
}
const publicSchool = (school: School) => ({ id: school.id, name: school.name, timeZone: school.timeZone, createdAt: school.createdAt });
const publicClass = (item: SchoolClass) => ({ id: item.id, name: item.name, subject: item.subject, teacherEmails: item.teacherEmails, version: item.version });
const publicTeacher = (item: Teacher) => ({ email: item.email, name: item.name, version: item.version });
const publicStudent = (item: Student) => ({ id: item.id, name: item.name, studentEmail: item.studentEmail, parentEmails: item.parentEmails, version: item.version });

/** Every staff request resolves the current membership; caller-supplied role/IDs never grant access. */
export async function requireSchoolStaff(user: VerifiedAccount, schoolId: string) {
  const school = await get<School>(schoolPK(id(schoolId)), 'META');
  if (!school) return fail(403, 'SCHOOL_ACCESS_DENIED', 'This school workspace is not available to your account.');
  if (school.adminId === user.id) return { school, role: 'admin' as const };
  const member = await get<Teacher>(schoolPK(schoolId), `TEACHER#${hash(normalizeEmail(user.email))}`);
  if (!member?.active || member.email !== normalizeEmail(user.email)) return fail(403, 'SCHOOL_ACCESS_DENIED', 'This school workspace is not available to your account.');
  return { school, role: 'teacher' as const };
}
export async function requireClassStaff(user: VerifiedAccount, schoolId: string, classId: string) {
  const context = await requireSchoolStaff(user, schoolId);
  const schoolClass = await get<SchoolClass>(schoolPK(schoolId), `CLASS#${id(classId)}`);
  if (!schoolClass || (context.role !== 'admin' && !schoolClass.teacherEmails.includes(normalizeEmail(user.email)))) return fail(403, 'CLASS_ACCESS_DENIED', 'This class is not assigned to your account.');
  return { ...context, schoolClass };
}
function admin(role: string) { if (role !== 'admin') fail(403, 'ADMIN_REQUIRED', 'Only this school’s administrator can change its teachers, classes and roster.'); }

/** Index rows only discover candidates. Each read rechecks the canonical roster and verified email. */
export async function linkedFamily(user: VerifiedAccount) {
  const email = normalizeEmail(user.email);
  async function candidates(kind: 'STUDENT' | 'PARENT') {
    const refs = await query(emailPK(email), `${kind}#`);
    const links: ChildLink[] = [];
    for (const ref of refs) {
      const student = await get<Student>(classPK(ref.schoolId, ref.classId), `STUDENT#${ref.studentId}`);
      if (!student?.active || (kind === 'STUDENT' ? student.studentEmail !== email : !student.parentEmails.includes(email))) continue;
      const school = await get<School>(schoolPK(ref.schoolId), 'META');
      const schoolClass = await get<SchoolClass>(schoolPK(ref.schoolId), `CLASS#${ref.classId}`);
      if (school && schoolClass) links.push({ id: student.id, schoolId: school.id, schoolName: school.name, timeZone: school.timeZone, classId: schoolClass.id, className: schoolClass.name, name: student.name });
    }
    return links;
  }
  const [students, parents] = await Promise.all([candidates('STUDENT'), candidates('PARENT')]);
  return {
    student: { status: students.length > 1 ? 'ambiguous' as const : students.length ? 'linked' as const : 'missing' as const, children: students.length === 1 ? students : [], matchCount: students.length },
    parent: { status: parents.length ? 'linked' as const : 'missing' as const, children: parents },
  };
}
/** Later family endpoints must use this resolver again, including after roster corrections. */
export async function requireFamilyChild(user: VerifiedAccount, schoolId: string, classId: string, childId: string, role: 'student' | 'parent') {
  const family = await linkedFamily(user);
  if (role === 'student' && family.student.status === 'ambiguous') return fail(409, 'AMBIGUOUS_STUDENT', 'More than one roster record matches your verified student email. Ask school staff to correct the roster.');
  const child = family[role].children.find((item) => item.schoolId === schoolId && item.classId === classId && item.id === childId);
  if (!child) return fail(403, 'CHILD_ACCESS_DENIED', 'This child is not linked to your verified account in this workspace.');
  return child;
}
/** Caller identity was freshly verified by GetUser; neither staff nor request fields choose the account. */
export async function bindLearnerAccount(user: VerifiedAccount): Promise<ChildLink | null> {
  if (!user.emailVerified) return fail(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before connecting your report.');
  const links = await linkedFamily(user); if (links.student.status !== 'linked') return null;
  const child = links.student.children[0]; const PK = classPK(child.schoolId, child.classId); const email = normalizeEmail(user.email);
  const roster = await get<Student>(PK, `STUDENT#${child.id}`);
  if (!roster?.active || roster.studentEmail !== email) return null;
  const previous = await get<LearnerAccountBinding>(PK, `LEARNER_ACCOUNT#${child.id}`);
  if (previous?.kind === 'learner-account' && previous.schemaVersion === 1 && previous.accountId === user.id && previous.emailHash === hash(email) && previous.schoolId === child.schoolId && previous.classId === child.classId && previous.studentId === child.id) return child;
  const binding: LearnerAccountBinding = { kind: 'learner-account', schemaVersion: 1, schoolId: child.schoolId, classId: child.classId, studentId: child.id, accountId: user.id, emailHash: hash(email), boundAt: now() };
  await write([
    { ConditionCheck: { TableName: table(), Key: { PK, SK: `STUDENT#${child.id}` }, ConditionExpression: '#active = :active AND studentEmail = :email AND #version = :version', ExpressionAttributeNames: { '#active': 'active', '#version': 'version' }, ExpressionAttributeValues: { ':active': true, ':email': email, ':version': roster.version } } },
    { ConditionCheck: { TableName: table(), Key: { PK: `USER#${user.id}`, SK: 'PROFILE' }, ConditionExpression: 'email = :email AND emailVerified = :verified', ExpressionAttributeValues: { ':email': email, ':verified': true } } },
    put(PK, `LEARNER_ACCOUNT#${child.id}`, binding),
  ]);
  return child;
}
async function staffWorkspaces(user: VerifiedAccount) {
  const [adminRefs, teacherRefs] = await Promise.all([query(`USER#${user.id}`, 'SCHOOL#'), query(emailPK(normalizeEmail(user.email)), 'TEACHER#')]);
  const workspaces = [];
  for (const schoolId of new Set([...adminRefs, ...teacherRefs].map((ref) => String(ref.schoolId)))) {
    try { const context = await requireSchoolStaff(user, schoolId); workspaces.push({ school: publicSchool(context.school), role: context.role }); }
    catch (issue) { if (!(issue instanceof SchoolError && issue.status === 403)) throw issue; }
  }
  return workspaces;
}
async function classFields(body: RecordValue, schoolId: string) {
  const name = text(body.name, 'a class name', 100); const subject = text(body.subject, 'a subject', 100);
  if (!Array.isArray(body.teacherEmails) || body.teacherEmails.length > 20) return fail(400, 'INVALID_TEACHERS', 'Choose up to 20 teachers recorded in this school.');
  const teacherEmails = [...new Set(body.teacherEmails.map(normalizeEmail))];
  for (const email of teacherEmails) {
    const teacher = await get<Teacher>(schoolPK(schoolId), `TEACHER#${hash(email)}`);
    if (!teacher?.active) return fail(400, 'TEACHER_NOT_IN_SCHOOL', 'Add each assigned teacher to this school first, or remove inactive teachers from the class.');
  }
  return { name, subject, teacherEmails };
}
function studentFields(body: RecordValue) {
  const name = text(body.name, 'the student’s name', 100); const studentEmail = normalizeEmail(body.studentEmail);
  if (!Array.isArray(body.parentEmails) || body.parentEmails.length < 1 || body.parentEmails.length > 4) return fail(400, 'INVALID_PARENTS', 'Record between one and four parent email addresses.');
  const parentEmails = [...new Set(body.parentEmails.map(normalizeEmail))];
  if (parentEmails.includes(studentEmail)) return fail(400, 'SEPARATE_ACCOUNTS_REQUIRED', 'Use different student and parent emails. Each person verifies and signs in to their own account.');
  return { name, studentEmail, parentEmails };
}
function rosterIndexes(schoolId: string, classId: string, student: Student) {
  const result = new Map<string, { PK: string; SK: string }>();
  if (!student.active) return result;
  for (const [kind, email] of [['STUDENT', student.studentEmail], ...student.parentEmails.map((email) => ['PARENT', email])]) {
    const PK = emailPK(email); const SK = `${kind}#${schoolId}#${classId}#${student.id}`;
    result.set(`${PK}/${SK}`, { PK, SK });
  }
  return result;
}
async function saveStudent(schoolId: string, classId: string, student: Student, old: Student | null) {
  const next = rosterIndexes(schoolId, classId, student); const previous = old ? rosterIndexes(schoolId, classId, old) : new Map();
  const writes: NonNullable<TransactWriteCommandInput['TransactItems']> = [put(classPK(schoolId, classId), `STUDENT#${student.id}`, { ...student, updatedAt: now() }, old ? old.version : 'new')];
  if (old && (!student.active || student.studentEmail !== old.studentEmail)) writes.push(remove(classPK(schoolId, classId), `LEARNER_ACCOUNT#${student.id}`));
  for (const [key, ref] of previous) if (!next.has(key)) writes.push(remove(ref.PK, ref.SK));
  for (const ref of next.values()) writes.push(put(ref.PK, ref.SK, { schoolId, classId, studentId: student.id }));
  await write(writes);
}

export async function handleSchool(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount): Promise<APIGatewayProxyResultV2> {
  try {
    if (!user.id || !user.emailVerified) return fail(403, 'EMAIL_NOT_VERIFIED', 'Verify your account email before opening a school workspace.');
    normalizeEmail(user.email);
    if (!table()) return fail(503, 'STORAGE_UNAVAILABLE', 'The school workspace is temporarily unavailable.');
    const communication = await import('./communication.js');
    const handled = await communication.handleCommunication(event, user);
    if (handled) return handled;
    const path = event.rawPath.replace(/\/$/, ''); const method = event.requestContext.http.method;
    if (path === '/api/school/workspaces' && method === 'GET') {
      const [staff, family] = await Promise.all([staffWorkspaces(user), linkedFamily(user)]);
      return json(200, { staff, family });
    }
    const familyMatch = path.match(/^\/api\/school\/family\/(student|parent)\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (familyMatch && method === 'GET') return json(200, { child: await requireFamilyChild(user, id(familyMatch[2]), id(familyMatch[3]), id(familyMatch[4]), familyMatch[1] as 'student' | 'parent') });
    if (path === '/api/school/schools' && method === 'POST') {
      const body = bodyOf(event); const name = text(body.name, 'a school name', 150); const timeZone = text(body.timeZone, 'a school time zone', 80);
      try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { return fail(400, 'INVALID_TIME_ZONE', 'Choose a valid school time zone, such as Asia/Kolkata.'); }
      const school: School = { id: randomUUID(), name, timeZone, createdAt: now(), adminId: user.id };
      await write([put(schoolPK(school.id), 'META', school, 'new'), put(`USER#${user.id}`, `SCHOOL#${school.id}`, { schoolId: school.id }, 'new')]);
      return json(201, { school: publicSchool(school) });
    }
    const route = path.match(/^\/api\/school\/schools\/([^/]+)(?:\/(.*))?$/);
    if (!route) return fail(404, 'NOT_FOUND', 'This school page could not be found.');
    const schoolId = id(route[1]); const tail = route[2] || '';
    const context = await requireSchoolStaff(user, schoolId);
    if (!tail && method === 'GET') {
      const allClasses = await query(schoolPK(schoolId), 'CLASS#');
      const classes = allClasses.filter((item) => context.role === 'admin' || item.teacherEmails.includes(normalizeEmail(user.email))).map((item) => publicClass(item as SchoolClass));
      const teachers = context.role === 'admin' ? (await query(schoolPK(schoolId), 'TEACHER#')).filter((item) => item.active).map((item) => publicTeacher(item as Teacher)) : [];
      return json(200, { school: publicSchool(context.school), role: context.role, classes, teachers });
    }
    const teacherMatch = tail.match(/^teachers\/([^/]+)$/);
    if (teacherMatch && method === 'PUT') {
      admin(context.role); const body = bodyOf(event);
      let decoded: string; try { decoded = decodeURIComponent(teacherMatch[1]); } catch { return fail(400, 'INVALID_EMAIL', 'Enter a complete teacher email address.'); }
      const email = normalizeEmail(decoded); const key = `TEACHER#${hash(email)}`;
      const old = await get<Teacher>(schoolPK(schoolId), key);
      if (typeof body.active !== 'boolean') return fail(400, 'INVALID_ACTIVE', 'Choose whether this teacher should have access.');
      if (old && (old.active || body.version !== undefined) && version(body.version) !== old.version) return fail(409, 'RECORD_CHANGED', 'This teacher record changed. Refresh and try again.');
      const teacher: Teacher = { email, name: body.active ? text(body.name, 'the teacher’s name', 100) : old?.name || email, active: body.active, version: (old?.version || 0) + 1 };
      await write([put(schoolPK(schoolId), key, { ...teacher, updatedAt: now() }, old ? old.version : 'new'), body.active ? put(emailPK(email), `TEACHER#${schoolId}`, { schoolId }) : remove(emailPK(email), `TEACHER#${schoolId}`)]);
      return json(200, { teacher: publicTeacher(teacher), active: teacher.active });
    }
    if (tail === 'classes' && method === 'POST') {
      admin(context.role); const fields = await classFields(bodyOf(event), schoolId);
      const schoolClass: SchoolClass = { id: randomUUID(), ...fields, version: 1 };
      await write([put(schoolPK(schoolId), `CLASS#${schoolClass.id}`, { ...schoolClass, updatedAt: now() }, 'new')]);
      return json(201, { schoolClass: publicClass(schoolClass) });
    }
    const classMatch = tail.match(/^classes\/([^/]+)(?:\/(.*))?$/);
    if (!classMatch) return fail(404, 'NOT_FOUND', 'This school page could not be found.');
    const classId = id(classMatch[1]); const classTail = classMatch[2] || '';
    const { schoolClass } = await requireClassStaff(user, schoolId, classId);
    if (!classTail && method === 'PUT') {
      admin(context.role); const body = bodyOf(event);
      if (version(body.version) !== schoolClass.version) return fail(409, 'RECORD_CHANGED', 'This class changed. Refresh and try again.');
      const fields = await classFields(body, schoolId); const updated = { ...schoolClass, ...fields, version: schoolClass.version + 1 };
      await write([put(schoolPK(schoolId), `CLASS#${classId}`, { ...updated, updatedAt: now() }, schoolClass.version)]);
      return json(200, { schoolClass: publicClass(updated) });
    }
    if (classTail === 'roster' && method === 'GET') return json(200, { students: (await query(classPK(schoolId, classId), 'STUDENT#')).filter((item) => item.active).map((item) => publicStudent(item as Student)) });
    if (classTail === 'roster' && method === 'POST') {
      admin(context.role); const fields = studentFields(bodyOf(event)); const student: Student = { id: randomUUID(), ...fields, version: 1, active: true };
      await saveStudent(schoolId, classId, student, null);
      const matches = await query(emailPK(student.studentEmail), 'STUDENT#');
      return json(201, { student: publicStudent(student), ...(matches.length > 1 ? { warning: 'This student email matches multiple roster records. Student school access is blocked until staff correct the duplicate.' } : {}) });
    }
    const rosterMatch = classTail.match(/^roster\/([^/]+)$/);
    if (rosterMatch && method === 'PUT') {
      admin(context.role); const studentId = id(rosterMatch[1]); const body = bodyOf(event);
      const old = await get<Student>(classPK(schoolId, classId), `STUDENT#${studentId}`);
      if (!old?.active) return fail(404, 'NOT_FOUND', 'This student is no longer on the class roster.');
      if (version(body.version) !== old.version) return fail(409, 'RECORD_CHANGED', 'This student record changed. Refresh and try again.');
      const student: Student = body.active === false ? { ...old, active: false, version: old.version + 1 } : { ...old, ...studentFields(body), version: old.version + 1 };
      await saveStudent(schoolId, classId, student, old);
      const matches = student.active ? await query(emailPK(student.studentEmail), 'STUDENT#') : [];
      return json(200, { student: publicStudent(student), active: student.active, ...(matches.length > 1 ? { warning: 'This student email matches multiple roster records. Student school access is blocked until staff correct the duplicate.' } : {}) });
    }
    return fail(404, 'NOT_FOUND', 'This school action could not be found.');
  } catch (issue) {
    if (issue instanceof SchoolError) return json(issue.status, { error: issue.code, message: issue.message });
    throw issue;
  }
}

/** Canonical bounded input for school guidance; never includes roster emails. */
export async function listClassRosterForGuidance(schoolId: string, classId: string) {
  return (await query(classPK(schoolId, classId), 'STUDENT#')).filter((item) => item.active).map((item) => ({ id: String(item.id), name: String(item.name) }));
}
export async function staffDisplayName(user: VerifiedAccount, schoolId: string) {
  const context = await requireSchoolStaff(user, schoolId);
  if (context.role === 'admin') return 'School administrator';
  const teacher = await get<Teacher>(schoolPK(schoolId), `TEACHER#${hash(normalizeEmail(user.email))}`);
  return teacher?.name || 'Teacher';
}
