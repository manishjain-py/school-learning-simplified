import { handleFamilyConversations, staffUpdateAcknowledgements, type FamilyUpdate } from './family-conversations.js';
import { preparePublishedParentNoteDraft } from './parent-notes.js';
import { dispatchPublishedParentEmail, handleParentEmail, parentEmailPublicationChecks, prepareParentEmailRecords } from './parent-email.js';
import { processTeacherLog } from '../recommendations/index.js';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { bodyOf, classPK, fail, get, id, json, now, put, query, requireClassStaff, requireFamilyChild, staffDisplayName, version, write, type Student, type VerifiedAccount } from './index.js';

type GuidanceState = { status: string; message?: string; [key: string]: unknown };
export type SchoolLog = {
  id: string; schoolId: string; classId: string; authorId: string; authorEmail: string; authorName: string;
  subject: string; note: string; localDate: string; timeZone: string; version: number;
  createdAt: string; updatedAt: string; guidance: GuidanceState;
};
type Update = FamilyUpdate;
type Message = { id: string; text: string; authorId: string; authorRole: 'parent' | 'teacher'; authorName: string; createdAt: string };
const commPK = (schoolId: string, classId: string) => `COMM#${schoolId}#${classId}`;
const noGuidance = (): GuidanceState => ({ status: 'not_run', message: 'Learning guidance is not connected yet.' });
function prose(value: unknown, label: string, max = 3000): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return fail(400, 'INVALID_FIELD', `Enter ${label} (up to ${max} characters).`);
  return value.trim();
}
function requestId(value: unknown) { return id(typeof value === 'string' ? value : ''); }
function localDate(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function editAllowed(user: VerifiedAccount, authorId: string, role: string) {
  if (user.id !== authorId && role !== 'admin') fail(403, 'AUTHOR_REQUIRED', 'Only the author or this school’s administrator can correct this update.');
}
function cleanLog(log: SchoolLog) {
  const { id, schoolId, classId, authorId, authorName, subject, note, localDate, timeZone, version, createdAt, updatedAt, guidance } = log;
  return { id, schoolId, classId, authorId, authorName, subject, note, localDate, timeZone, version, createdAt, updatedAt, guidance };
}
function cleanUpdate(update: Update, canEdit?: boolean) {
  const { id, authorName, audience, studentId, text, logId, version, createdAt, updatedAt, assistance } = update;
  return { id, authorName, audience, studentId, text, logId, version, createdAt, updatedAt, ...(assistance ? { assistance } : {}), ...(canEdit === undefined ? {} : { canEdit }) };
}
const relevant = (update: Update, childId: string) => update.audience === 'class' || update.studentId === childId;
function cleanMessage(message: Message) { return { id: message.id, text: message.text, authorRole: message.authorRole, authorName: message.authorName, createdAt: message.createdAt }; }
function newest<T extends { createdAt: string }>(items: T[]): T[] { return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export async function getSchoolLog(schoolId: string, classId: string, logId: string): Promise<SchoolLog> {
  const log = await get<SchoolLog>(commPK(schoolId, classId), `LOG#${id(logId)}`);
  if (!log) return fail(404, 'LOG_NOT_FOUND', 'This classroom note could not be found.');
  return log;
}
/** M4 stores only against the exact note revision that was interpreted. */
export async function saveLogGuidance(log: SchoolLog, guidance: GuidanceState) {
  await write([put(commPK(log.schoolId, log.classId), `LOG#${log.id}`, { ...log, guidance }, log.version)]);
}
/** Interpret automatically after the committed revision; no teacher preview gate. */
export async function processSavedLog(log: SchoolLog, actor: VerifiedAccount): Promise<SchoolLog> {
  return processTeacherLog(log, actor);
}
async function requireActiveStudent(schoolId: string, classId: string, childId: string) {
  const child = await get<Student>(classPK(schoolId, classId), `STUDENT#${id(childId)}`);
  if (!child?.active) return fail(400, 'STUDENT_NOT_FOUND', 'Choose a current student in this class.');
  return child;
}
async function updateFields(body: Record<string, any>, schoolId: string, classId: string, user: VerifiedAccount) {
  if (body.audience !== 'class' && body.audience !== 'student') return fail(400, 'AUDIENCE_REQUIRED', 'Choose the class or one student for this update.');
  const child = body.audience === 'student' ? await requireActiveStudent(schoolId, classId, body.studentId) : null;
  const studentId = child?.id || null;
  const logId = body.logId ? (await getSchoolLog(schoolId, classId, body.logId)).id : null;
  if (body.draftId && !studentId) return fail(400, 'DRAFT_AUDIENCE', 'A parent-note draft can only be sent to its selected child.');
  const prepared = body.draftId ? await preparePublishedParentNoteDraft(user, schoolId, classId, studentId!, id(body.draftId), version(body.draftVersion)) : null;
  return { fields: { audience: body.audience as 'class' | 'student', studentId, text: prose(body.text, 'a family update'), logId, assistance: prepared?.assistance || null }, checks: prepared?.checks, child };
}
async function getUpdate(schoolId: string, classId: string, updateId: string) {
  const update = await get<Update>(commPK(schoolId, classId), `UPDATE#${id(updateId)}`);
  if (!update) return fail(404, 'UPDATE_NOT_FOUND', 'This family update could not be found.');
  return update;
}

export async function handleCommunication(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount): Promise<APIGatewayProxyResultV2 | null> {
  const conversation = await handleFamilyConversations(event, user);
  if (conversation) return conversation;
  const email = await handleParentEmail(event, user);
  if (email) return email;
  const path = event.rawPath.replace(/\/$/, ''); const method = event.requestContext.http.method;
  const family = path.match(/^\/api\/school\/family\/(student|parent)\/([^/]+)\/([^/]+)\/([^/]+)\/(updates|threads)(?:\/([^/]+)\/messages)?$/);
  if (family) {
    const [, roleValue, rawSchool, rawClass, rawChild, action, threadId] = family;
    const role = roleValue as 'student' | 'parent'; const schoolId = id(rawSchool); const classId = id(rawClass); const childId = id(rawChild);
    const child = await requireFamilyChild(user, schoolId, classId, childId, role);
    if (action === 'updates' && !threadId && method === 'GET') {
      const updates = (await query(commPK(schoolId, classId), 'UPDATE#')).filter((item) => relevant(item as Update, childId)).map((item) => cleanUpdate(item as Update));
      return json(200, { child, updates: newest(updates) });
    }
    return fail(404, 'NOT_FOUND', 'This family action could not be found.');
  }
  const staff = path.match(/^\/api\/school\/schools\/([^/]+)\/classes\/([^/]+)\/(logs|updates|threads)(?:\/([^/]+))?(?:\/(comments|messages))?$/);
  if (!staff) return null;
  const [, rawSchool, rawClass, action, recordId, subaction] = staff; const schoolId = id(rawSchool); const classId = id(rawClass);
  const context = await requireClassStaff(user, schoolId, classId); const PK = commPK(schoolId, classId);
  if (action === 'logs') {
    if (!recordId && method === 'GET') return json(200, { logs: newest((await query(PK, 'LOG#')).map((item) => cleanLog(item as SchoolLog))) });
    if (!recordId && method === 'POST') {
      const body = bodyOf(event); const logId = requestId(body.clientId); const old = await get<SchoolLog>(PK, `LOG#${logId}`);
      if (old) { if (old.authorId !== user.id) return fail(409, 'REQUEST_CONFLICT', 'This note identifier is already in use.'); return json(200, { log: cleanLog(await processSavedLog(old, user)) }); }
      const stamp = now(); const log: SchoolLog = { id: logId, schoolId, classId, authorId: user.id, authorEmail: user.email, authorName: await staffDisplayName(user, schoolId), subject: prose(body.subject, 'a subject', 100), note: prose(body.note, 'a classroom note'), localDate: localDate(context.school.timeZone), timeZone: context.school.timeZone, version: 1, createdAt: stamp, updatedAt: stamp, guidance: noGuidance() };
      await write([put(PK, `LOG#${logId}`, log, 'new'), put(PK, `LOGREV#${logId}#000001`, log, 'new')]);
      return json(201, { log: cleanLog(await processSavedLog(log, user)) });
    }
    if (recordId) {
      const log = await getSchoolLog(schoolId, classId, recordId);
      if (subaction === 'comments') {
        if (method === 'GET') return json(200, { comments: (await query(PK, `COMMENT#${log.id}#`)).map((item) => ({ id: item.id, text: item.text, authorName: item.authorName, createdAt: item.createdAt })).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) });
        if (method === 'POST') {
          const body = bodyOf(event); const commentId = requestId(body.clientId); const SK = `COMMENT#${log.id}#${commentId}`; const old = await get<Message>(PK, SK);
          if (old) { if (old.authorId !== user.id) return fail(409, 'REQUEST_CONFLICT', 'This comment identifier is already in use.'); return json(200, { comment: cleanMessage(old) }); }
          const comment: Message = { id: commentId, text: prose(body.text, 'a staff comment', 2000), authorId: user.id, authorRole: 'teacher', authorName: await staffDisplayName(user, schoolId), createdAt: now() };
          await write([put(PK, SK, comment, 'new')]); return json(201, { comment: cleanMessage(comment) });
        }
      }
      if (!subaction && method === 'GET') return json(200, { log: cleanLog(log), revisions: (await query(PK, `LOGREV#${log.id}#`)).map((item) => cleanLog(item as SchoolLog)) });
      if (!subaction && method === 'PUT') {
        editAllowed(user, log.authorId, context.role); const body = bodyOf(event);
        if (version(body.version) !== log.version) return fail(409, 'RECORD_CHANGED', 'This classroom note changed. Refresh before correcting it.');
        const updated: SchoolLog = { ...log, subject: prose(body.subject, 'a subject', 100), note: prose(body.note, 'a classroom note'), version: log.version + 1, localDate: localDate(context.school.timeZone), timeZone: context.school.timeZone, updatedAt: now(), guidance: noGuidance() };
        await write([put(PK, `LOG#${log.id}`, updated, log.version), put(PK, `LOGREV#${log.id}#${String(updated.version).padStart(6, '0')}`, { ...updated, correctedBy: user.id }, 'new')]);
        return json(200, { log: cleanLog(await processSavedLog(updated, user)) });
      }
    }
  }
  if (action === 'updates' && !subaction) {
    if (!recordId && method === 'GET') {
      const records = (await query(PK, 'UPDATE#')) as Update[];
      const updates = await staffUpdateAcknowledgements(user, schoolId, classId, records);
      return json(200, { updates: newest(updates.map(update => ({ ...update, canEdit: context.role === 'admin' || records.find(record => record.id === update.id)?.authorId === user.id }))) });
    }
    if (!recordId && method === 'POST') {
      const body = bodyOf(event); const updateId = requestId(body.clientId); const old = await get<Update>(PK, `UPDATE#${updateId}`);
      if (old) { if (old.authorId !== user.id) return fail(409, 'REQUEST_CONFLICT', 'This update identifier is already in use.'); await dispatchPublishedParentEmail(old); return json(200, { update: cleanUpdate(old) }); }
      const proposed = await updateFields(body, schoolId, classId, user);
      const stamp = now(); const update: Update = { id: updateId, schoolId, classId, authorId: user.id, authorEmail: user.email, authorName: await staffDisplayName(user, schoolId), ...proposed.fields, version: 1, createdAt: stamp, updatedAt: stamp };
      await write([put(PK, `UPDATE#${update.id}`, update, 'new'), put(PK, `UPDATEREV#${update.id}#000001`, update, 'new'), ...prepareParentEmailRecords(update, user, proposed.child, context.schoolClass.subject, stamp), ...(proposed.checks || parentEmailPublicationChecks(user, context, proposed.child))]);
      await dispatchPublishedParentEmail(update);
      return json(201, { update: cleanUpdate(update) });
    }
    if (recordId && method === 'PUT') {
      const update = await getUpdate(schoolId, classId, recordId); editAllowed(user, update.authorId, context.role); const body = bodyOf(event);
      if (version(body.version) !== update.version) return fail(409, 'RECORD_CHANGED', 'This family update changed. Refresh before correcting it.');
      const proposed = await updateFields(body, schoolId, classId, user);
      const updated = { ...update, ...proposed.fields, updatedAt: now(), version: update.version + 1 };
      await write([put(PK, `UPDATE#${update.id}`, updated, update.version), put(PK, `UPDATEREV#${update.id}#${String(updated.version).padStart(6, '0')}`, { ...updated, correctedBy: user.id }, 'new'), ...prepareParentEmailRecords(updated, user, proposed.child, context.schoolClass.subject, updated.updatedAt), ...(proposed.checks || parentEmailPublicationChecks(user, context, proposed.child))]);
      await dispatchPublishedParentEmail(updated);
      return json(200, { update: cleanUpdate(updated) });
    }
  }
  return fail(404, 'NOT_FOUND', 'This classroom action could not be found.');
}
