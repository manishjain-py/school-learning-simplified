import { createHash } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { parentEmailPublicationChecks } from './parent-email.js';
import type { ParentNoteAssistance } from './parent-notes.js';
import { SchoolError, bodyOf, classPK, fail, get, id, json, linkedFamily, normalizeEmail, now, put, query, requireClassStaff, requireFamilyChild, version, write, type Student, type VerifiedAccount } from './index.js';

export type FamilyUpdate = { assistance?: ParentNoteAssistance | null; id: string; schoolId: string; classId: string; authorId: string; authorEmail: string; authorName: string; audience: 'class' | 'student'; studentId: string | null; text: string; logId: string | null; version: number; createdAt: string; updatedAt: string };
type Thread = { id: string; schoolId: string; classId: string; childId: string; parentId: string; parentEmail: string; teacherId: string; teacherEmail: string; teacherName: string; updateId: string; createdAt: string; activitySequence?: number; latestActivityAt?: string };
type Message = { id: string; text: string; authorId: string; authorRole: 'parent' | 'teacher'; authorName: string; createdAt: string; sequence?: number };
type Acknowledgement = { parentName: string; acknowledgedAt: string; sequence: number; updateVersion: number };
type FamilyProfile = { displayName: string; version: number; updatedAt: string };
type Cursor = { version: number; readSequence?: number; readVersion?: number; readAt: string };
type Role = 'parent' | 'teacher';
const table = () => process.env.TABLE_NAME!;
const commPK = (school: string, classroom: string) => `COMM#${school}#${classroom}`;
const threadPK = (thread: Thread) => `THREAD#${thread.schoolId}#${thread.classId}#${thread.id}`;
const threadKey = (thread: Thread) => `THREAD#${thread.id}`;
const threadReadKey = (thread: Thread) => `FAMILY_THREAD_READ#${thread.schoolId}#${thread.classId}#${thread.id}`;
const updateReadKey = (school: string, classroom: string, child: string, update: string) => `FAMILY_UPDATE_READ#${school}#${classroom}#${child}#${update}`;
const threadIdFor = (school: string, classroom: string, child: string, parent: string, update: FamilyUpdate) => createHash('sha256').update([school, classroom, child, parent, update.authorId, update.id].join(':')).digest('hex');
const sequence = (thread: Thread) => thread.activitySequence || 0;
const relevant = (update: FamilyUpdate, child: string) => update.audience === 'class' || update.studentId === child;
const conditionalConflict = (issue: unknown) => issue instanceof SchoolError && issue.code === 'RECORD_CHANGED';
const unavailable = (issue: unknown) => issue instanceof SchoolError && [400, 403, 404, 409].includes(issue.status);
function text(value: unknown, label: string, max: number, multiline = false) {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || controls.test(value)) return fail(400, 'INVALID_FIELD', `Enter ${label} (up to ${max} characters).`);
  return value.trim();
}
function observed(value: unknown, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) return fail(400, 'OBSERVATION_REQUIRED', `Open the ${label} before marking it read.`);
  return Number(value);
}
function verified(user: VerifiedAccount) {
  if (!user.id || !user.emailVerified) return fail(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before opening family conversations.');
}
function cleanProfile(profile: FamilyProfile | null) { return profile ? { displayName: profile.displayName, version: profile.version, updatedAt: profile.updatedAt } : null; }
async function profileFor(accountId: string, required = false) {
  const profile = await get<FamilyProfile>(`USER#${accountId}`, 'FAMILY_PROFILE');
  if (required && !profile?.displayName) return fail(409, 'FAMILY_NAME_REQUIRED', 'Save your name before acknowledging or replying.');
  return profile;
}
async function profileRoute(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount) {
  const links = await linkedFamily(user);
  if (!links.parent.children.length) return fail(403, 'PARENT_REQUIRED', 'A current parent link is required to use a family profile.');
  const previous = await profileFor(user.id);
  if (event.requestContext.http.method === 'GET') return json(200, { profile: cleanProfile(previous) });
  if (event.requestContext.http.method !== 'PUT') return fail(405, 'METHOD_NOT_ALLOWED', 'This family profile action is not available.');
  const body = bodyOf(event);
  if (Object.keys(body).some(key => !['displayName', 'version'].includes(key))) return fail(400, 'INVALID_FIELDS', 'Only your family display name can be saved here.');
  if (!Number.isSafeInteger(body.version) || body.version !== (previous?.version || 0)) return fail(409, 'PROFILE_CHANGED', 'Your name changed in another session. Refresh and try again.');
  const childLink = links.parent.children[0];
  const child = await get<Student>(classPK(childLink.schoolId, childLink.classId), `STUDENT#${childLink.id}`);
  if (!child?.active || !child.parentEmails.includes(normalizeEmail(user.email))) return fail(403, 'CHILD_ACCESS_DENIED', 'The parent link changed. Refresh your family page.');
  const profile: FamilyProfile = { displayName: text(body.displayName, 'your name', 100), version: (previous?.version || 0) + 1, updatedAt: now() };
  await write([
    put(`USER#${user.id}`, 'FAMILY_PROFILE', profile, previous?.version || 'new'),
    { ConditionCheck: { TableName: table(), Key: { PK: classPK(childLink.schoolId, childLink.classId), SK: `STUDENT#${child.id}` }, ConditionExpression: '#active = :yes AND #version = :version AND parentEmails = :parents', ExpressionAttributeNames: { '#active': 'active', '#version': 'version' }, ExpressionAttributeValues: { ':yes': true, ':version': child.version, ':parents': child.parentEmails } } },
  ]);
  return json(200, { profile: cleanProfile(profile) });
}
async function getUpdate(school: string, classroom: string, updateId: string) {
  const update = await get<FamilyUpdate>(commPK(school, classroom), `UPDATE#${id(updateId)}`);
  if (!update || update.schoolId !== school || update.classId !== classroom) return fail(404, 'UPDATE_NOT_FOUND', 'This family update could not be found.');
  return update;
}
export function cleanFamilyUpdate(update: FamilyUpdate, canEdit?: boolean) {
  const { id, authorName, audience, studentId, text, logId, version, createdAt, updatedAt, assistance } = update;
  return { id, authorName, audience, studentId, text, logId, version, createdAt, updatedAt, ...(assistance ? { assistance } : {}), ...(canEdit === undefined ? {} : { canEdit }) };
}
async function contextFor(thread: Thread) {
  const parent: VerifiedAccount = { id: thread.parentId, email: thread.parentEmail, emailVerified: true };
  const teacher: VerifiedAccount = { id: thread.teacherId, email: thread.teacherEmail, emailVerified: true };
  const child = await requireFamilyChild(parent, thread.schoolId, thread.classId, thread.childId, 'parent');
  const staff = await requireClassStaff(teacher, thread.schoolId, thread.classId);
  const update = await getUpdate(thread.schoolId, thread.classId, thread.updateId);
  if (!relevant(update, thread.childId) || update.authorId !== thread.teacherId || normalizeEmail(update.authorEmail) !== normalizeEmail(thread.teacherEmail)) return fail(403, 'THREAD_ACCESS_DENIED', 'This conversation is no longer available for this child and teacher.');
  const roster = await get<Student>(classPK(thread.schoolId, thread.classId), `STUDENT#${thread.childId}`);
  if (!roster?.active || !roster.parentEmails.includes(normalizeEmail(thread.parentEmail))) return fail(403, 'THREAD_ACCESS_DENIED', 'This parent is no longer linked to this child.');
  return { child, roster, staff, update, teacher };
}
type Context = Awaited<ReturnType<typeof contextFor>>;
function contextChecks(thread: Thread, context: Context) {
  const checks = parentEmailPublicationChecks(context.teacher, context.staff, context.roster);
  checks.push({ ConditionCheck: { TableName: table(), Key: { PK: commPK(thread.schoolId, thread.classId), SK: `UPDATE#${thread.updateId}` }, ConditionExpression: '#version = :version AND authorId = :author AND audience = :audience AND studentId = :student', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': context.update.version, ':author': thread.teacherId, ':audience': context.update.audience, ':student': context.update.studentId } } });
  return checks;
}
async function authorizeThread(user: VerifiedAccount, school: string, classroom: string, threadId: string, role: Role, childId?: string) {
  if (!/^[a-f0-9]{64}$/.test(threadId)) return fail(404, 'THREAD_NOT_FOUND', 'This conversation could not be found.');
  const thread = await get<Thread>(commPK(school, classroom), `THREAD#${threadId}`);
  if (!thread || thread.schoolId !== school || thread.classId !== classroom || (role === 'parent' ? thread.parentId !== user.id || thread.childId !== childId || normalizeEmail(thread.parentEmail) !== normalizeEmail(user.email) : thread.teacherId !== user.id || normalizeEmail(thread.teacherEmail) !== normalizeEmail(user.email))) return fail(403, 'THREAD_ACCESS_DENIED', 'This private conversation is not available to your account.');
  if (role === 'parent') await requireFamilyChild(user, school, classroom, thread.childId, 'parent');
  else await requireClassStaff(user, school, classroom);
  return { thread, context: await contextFor(thread) };
}
async function parentThread(user: VerifiedAccount, school: string, classroom: string, childId: string, updateId: string) {
  await requireFamilyChild(user, school, classroom, childId, 'parent');
  const update = await getUpdate(school, classroom, updateId);
  if (!relevant(update, childId)) return fail(403, 'UPDATE_ACCESS_DENIED', 'This update is not available for this child.');
  const id = threadIdFor(school, classroom, childId, user.id, update);
  const existing = await get<Thread>(commPK(school, classroom), `THREAD#${id}`);
  if (existing) return { ...await authorizeThread(user, school, classroom, id, 'parent', childId), existing: true };
  const thread: Thread = { id, schoolId: school, classId: classroom, childId, parentId: user.id, parentEmail: normalizeEmail(user.email), teacherId: update.authorId, teacherEmail: update.authorEmail, teacherName: update.authorName, updateId: update.id, createdAt: now() };
  return { thread, context: await contextFor(thread), existing: false };
}
function threadWrite(thread: Thread, next: Thread, existing: boolean) {
  if (!existing) return put(commPK(thread.schoolId, thread.classId), threadKey(thread), next, 'new');
  const operation = put(commPK(thread.schoolId, thread.classId), threadKey(thread), next);
  return { Put: { ...operation.Put, ConditionExpression: thread.activitySequence === undefined ? 'attribute_exists(PK) AND attribute_not_exists(activitySequence)' : 'activitySequence = :sequence', ...(thread.activitySequence === undefined ? {} : { ExpressionAttributeValues: { ':sequence': thread.activitySequence } }) } };
}
const cleanAcknowledgement = (ack: Acknowledgement): Acknowledgement => ({ parentName: ack.parentName, acknowledgedAt: ack.acknowledgedAt, sequence: ack.sequence, updateVersion: ack.updateVersion });
function cleanMessage(message: Message, parentName: string, viewer: string, readSequence: number) {
  return { id: message.id, text: message.text, authorRole: message.authorRole, authorName: message.authorRole === 'parent' ? parentName : message.authorName, createdAt: message.createdAt, sequence: message.sequence || 0, isUnread: message.authorId !== viewer && (message.sequence || 0) > readSequence };
}
async function threadView(thread: Thread, context: Context, viewer: VerifiedAccount, role: Role) {
  const observedSequence = sequence(thread);
  const [messageRows, ackRows, cursor, profile] = await Promise.all([
    query(threadPK(thread), 'MESSAGE#'), query(threadPK(thread), 'ACK#'),
    get<Cursor>(`USER#${viewer.id}`, threadReadKey(thread)), profileFor(thread.parentId),
  ]);
  const readSequence = cursor?.readSequence || 0;
  const parentName = profile?.displayName || 'Parent';
  const messages = (messageRows as Message[]).filter(message => (message.sequence || 0) <= observedSequence).sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(message => cleanMessage(message, parentName, viewer.id, readSequence));
  const acknowledgements = (ackRows as Acknowledgement[]).filter(ack => ack.sequence <= observedSequence).sort((a, b) => a.sequence - b.sequence).map(cleanAcknowledgement);
  const unreadCount = messages.filter(message => message.isUnread).length + (role === 'teacher' ? acknowledgements.filter(ack => ack.sequence > readSequence).length : 0);
  const latestActivityAt = thread.latestActivityAt || [thread.createdAt, ...messages.map(message => message.createdAt), ...acknowledgements.map(ack => ack.acknowledgedAt)].sort().at(-1)!;
  return { thread: { id: thread.id, childId: context.child.id, childName: context.child.name, teacherName: thread.teacherName, update: cleanFamilyUpdate(context.update), createdAt: thread.createdAt, parentName, latestActivityAt, unreadCount, observedSequence, acknowledgement: acknowledgements.find(ack => ack.updateVersion === context.update.version) || null, acknowledgements }, messages };
}
async function listThreads(user: VerifiedAccount, school: string, classroom: string, role: Role, childId?: string) {
  const rows = await query(commPK(school, classroom), 'THREAD#');
  const result: Awaited<ReturnType<typeof threadView>>['thread'][] = [];
  for (const row of rows) {
    const thread = row as Thread;
    if (role === 'parent' ? thread.parentId !== user.id || thread.childId !== childId : thread.teacherId !== user.id) continue;
    try {
      const authorized = await authorizeThread(user, school, classroom, thread.id, role, childId);
      const view = await threadView(authorized.thread, authorized.context, user, role);
      await authorizeThread(user, school, classroom, thread.id, role, childId);
      result.push(view.thread);
    } catch (issue) { if (!unavailable(issue)) throw issue; }
  }
  return result.sort((a, b) => b.latestActivityAt.localeCompare(a.latestActivityAt) || b.id.localeCompare(a.id));
}
async function parentUpdates(user: VerifiedAccount, school: string, classroom: string, childId: string) {
  const child = await requireFamilyChild(user, school, classroom, childId, 'parent');
  const rows = (await query(commPK(school, classroom), 'UPDATE#')).filter(row => relevant(row as FamilyUpdate, childId)) as FamilyUpdate[];
  const threads = await listThreads(user, school, classroom, 'parent', childId);
  const updates = await Promise.all(rows.map(async update => {
    const cursor = await get<Cursor>(`USER#${user.id}`, updateReadKey(school, classroom, childId, update.id));
    const thread = threads.find(thread => thread.update.id === update.id);
    return { ...cleanFamilyUpdate(update), isUnread: update.version > (cursor?.readVersion || 0), observedVersion: update.version, acknowledgement: thread?.acknowledgements.find(ack => ack.updateVersion === update.version) || null, ...(thread ? { threadId: thread.id } : {}) };
  }));
  await requireFamilyChild(user, school, classroom, childId, 'parent');
  return { child, updates: updates.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), threads };
}
export async function staffUpdateAcknowledgements(user: VerifiedAccount, school: string, classroom: string, updates: FamilyUpdate[]) {
  const threads = await listThreads(user, school, classroom, 'teacher');
  return updates.map(update => ({ ...cleanFamilyUpdate(update), ...(update.authorId === user.id ? { acknowledgements: threads.filter(thread => thread.update.id === update.id).flatMap(thread => thread.acknowledgements.map(ack => ({ ...ack, threadId: thread.id, childId: thread.childId, childName: thread.childName }))) } : {}) }));
}
async function acknowledge(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount, school: string, classroom: string, childId: string, updateId: string) {
  const observedVersion = version(bodyOf(event).observedVersion);
  const profile = (await profileFor(user.id, true))!;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { thread, context, existing } = await parentThread(user, school, classroom, childId, updateId);
    if (context.update.version !== observedVersion) return fail(409, 'UPDATE_CHANGED', 'This update changed. Open its latest version before acknowledging it.');
    const key = `ACK#${String(observedVersion).padStart(10, '0')}`;
    const previous = await get<Acknowledgement>(threadPK(thread), key);
    if (previous) {
      const current = await authorizeThread(user, school, classroom, thread.id, 'parent', childId);
      if (current.context.update.version !== observedVersion) return fail(409, 'UPDATE_CHANGED', 'This update changed. Open its latest version before acknowledging it.');
      return json(200, { thread: (await threadView(current.thread, current.context, user, 'parent')).thread, acknowledgement: cleanAcknowledgement(previous) });
    }
    const acknowledgedAt = now();
    const acknowledgement: Acknowledgement = { parentName: profile.displayName, acknowledgedAt, sequence: sequence(thread) + 1, updateVersion: observedVersion };
    const next = { ...thread, activitySequence: acknowledgement.sequence, latestActivityAt: acknowledgedAt };
    try {
      await write([threadWrite(thread, next, existing), put(threadPK(thread), key, acknowledgement, 'new'), ...contextChecks(thread, context)]);
      return json(201, { thread: (await threadView(next, context, user, 'parent')).thread, acknowledgement });
    } catch (issue) { if (!conditionalConflict(issue) || attempt === 2) throw issue; }
  }
  return fail(409, 'RECORD_CHANGED', 'The conversation changed. Refresh and try again.');
}
async function sendMessage(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount, school: string, classroom: string, role: Role, childId?: string, threadId?: string) {
  const body = bodyOf(event); const messageId = id(body.clientId); const content = text(body.text, 'a private reply', 2000, true);
  const profile = role === 'parent' ? await profileFor(user.id, true) : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const authorized = threadId ? { ...await authorizeThread(user, school, classroom, threadId, role, childId), existing: true } : await parentThread(user, school, classroom, childId!, body.updateId);
    const { thread, context, existing } = authorized;
    const previous = await get<Message>(threadPK(thread), `MESSAGE#${messageId}`);
    if (previous) {
      if (previous.authorId !== user.id || previous.text !== content) return fail(409, 'REQUEST_CONFLICT', 'This message identifier is already in use.');
      const current = await authorizeThread(user, school, classroom, thread.id, role, childId);
      return json(200, { thread: (await threadView(current.thread, current.context, user, role)).thread, message: cleanMessage(previous, profile?.displayName || (await profileFor(thread.parentId))?.displayName || 'Parent', user.id, sequence(current.thread)) });
    }
    const createdAt = now();
    const message: Message = { id: messageId, text: content, authorId: user.id, authorRole: role, authorName: role === 'parent' ? profile!.displayName : thread.teacherName, createdAt, sequence: sequence(thread) + 1 };
    const next = { ...thread, activitySequence: message.sequence, latestActivityAt: createdAt };
    try {
      await write([threadWrite(thread, next, existing), put(threadPK(thread), `MESSAGE#${messageId}`, message, 'new'), ...contextChecks(thread, context)]);
      return json(201, { thread: (await threadView(next, context, user, role)).thread, message: cleanMessage(message, profile?.displayName || 'Parent', user.id, message.sequence!) });
    } catch (issue) { if (!conditionalConflict(issue) || attempt === 2) throw issue; }
  }
  return fail(409, 'RECORD_CHANGED', 'The conversation changed. Refresh and try again.');
}
async function readThread(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount, school: string, classroom: string, threadId: string, role: Role, childId?: string) {
  const observedSequence = observed(bodyOf(event).observedSequence, 'conversation');
  for (let attempt = 0; attempt < 3; attempt++) {
    const { thread, context } = await authorizeThread(user, school, classroom, threadId, role, childId);
    if (observedSequence > sequence(thread)) return fail(409, 'OBSERVATION_CHANGED', 'Open this conversation before marking its activity read.');
    const key = threadReadKey(thread); const old = await get<Cursor>(`USER#${user.id}`, key);
    if (old && (old.readSequence || 0) >= observedSequence) return json(200, { readSequence: old.readSequence || 0 });
    const cursor: Cursor = { version: (old?.version || 0) + 1, readSequence: observedSequence, readAt: now() };
    try { await write([put(`USER#${user.id}`, key, cursor, old?.version || 'new'), ...contextChecks(thread, context)]); return json(200, { readSequence: observedSequence }); }
    catch (issue) { if (!conditionalConflict(issue) || attempt === 2) throw issue; }
  }
  return fail(409, 'RECORD_CHANGED', 'The conversation changed. Refresh and try again.');
}
async function readUpdate(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount, school: string, classroom: string, childId: string, updateId: string) {
  const observedVersion = version(bodyOf(event).observedVersion);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { thread, context } = await parentThread(user, school, classroom, childId, updateId);
    if (observedVersion > context.update.version) return fail(409, 'OBSERVATION_CHANGED', 'Open this update before marking it read.');
    const key = updateReadKey(school, classroom, childId, updateId); const old = await get<Cursor>(`USER#${user.id}`, key);
    if ((old?.readVersion || 0) >= observedVersion) return json(200, { readVersion: old?.readVersion || 0 });
    const cursor: Cursor = { version: (old?.version || 0) + 1, readVersion: observedVersion, readAt: now() };
    try { await write([put(`USER#${user.id}`, key, cursor, old?.version || 'new'), ...contextChecks(thread, context)]); return json(200, { readVersion: observedVersion }); }
    catch (issue) { if (!conditionalConflict(issue) || attempt === 2) throw issue; }
  }
  return fail(409, 'RECORD_CHANGED', 'The update changed. Refresh and try again.');
}
async function messages(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount, school: string, classroom: string, threadId: string, role: Role, childId?: string) {
  if (event.requestContext.http.method === 'POST') return sendMessage(event, user, school, classroom, role, childId, threadId);
  if (event.requestContext.http.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'This conversation action is not available.');
  const { thread, context } = await authorizeThread(user, school, classroom, threadId, role, childId);
  const view = await threadView(thread, context, user, role);
  await authorizeThread(user, school, classroom, threadId, role, childId);
  return json(200, view);
}
/** Reads never write cursors, acknowledge feedback, invoke models or send email. */
export async function handleFamilyConversations(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount): Promise<APIGatewayProxyResultV2 | null> {
  const path = event.rawPath.replace(/\/$/, ''); const method = event.requestContext.http.method;
  if (path === '/api/school/family/profile') { verified(user); return profileRoute(event, user); }
  const parent = path.match(/^\/api\/school\/family\/(parent|student)\/([^/]+)\/([^/]+)\/([^/]+)\/(updates|threads|unread)(?:\/([^/]+)\/(messages|read|acknowledgement))?$/);
  if (parent) {
    const [, role, schoolValue, classValue, childValue, action, recordId, subaction] = parent;
    if (role === 'student' && action === 'updates' && !recordId && method === 'GET') return null;
    verified(user);
    if (role !== 'parent') return fail(403, 'PARENT_REQUIRED', 'Private conversations are available only to linked parents.');
    const school = id(schoolValue); const classroom = id(classValue); const child = id(childValue);
    await requireFamilyChild(user, school, classroom, child, 'parent');
    if (action === 'updates' && !recordId && method === 'GET') { const result = await parentUpdates(user, school, classroom, child); return json(200, { child: result.child, updates: result.updates }); }
    if (action === 'unread' && !recordId && method === 'GET') {
      const result = await parentUpdates(user, school, classroom, child);
      const unreadUpdates = result.updates.filter(update => update.isUnread).length; const unreadActivities = result.threads.reduce((sum, thread) => sum + thread.unreadCount, 0);
      return json(200, { unreadCount: unreadUpdates + unreadActivities, unreadUpdates, unreadActivities });
    }
    if (action === 'updates' && recordId && method === 'POST') {
      if (subaction === 'read') return readUpdate(event, user, school, classroom, child, recordId);
      if (subaction === 'acknowledgement') return acknowledge(event, user, school, classroom, child, recordId);
    }
    if (action === 'threads') {
      if (!recordId && method === 'GET') return json(200, { threads: await listThreads(user, school, classroom, 'parent', child) });
      if (!recordId && method === 'POST') return sendMessage(event, user, school, classroom, 'parent', child);
      if (recordId && subaction === 'messages') return messages(event, user, school, classroom, recordId, 'parent', child);
      if (recordId && subaction === 'read' && method === 'POST') return readThread(event, user, school, classroom, recordId, 'parent', child);
    }
    return fail(404, 'NOT_FOUND', 'This family action could not be found.');
  }
  const staff = path.match(/^\/api\/school\/schools\/([^/]+)\/classes\/([^/]+)\/(threads|unread)(?:\/([^/]+)\/(messages|read))?$/);
  if (!staff) return null;
  verified(user);
  const [, schoolValue, classValue, action, threadId, subaction] = staff; const school = id(schoolValue); const classroom = id(classValue);
  await requireClassStaff(user, school, classroom);
  if (action === 'unread' && !threadId && method === 'GET') return json(200, { unreadCount: (await listThreads(user, school, classroom, 'teacher')).reduce((sum, thread) => sum + thread.unreadCount, 0) });
  if (action === 'threads') {
    if (!threadId && method === 'GET') return json(200, { threads: await listThreads(user, school, classroom, 'teacher') });
    if (threadId && subaction === 'messages') return messages(event, user, school, classroom, threadId, 'teacher');
    if (threadId && subaction === 'read' && method === 'POST') return readThread(event, user, school, classroom, threadId, 'teacher');
  }
  return fail(404, 'NOT_FOUND', 'This conversation action could not be found.');
}
