import { createHash } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { draftParentNote, type ParentNoteInput, type ParentNoteResult } from '../ai/parent-note.js';
import { MAX_ATTEMPTS, MODEL_ID, MODEL_REGION } from '../ai/types.js';
import { recommendationContent } from '../recommendations/content.js';
import { SchoolError, bodyOf, classPK, fail, get, id, json, listClassRosterForGuidance, normalizeEmail, put, requireClassStaff, schoolPK, version, write, type Student, type VerifiedAccount } from './index.js';

type DraftFields = { studentId: string; chapterId: string; cardId: string; observation: string; language: 'en' | 'hi' };
type Chapter = ParentNoteInput['chapter'] & { languages?: string[]; modes?: string[] };
type Lesson = { id: string; language: string; cards: ParentNoteInput['cards'] };
type StaffContext = Awaited<ReturnType<typeof requireClassStaff>>;
type Guard = { staff: StaffContext; child: Student; actor: VerifiedAccount };
export type ParentNoteActivity = { chapterId: string; cardId: string; chapterTitle: string; cardTitle: string; href: string };
export type ParentNoteAssistance = { draftId: string; language: 'en' | 'hi'; activity: ParentNoteActivity };
export type PreparedParentNotePublication = { assistance: ParentNoteAssistance; checks: Parameters<typeof write>[0] };
export type ParentNoteDraft = {
  id: string; schoolId: string; classId: string; authorId: string; fields: DraftFields;
  fingerprint: string; childFingerprint: string; contentFingerprint: string; rosterFingerprint: string;
  version: number; attempt: number; startedAt: string; updatedAt: string;
  result: ParentNoteResult;
};
export type ParentNoteDependencies = {
  authorize(user: VerifiedAccount, schoolId: string, classId: string): Promise<StaffContext>;
  child(schoolId: string, classId: string, childId: string): Promise<Student | null>;
  roster(schoolId: string, classId: string): Promise<{ id: string; name: string }[]>;
  catalog(): Promise<{ chapters: Chapter[] }>;
  lesson(chapterId: string, language: 'en' | 'hi'): Promise<Lesson>;
  read(schoolId: string, classId: string, draftId: string): Promise<ParentNoteDraft | null>;
  save(draft: ParentNoteDraft, expected: number | 'new', guard: Guard): Promise<void>;
  generate(input: ParentNoteInput): Promise<ParentNoteResult>;
  now(): Date;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PK = (schoolId: string, classId: string) => `PARENT_DRAFT#${schoolId}#${classId}`;
const SK = (draftId: string) => `DRAFT#${draftId}`;
const childFingerprint = (child: Student) => hash([child.id, child.name, child.studentEmail, [...child.parentEmails].sort(), child.version, child.active]);
const rosterFingerprint = (roster: { id: string; name: string }[]) => hash([...roster].sort((a, b) => a.id.localeCompare(b.id)));
const empty = (language: 'en' | 'hi', status: ParentNoteResult['status'], code: string, message: string, retryable = false): ParentNoteResult => ({ requestKey: '', status, code, message, retryable, language, model: { id: MODEL_ID, region: MODEL_REGION, inputTokens: 0, outputTokens: 0, usageKnown: false } });

function canonicalChecks(schoolId: string, classId: string, { staff, child, actor }: Guard): Parameters<typeof write>[0] {
  const table = process.env.TABLE_NAME!;
  // The write and these canonical identity checks commit together. A late model
  // response cannot revive a changed roster or revoked teacher assignment.
  const checks: Parameters<typeof write>[0] = [
    { ConditionCheck: { TableName: table, Key: { PK: classPK(schoolId, classId), SK: `STUDENT#${child.id}` }, ConditionExpression: '#active = :yes AND #version = :version AND studentEmail = :email AND #name = :name AND parentEmails = :parents', ExpressionAttributeNames: { '#active': 'active', '#version': 'version', '#name': 'name' }, ExpressionAttributeValues: { ':yes': true, ':version': child.version, ':email': child.studentEmail, ':name': child.name, ':parents': child.parentEmails } } },
    { ConditionCheck: { TableName: table, Key: { PK: schoolPK(schoolId), SK: 'META' }, ConditionExpression: 'adminId = :admin', ExpressionAttributeValues: { ':admin': staff.school.adminId } } },
    { ConditionCheck: { TableName: table, Key: { PK: schoolPK(schoolId), SK: `CLASS#${classId}` }, ConditionExpression: '#version = :version AND teacherEmails = :teachers', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': staff.schoolClass.version, ':teachers': staff.schoolClass.teacherEmails } } },
  ];
  if (staff.role === 'teacher') {
    const email = normalizeEmail(actor.email);
    checks.push({ ConditionCheck: { TableName: table, Key: { PK: schoolPK(schoolId), SK: `TEACHER#${createHash('sha256').update(email).digest('hex')}` }, ConditionExpression: '#active = :yes AND email = :email', ExpressionAttributeNames: { '#active': 'active' }, ExpressionAttributeValues: { ':yes': true, ':email': email } } });
  }
  return checks;
}

const defaults: ParentNoteDependencies = {
  authorize: requireClassStaff,
  child: (schoolId, classId, childId) => get<Student>(classPK(schoolId, classId), `STUDENT#${childId}`),
  roster: listClassRosterForGuidance,
  catalog: () => recommendationContent('catalog.json'),
  lesson: (chapterId, language) => recommendationContent(`lessons/${chapterId}/${language}.json`),
  read: (schoolId, classId, draftId) => get<ParentNoteDraft>(PK(schoolId, classId), SK(draftId)),
  save: async (draft, expected, guard) => {
    await write([put(PK(draft.schoolId, draft.classId), SK(draft.id), draft, expected), ...canonicalChecks(draft.schoolId, draft.classId, guard)]);
  },
  generate: draftParentNote,
  now: () => new Date(),
};

function exactKeys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_FIELD', 'This draft request contains an unsupported field.');
}
function contentId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) return fail(400, 'INVALID_CONTENT', 'Choose an available chapter and lesson idea.');
  return value;
}
function fields(body: Record<string, unknown>): DraftFields {
  if (body.language !== 'en' && body.language !== 'hi') return fail(400, 'INVALID_LANGUAGE', 'Choose English or Hindi for the parent note.');
  if (typeof body.observation !== 'string' || !body.observation.trim() || [...body.observation.trim()].length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.observation)) return fail(400, 'INVALID_OBSERVATION', 'Enter a short observation of up to 600 characters.');
  return { studentId: id(typeof body.studentId === 'string' ? body.studentId : ''), chapterId: contentId(body.chapterId), cardId: contentId(body.cardId), observation: body.observation.trim(), language: body.language };
}
function interrupted(draft: ParentNoteDraft, now: Date) { return draft.result.status === 'processing' && now.getTime() - Date.parse(draft.startedAt) > 60_000; }
function visible(draft: ParentNoteDraft, now: Date) {
  const result = interrupted(draft, now) ? { ...draft.result, status: 'failed' as const, code: 'ATTEMPT_INTERRUPTED', message: 'This draft attempt was interrupted. You can retry; its original usage reservation remains.', retryable: draft.attempt < MAX_ATTEMPTS } : draft.result;
  const activity = result.status === 'ready' && result.activity ? { ...result.activity, href: `/learn/${encodeURIComponent(result.activity.chapterId)}?card=${encodeURIComponent(result.activity.cardId)}` } : undefined;
  return { id: draft.id, version: draft.version, attempt: draft.attempt, status: result.status, language: draft.fields.language, ...(result.status === 'ready' && result.text && activity ? { text: result.text, activity } : {}), retryable: result.retryable && draft.attempt < MAX_ATTEMPTS, code: result.code, message: result.message, model: result.model };
}

/** The injectable storage boundary keeps race/idempotency tests independent of AWS. */
export function createParentNotesService(overrides: Partial<ParentNoteDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  async function authorize(user: VerifiedAccount, schoolId: string, classId: string) {
    if (!user.id || !user.emailVerified) return fail(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before drafting a parent note.');
    return deps.authorize(user, id(schoolId), id(classId));
  }
  async function currentChild(schoolId: string, classId: string, childId: string) {
    const child = await deps.child(schoolId, classId, childId);
    if (!child?.active || child.id !== childId) return fail(403, 'STUDENT_NOT_FOUND', 'This student is no longer active in this class.');
    return child;
  }
  async function authorizedRecord(user: VerifiedAccount, schoolId: string, classId: string, draftId: string) {
    const staff = await authorize(user, schoolId, classId);
    const draft = await deps.read(schoolId, classId, id(draftId));
    if (!draft || draft.authorId !== user.id || draft.schoolId !== schoolId || draft.classId !== classId) return fail(403, 'DRAFT_ACCESS_DENIED', 'This private draft is not available to your account.');
    const child = await currentChild(schoolId, classId, draft.fields.studentId);
    if (childFingerprint(child) !== draft.childFingerprint) return fail(409, 'DRAFT_CHILD_CHANGED', 'This student record changed. Start a new draft from the current roster.');
    return { draft, guard: { staff, child, actor: user } };
  }
  async function source(schoolId: string, classId: string, input: DraftFields) {
    const catalog = await deps.catalog();
    const chapter = catalog.chapters.find(item => item.id === input.chapterId);
    if (!chapter || !(chapter.modes || ['learn']).includes('learn') || (chapter.languages && !chapter.languages.includes(input.language))) return fail(400, 'CHAPTER_UNAVAILABLE', 'Choose an available Learn chapter in the selected language.');
    const lesson = await deps.lesson(chapter.id, input.language);
    const selected = lesson.cards?.find(card => card.id === input.cardId);
    if (lesson.id !== chapter.id || lesson.language !== input.language || !selected || selected.kind === 'check_in' || !selected.lines?.length) return fail(400, 'IDEA_UNAVAILABLE', 'Choose an available lesson idea, rather than a quick check.');
    const roster = await deps.roster(schoolId, classId);
    const content = { chapter: { id: chapter.id, title: chapter.title, description: chapter.description || '', subject: chapter.subject }, cards: lesson.cards.map(card => ({ id: card.id, title: card.title, kind: card.kind, ...(card.partId ? { partId: card.partId } : {}), lines: card.lines.map(line => ({ display: line.display })) })) };
    return { ...content, roster, fingerprint: hash(content), rosterFingerprint: rosterFingerprint(roster) };
  }
  async function run(user: VerifiedAccount, draft: ParentNoteDraft, canonical: Awaited<ReturnType<typeof source>>) {
    let result: ParentNoteResult;
    try {
      const child = await currentChild(draft.schoolId, draft.classId, draft.fields.studentId);
      if (childFingerprint(child) !== draft.childFingerprint) return fail(409, 'DRAFT_CHILD_CHANGED', 'This student record changed. Start a new draft from the current roster.');
      result = await deps.generate({ schoolId: draft.schoolId, classId: draft.classId, draftId: draft.id, actorId: user.id, attempt: draft.attempt, student: { id: child.id, name: child.name }, roster: canonical.roster, chapter: canonical.chapter, cards: canonical.cards, cardId: draft.fields.cardId, observation: draft.fields.observation, language: draft.fields.language });
    } catch (issue) {
      if (issue instanceof SchoolError) throw issue;
      result = empty(draft.fields.language, 'failed', 'DRAFT_FAILED', 'A parent-note draft could not be completed. You can retry or write the note yourself.', true);
    }
    const current = await authorizedRecord(user, draft.schoolId, draft.classId, draft.id);
    if (current.draft.version !== draft.version || current.draft.attempt !== draft.attempt) return visible(current.draft, deps.now());
    const fresh = await source(draft.schoolId, draft.classId, draft.fields);
    if (fresh.fingerprint !== draft.contentFingerprint || fresh.rosterFingerprint !== draft.rosterFingerprint) return fail(409, 'DRAFT_CONTEXT_CHANGED', 'The lesson or class roster changed. Start a new draft with the current information.');
    // Construct activity metadata from the canonical selection, not model-supplied URLs/titles.
    if (result.status === 'ready') {
      const card = fresh.cards.find(item => item.id === draft.fields.cardId)!;
      if (!result.text || result.language !== draft.fields.language || result.activity?.chapterId !== fresh.chapter.id || result.activity.cardId !== card.id) result = { ...empty(draft.fields.language, 'failed', 'INVALID_DRAFT', 'The draft did not match the selected learning activity. Try again or write your note manually.', true), requestKey: result.requestKey, model: result.model };
      else result = { ...result, activity: { chapterId: fresh.chapter.id, cardId: card.id, chapterTitle: fresh.chapter.title, cardTitle: card.title } };
    }
    const completed = { ...draft, result, version: draft.version + 1, updatedAt: deps.now().toISOString() };
    try { await deps.save(completed, draft.version, current.guard); }
    catch (issue) {
      if (!(issue instanceof SchoolError && issue.status === 409)) throw issue;
      const latest = await authorizedRecord(user, draft.schoolId, draft.classId, draft.id);
      if (latest.draft.version !== draft.version) return visible(latest.draft, deps.now());
      throw issue;
    }
    // Also recheck access after the commit before exposing private generated text.
    return visible((await authorizedRecord(user, draft.schoolId, draft.classId, draft.id)).draft, deps.now());
  }
  async function create(user: VerifiedAccount, schoolId: string, classId: string, body: Record<string, unknown>) {
    const staff = await authorize(user, schoolId, classId);
    exactKeys(body, ['clientId', 'studentId', 'chapterId', 'cardId', 'observation', 'language']);
    const draftId = id(typeof body.clientId === 'string' ? body.clientId : ''); const input = fields(body); const fingerprint = hash(input);
    const prior = await deps.read(schoolId, classId, draftId);
    if (prior) {
      const existing = await authorizedRecord(user, schoolId, classId, draftId);
      if (existing.draft.fingerprint !== fingerprint) return fail(409, 'DRAFT_INPUT_CHANGED', 'This draft identifier has different inputs. Start a new draft for the changed observation.');
      return visible(existing.draft, deps.now());
    }
    const child = await currentChild(schoolId, classId, input.studentId); const canonical = await source(schoolId, classId, input);
    const stamp = deps.now().toISOString();
    const draft: ParentNoteDraft = { id: draftId, schoolId, classId, authorId: user.id, fields: input, fingerprint, childFingerprint: childFingerprint(child), contentFingerprint: canonical.fingerprint, rosterFingerprint: canonical.rosterFingerprint, version: 1, attempt: 1, startedAt: stamp, updatedAt: stamp, result: empty(input.language, 'processing', 'IN_PROGRESS', 'Your parent-note draft is being prepared.') };
    try { await deps.save(draft, 'new', { staff, child, actor: user }); }
    catch (issue) {
      if (!(issue instanceof SchoolError && issue.status === 409)) throw issue;
      if (!await deps.read(schoolId, classId, draftId)) throw issue;
      const duplicate = await authorizedRecord(user, schoolId, classId, draftId);
      if (duplicate.draft.fingerprint !== fingerprint) return fail(409, 'DRAFT_INPUT_CHANGED', 'This draft identifier has different inputs. Start a new draft for the changed observation.');
      return visible(duplicate.draft, deps.now());
    }
    return run(user, draft, canonical);
  }
  async function read(user: VerifiedAccount, schoolId: string, classId: string, draftId: string) { return visible((await authorizedRecord(user, schoolId, classId, draftId)).draft, deps.now()); }
  async function retry(user: VerifiedAccount, schoolId: string, classId: string, draftId: string, body: Record<string, unknown>) {
    exactKeys(body, ['version']);
    const { draft, guard } = await authorizedRecord(user, schoolId, classId, draftId);
    if (version(body.version) !== draft.version) return fail(409, 'DRAFT_CHANGED', 'This draft changed. Refresh it before retrying.');
    const shown = visible(draft, deps.now());
    if (draft.attempt >= MAX_ATTEMPTS) return fail(409, 'DRAFT_ATTEMPT_LIMIT', 'This draft has used its three attempts. You can still write the note manually.');
    if (shown.status !== 'failed' || !shown.retryable) return fail(409, 'DRAFT_NOT_RETRYABLE', 'This draft cannot be retried. Refresh its status or write the note manually.');
    const canonical = await source(schoolId, classId, draft.fields);
    if (canonical.fingerprint !== draft.contentFingerprint || canonical.rosterFingerprint !== draft.rosterFingerprint) return fail(409, 'DRAFT_CONTEXT_CHANGED', 'The lesson or class roster changed. Start a new draft with the current information.');
    const stamp = deps.now().toISOString();
    const next = { ...draft, version: draft.version + 1, attempt: draft.attempt + 1, startedAt: stamp, updatedAt: stamp, result: empty(draft.fields.language, 'processing', 'IN_PROGRESS', 'Your parent-note draft is being prepared.') };
    await deps.save(next, draft.version, guard);
    return run(user, next, canonical);
  }
  async function preparePublished(user: VerifiedAccount, schoolId: string, classId: string, studentId: string, draftId: string): Promise<PreparedParentNotePublication> {
    const { draft } = await authorizedRecord(user, schoolId, classId, draftId);
    if (draft.fields.studentId !== studentId) return fail(400, 'DRAFT_STUDENT_MISMATCH', 'Use the draft for the selected child.');
    const dto = visible(draft, deps.now());
    if (dto.status !== 'ready' || !dto.activity || !dto.text) return fail(400, 'DRAFT_NOT_READY', 'Only a ready draft can be attached to a family update.');
    const canonical = await source(schoolId, classId, draft.fields);
    if (canonical.fingerprint !== draft.contentFingerprint) return fail(409, 'DRAFT_CONTEXT_CHANGED', 'The lesson changed. Start a new draft from the current activity.');
    const latest = await authorizedRecord(user, schoolId, classId, draftId);
    if (latest.draft.version !== draft.version) return fail(409, 'DRAFT_CHANGED', 'This draft changed. Refresh before publishing it.');
    const checks = canonicalChecks(schoolId, classId, latest.guard);
    checks.push({ ConditionCheck: {
      TableName: process.env.TABLE_NAME!, Key: { PK: PK(schoolId, classId), SK: SK(draftId) },
      ConditionExpression: '#version = :version AND authorId = :author AND #fields.studentId = :student AND #result.#status = :ready AND fingerprint = :fingerprint AND childFingerprint = :childFingerprint',
      ExpressionAttributeNames: { '#version': 'version', '#fields': 'fields', '#result': 'result', '#status': 'status' },
      ExpressionAttributeValues: { ':version': draft.version, ':author': user.id, ':student': studentId, ':ready': 'ready', ':fingerprint': draft.fingerprint, ':childFingerprint': draft.childFingerprint },
    } });
    return { assistance: { draftId: draft.id, language: draft.fields.language, activity: dto.activity }, checks };
  }
  async function published(user: VerifiedAccount, schoolId: string, classId: string, studentId: string, draftId: string): Promise<ParentNoteAssistance> {
    return (await preparePublished(user, schoolId, classId, studentId, draftId)).assistance;
  }
  return { create, read, retry, published, preparePublished };
}

const service = createParentNotesService();
export const requirePublishedParentNoteDraft = service.published;
/** Append these checks to the same transaction that publishes UPDATE/UPDATEREV. */
export const preparePublishedParentNoteDraft = service.preparePublished;
export async function handleParentNotes(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath.replace(/\/$/, '');
  const match = path.match(/^\/api\/school\/schools\/([^/]+)\/classes\/([^/]+)\/parent-note-drafts(?:\/([^/]+))?(?:\/(retry))?$/);
  if (!match) return fail(404, 'NOT_FOUND', 'This parent-note draft action could not be found.');
  const [, schoolId, classId, draftId, action] = match; const method = event.requestContext.http.method;
  if (!draftId && method === 'POST') return json(200, { draft: await service.create(user, schoolId, classId, bodyOf(event)) });
  if (draftId && !action && method === 'GET') return json(200, { draft: await service.read(user, schoolId, classId, draftId) });
  if (draftId && action === 'retry' && method === 'POST') return json(200, { draft: await service.retry(user, schoolId, classId, draftId, bodyOf(event)) });
  return fail(404, 'NOT_FOUND', 'This parent-note draft action could not be found.');
}
