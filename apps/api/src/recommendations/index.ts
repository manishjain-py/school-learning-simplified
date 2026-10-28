import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { interpretTeacherLog, type GuidanceCandidate, type InterpretationResult } from '../ai/index.js';
import { schoolLocalDate } from '../ai/dates.js';
import { SchoolError, linkedFamily, requireClassStaff, requireFamilyChild, listClassRosterForGuidance, type VerifiedAccount, type ChildLink } from '../school/index.js';
import { getSchoolLog, saveLogGuidance, type SchoolLog } from '../school/communication.js';
import { recommendationCatalog, recommendationContent } from './content.js';
import { pairTestGuidance } from './test-plans.js';
import { reportOriginRow } from '../reports/origins.js';

type Row = Record<string, any>;
type Mode = 'learn' | 'practice' | 'revise';
type Recommendation = Omit<GuidanceCandidate, 'datePhrase' | 'id'> & {
  id: string; schoolId: string; classId: string; logId: string; version: number; authorId: string; createdAt: string;
};
type Snapshot = { version: number; attempt: number; status: string; startedAt: string; recommendationIds: string[]; allRecommendationIds: string[]; unresolved: InterpretationResult['unresolved']; retryable: boolean; model?: InterpretationResult['model'] };
export type OriginActivity = { recommendationId: string; studentId: string; accountId: string; studentEmailHash: string; startedAt: string; updatedAt: string; language: 'en' | 'hi'; currentCardId: string | null; completedCards: Set<string>; sessionId?: string; practiceSetId?: string };
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-2' }));
const table = () => process.env.TABLE_NAME!;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const recPK = (id: string) => `RECOMMENDATION#${id}`;
const snapshotKey = (log: Pick<SchoolLog, 'schoolId' | 'classId' | 'id' | 'version'>) => ({ PK: `GUIDANCE#${log.schoolId}#${log.classId}`, SK: `LOG#${log.id}#V#${String(log.version).padStart(6, '0')}` });
const activityKey = (rec: Recommendation, child: ChildLink, user: VerifiedAccount) => ({ PK: recPK(rec.id), SK: `ACTIVITY#${child.id}#${user.id}` });
const fail = (status: number, code: string, message: string): never => { throw new SchoolError(status, code, message); };
const now = () => new Date().toISOString();
async function get<T>(key: { PK: string; SK: string }): Promise<T | null> { return (await db.send(new GetCommand({ TableName: table(), Key: key, ConsistentRead: true }))).Item as T || null; }
async function query(PK: string, prefix: string): Promise<Row[]> {
  const rows: Row[] = []; let cursor: Row | undefined;
  do { const page = await db.send(new QueryCommand({ TableName: table(), KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': PK, ':prefix': prefix }, ConsistentRead: true, ExclusiveStartKey: cursor })); rows.push(...page.Items || []); cursor = page.LastEvaluatedKey; } while (cursor);
  return rows;
}
function currentLogCondition(log: Pick<SchoolLog, 'schoolId' | 'classId' | 'id' | 'version'>) {
  return { ConditionCheck: { TableName: table(), Key: { PK: `COMM#${log.schoolId}#${log.classId}`, SK: `LOG#${log.id}` }, ConditionExpression: '#version = :version', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': log.version } } };
}
async function transaction(items: NonNullable<TransactWriteCommandInput['TransactItems']>) {
  try { await db.send(new TransactWriteCommand({ TransactItems: items })); }
  catch (error) { if ((error as Error).name === 'TransactionCanceledException') fail(409, 'GUIDANCE_CHANGED', 'The classroom guidance changed. Refresh and try again.'); throw error; }
}
const guidanceState = (snapshot: Snapshot) => ({ status: snapshot.status, interrupted: snapshot.status === 'processing' && Date.now() - Date.parse(snapshot.startedAt) > 60_000, attempt: snapshot.attempt, publishedCount: snapshot.recommendationIds.length, unresolved: snapshot.unresolved, retryable: snapshot.retryable, model: snapshot.model || null, message: snapshot.status === 'processing' ? 'Llama is interpreting this note.' : snapshot.recommendationIds.length ? 'Valid learning guidance is published automatically.' : 'No learning guidance has been published from this note.' });

/** The school log is already saved. All publication is guarded against its current revision. */
export async function processTeacherLog(log: SchoolLog, actor: VerifiedAccount, requestedAttempt?: number, dependencies: { interpret?: typeof interpretTeacherLog } = {}): Promise<SchoolLog> {
  await requireClassStaff(actor, log.schoolId, log.classId);
  const canonical = await getSchoolLog(log.schoolId, log.classId, log.id);
  if (canonical.version !== log.version) return canonical;
  const key = snapshotKey(log); const previous = await get<Snapshot>(key);
  const attempt = requestedAttempt || previous?.attempt || 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 3) return fail(400, 'RETRY_LIMIT', 'Each note revision allows up to three interpretation attempts.');
  if (previous && attempt === previous.attempt) {
    if (previous.status !== 'processing' || Date.now() - Date.parse(previous.startedAt) < 60_000) return canonical;
    // An interrupted invocation is re-read through the engine's idempotent ledger.
  } else {
    if (previous && (attempt !== previous.attempt + 1 || !previous.retryable || previous.status === 'processing')) return fail(409, 'RETRY_CHANGED', 'Refresh this note before retrying its interpretation.');
    if (!previous && attempt !== 1) return fail(409, 'RETRY_CHANGED', 'Start with the first interpretation attempt.');
    const claimed: Snapshot = { version: log.version, attempt, status: 'processing', startedAt: now(), recommendationIds: previous?.recommendationIds || [], allRecommendationIds: previous?.allRecommendationIds || [], unresolved: [], retryable: false };
    try { await transaction([currentLogCondition(log), { Put: { TableName: table(), Item: { ...key, ...claimed }, ConditionExpression: previous ? 'attempt = :attempt AND #status <> :processing' : 'attribute_not_exists(PK)', ...(previous ? { ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':attempt': previous.attempt, ':processing': 'processing' } } : {}) } }]); }
    catch (error) { if (error instanceof SchoolError && error.status === 409) return getSchoolLog(log.schoolId, log.classId, log.id); throw error; }
    await saveLogGuidance(log, guidanceState(claimed));
  }
  const [roster, catalog] = await Promise.all([listClassRosterForGuidance(log.schoolId, log.classId), recommendationCatalog()]);
  const result = await (dependencies.interpret || interpretTeacherLog)({ actorId: actor.id, schoolId: log.schoolId, classId: log.classId, logId: log.id, version: log.version, attempt, subject: log.subject, note: log.note, localDate: log.localDate, timeZone: log.timeZone, roster, catalog });
  if (result.status === 'processing') return getSchoolLog(log.schoolId, log.classId, log.id);
  // Validate against fresh authoritative membership and catalog after inference as well.
  await requireClassStaff(actor, log.schoolId, log.classId);
  const [currentRoster, currentCatalog] = await Promise.all([listClassRosterForGuidance(log.schoolId, log.classId), recommendationCatalog()]);
  const issues = [...result.unresolved]; const records: Recommendation[] = [];
  for (const candidate of result.guidance) {
    const available = currentCatalog.some(chapter => chapter.id === candidate.chapterId && chapter.modes.includes(candidate.mode));
    const audience = candidate.audience.type === 'class' || currentRoster.some(student => student.id === (candidate.audience as { studentId: string }).studentId);
    if (!available || !audience) { issues.push({ code: 'CONTEXT_CHANGED', message: 'A recommended activity or student is no longer available. Correct this note.' }); continue; }
    const { datePhrase: _privatePhrase, id: candidateId, ...safe } = candidate;
    records.push({ ...safe, id: hash(`${log.schoolId}|${log.classId}|${log.id}|${log.version}|${candidateId}`), schoolId: log.schoolId, classId: log.classId, logId: log.id, version: log.version, authorId: log.authorId, createdAt: now() });
  }
  const activeIds = result.status === 'failed' ? previous?.recommendationIds || [] : records.map(record => record.id);
  const final: Snapshot = { version: log.version, attempt, status: result.status === 'ready' && !issues.length ? 'published' : result.status === 'failed' ? 'failed' : 'unresolved', startedAt: now(), recommendationIds: activeIds,
    allRecommendationIds: [...new Set([...(previous?.allRecommendationIds || []), ...activeIds])], unresolved: issues, retryable: (result.retryable || records.length < result.guidance.length) && attempt < 3, model: result.model };
  try {
    await transaction([currentLogCondition(log), { Put: { TableName: table(), Item: { ...key, ...final }, ConditionExpression: 'attempt = :attempt AND #status = :processing', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':attempt': attempt, ':processing': 'processing' } } },
      ...records.map(record => ({ Put: { TableName: table(), Item: { PK: recPK(record.id), SK: 'META', ...record } } }))]);
    await saveLogGuidance(log, guidanceState(final));
  } catch (error) { if (!(error instanceof SchoolError && error.status === 409)) throw error; }
  return getSchoolLog(log.schoolId, log.classId, log.id);
}

async function recommendation(id: string): Promise<Recommendation> {
  if (!/^[a-f0-9]{64}$/.test(id)) return fail(404, 'GUIDANCE_NOT_FOUND', 'This learning recommendation is unavailable.');
  const record = await get<Recommendation>({ PK: recPK(id), SK: 'META' });
  if (!record) return fail(404, 'GUIDANCE_NOT_FOUND', 'This learning recommendation is unavailable.'); return record;
}
async function active(record: Recommendation) {
  const log = await getSchoolLog(record.schoolId, record.classId, record.logId);
  const snapshot = await get<Snapshot>(snapshotKey({ ...log, version: record.version }));
  return log.version === record.version && Boolean(snapshot?.recommendationIds.includes(record.id)) && (await recommendationCatalog()).some(chapter => chapter.id === record.chapterId && chapter.modes.includes(record.mode));
}
function safeRecommendation(record: Recommendation) {
  // Explicit family whitelist: never raw notes, date phrases, audience IDs, source text or model diagnostics.
  return { id: record.id, chapterId: record.chapterId, mode: record.mode, kind: record.kind, date: record.date, title: record.title, reason: record.reason };
}
export async function requireOrigin(user: VerifiedAccount, id: string, chapterId: string, mode: Mode, started = true) {
  const record = await recommendation(id);
  if (record.chapterId !== chapterId || record.mode !== mode) return fail(409, 'ORIGIN_MISMATCH', 'Open the activity linked to this recommendation.');
  const links = await linkedFamily(user);
  if (links.student.status !== 'linked') return fail(403, 'STUDENT_LINK_REQUIRED', 'Use the verified student account linked to this recommendation.');
  const child = await requireFamilyChild(user, record.schoolId, record.classId, links.student.children[0].id, 'student');
  if (record.audience.type === 'student' && record.audience.studentId !== child.id) return fail(403, 'GUIDANCE_ACCESS_DENIED', 'This recommendation belongs to another student.');
  if (!await active(record)) return fail(409, 'GUIDANCE_SUPERSEDED', 'Your teacher updated this guidance. Open your latest recommendations.');
  const key = activityKey(record, child, user); const activity = await get<OriginActivity>(key);
  if (started && !activity) return fail(409, 'ORIGIN_NOT_STARTED', 'Open this recommendation from your homepage first.');
  return { record, child, key, activity };
}
function reportIndexWrite(user: VerifiedAccount, record: Recommendation, child: ChildLink) {
  return { Put: { TableName: table(), Item: reportOriginRow(user.id, child.id, record) } };
}
function activityOwnerCondition(user: VerifiedAccount, record: Recommendation, child: ChildLink) {
  return { ConditionCheck: { TableName: table(), Key: activityKey(record, child, user), ConditionExpression: 'accountId = :owner AND studentId = :student AND recommendationId = :recommendation', ExpressionAttributeValues: { ':owner': user.id, ':student': child.id, ':recommendation': record.id } } };
}
export async function startOrigin(user: VerifiedAccount, id: string, guards: NonNullable<TransactWriteCommandInput['TransactItems']> = []) {
  const record = await recommendation(id); const context = await requireOrigin(user, id, record.chapterId, record.mode, false);
  if (!context.activity) {
    const timestamp = now();
    const activity: Omit<OriginActivity, 'completedCards'> = { recommendationId: id, studentId: context.child.id, accountId: user.id, studentEmailHash: hash(user.email.trim().toLowerCase()), startedAt: timestamp, updatedAt: timestamp, currentCardId: null, language: 'en' };
    const writes: NonNullable<TransactWriteCommandInput['TransactItems']> = [currentLogCondition({ ...record, id: record.logId }), ...guards, { Put: { TableName: table(), Item: { ...context.key, ...activity }, ConditionExpression: 'attribute_not_exists(PK)' } }, reportIndexWrite(user, record, context.child)];
    try { await transaction(writes); } catch (error) {
      if (!(error instanceof SchoolError && error.status === 409) || !await get<OriginActivity>(context.key)) throw error;
      await transaction([currentLogCondition({ ...record, id: record.logId }), ...guards, activityOwnerCondition(user, record, context.child), reportIndexWrite(user, record, context.child)]);
    }
  } else await transaction([currentLogCondition({ ...record, id: record.logId }), ...guards, activityOwnerCondition(user, record, context.child), reportIndexWrite(user, record, context.child)]);
  return { recommendation: safeRecommendation(record), activity: await get<OriginActivity>(context.key) };
}
export async function originProgress(user: VerifiedAccount, id: string, chapterId: string, mode: 'learn' | 'revise', body?: Row) {
  const { record, key, activity, child } = await requireOrigin(user, id, chapterId, mode);
  if (body) {
    if (!['en', 'hi'].includes(body.language)) return fail(400, 'INVALID_LANGUAGE', 'Choose English or Hindi.');
    const content = await recommendationContent<{ cards: { id: string }[] }>(`${mode === 'learn' ? 'lessons' : 'revise'}/${chapterId}/${body.language}.json`);
    const ids = new Set(content.cards.map(card => card.id));
    if (typeof body.currentCardId !== 'string' || !ids.has(body.currentCardId) || !Array.isArray(body.completedCardIds) || body.completedCardIds.length > ids.size || body.completedCardIds.some((card: unknown) => typeof card !== 'string' || !ids.has(card))) return fail(400, 'INVALID_PROGRESS', 'The progress update does not match this recommended activity.');
    const completed = [...new Set(body.completedCardIds as string[])];
    await transaction([currentLogCondition({ ...record, id: record.logId }), { Update: { TableName: table(), Key: key, ConditionExpression: 'accountId = :owner', UpdateExpression: `SET currentCardId = :card, #language = :language, updatedAt = :now${completed.length ? ' ADD completedCards :cards' : ''}`, ExpressionAttributeNames: { '#language': 'language' }, ExpressionAttributeValues: { ':owner': user.id, ':card': body.currentCardId, ':language': body.language, ':now': now(), ...(completed.length ? { ':cards': new Set(completed) } : {}) } } }, reportIndexWrite(user, record, child)]);
  } else await transaction([currentLogCondition({ ...record, id: record.logId }), activityOwnerCondition(user, record, child), reportIndexWrite(user, record, child)]);
  const saved = body ? (await get<OriginActivity>(key))! : activity!;
  return { chapterId, currentCardId: saved.currentCardId, completedCardIds: [...saved.completedCards || []], language: saved.language, updatedAt: saved.updatedAt };
}
export async function originPractice(user: VerifiedAccount, id: string, chapterId: string, sessionId?: string, language?: 'en' | 'hi') {
  const context = await requireOrigin(user, id, chapterId, 'practice');
  if (sessionId && context.activity!.sessionId !== sessionId) return fail(409, 'ORIGIN_SESSION_MISMATCH', 'Use the practice round opened from this recommendation.');
  if (language) await transaction([currentLogCondition({ ...context.record, id: context.record.logId }), { Update: { TableName: table(), Key: context.key, ConditionExpression: 'accountId = :owner', UpdateExpression: 'SET #language = :language, updatedAt = :now', ExpressionAttributeNames: { '#language': 'language' }, ExpressionAttributeValues: { ':owner': user.id, ':language': language, ':now': now() } } }, reportIndexWrite(user, context.record, context.child)]);
  else await transaction([currentLogCondition({ ...context.record, id: context.record.logId }), activityOwnerCondition(user, context.record, context.child), reportIndexWrite(user, context.record, context.child)]);
  return context;
}
export function originCondition(record: Recommendation) { return currentLogCondition({ ...record, id: record.logId }); }

async function currentFamilyGuidance(child: ChildLink, role: 'student' | 'parent', user: VerifiedAccount) {
  child = await requireFamilyChild(user, child.schoolId, child.classId, child.id, role);
  const localToday = schoolLocalDate(new Date(), child.timeZone);
  const snapshots = await query(`GUIDANCE#${child.schoolId}#${child.classId}`, 'LOG#'); const records: Recommendation[] = [];
  for (const id of new Set<string>(snapshots.flatMap(snapshot => snapshot.recommendationIds || []))) {
    const record = await recommendation(id);
    // Expiry changes the family's current next steps only. Keep origin access and
    // teacher history governed by revision/membership, without deleting old work.
    if (record.schoolId !== child.schoolId || record.classId !== child.classId || (record.date && record.date < localToday) || (record.audience.type === 'student' && record.audience.studentId !== child.id) || !await active(record)) continue;
    records.push(record);
  }
  return { child, localToday, records, snapshots };
}
async function familyRecommendations(child: ChildLink, role: 'student' | 'parent', user: VerifiedAccount) {
  const context = await currentFamilyGuidance(child, role, user); child = context.child;
  const recommendations = context.records.map(safeRecommendation);
  recommendations.sort((a,b)=>(a.date || '9999').localeCompare(b.date || '9999') || a.title.localeCompare(b.title));
  const testPlans = pairTestGuidance(context.records, await recommendationCatalog(), context.localToday).map(pair => pair.plan);
  return { child: { id: child.id, name: child.name, className: child.className, schoolName: child.schoolName }, timeZone: child.timeZone, localToday: context.localToday, recommendations, testPlans };
}
async function startTestPlan(user: VerifiedAccount, id: string, input: Row) {
  if (!['revise', 'practice'].includes(input.step) || Object.keys(input).some(field => !['step', 'recommendationId'].includes(field))) return fail(400, 'INVALID_REQUEST', 'Choose a step from this test plan.');
  const links = await linkedFamily(user);
  if (links.student.status !== 'linked') return fail(403, 'STUDENT_LINK_REQUIRED', 'Use the verified student account linked to this test plan.');
  const context = await currentFamilyGuidance(links.student.children[0], 'student', user);
  const pair = pairTestGuidance(context.records, await recommendationCatalog(), schoolLocalDate(new Date(), context.child.timeZone)).find(pair => pair.plan.id === id);
  if (!pair) return fail(409, 'TEST_PLAN_CHANGED', 'This test plan changed or its date passed. Open your latest school guidance.');
  if ((input.step === 'practice' || input.recommendationId !== undefined) && input.recommendationId !== pair.plan.reviseId) return fail(409, 'ORIGIN_MISMATCH', 'Continue from the revision activity in this test plan.');
  const snapshot = context.snapshots.find(snapshot => snapshot.SK === snapshotKey({ ...pair.revise, id: pair.revise.logId }).SK);
  if (!snapshot) return fail(409, 'TEST_PLAN_CHANGED', 'Refresh your latest school guidance.');
  const guards: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    { ConditionCheck: { TableName: table(), Key: snapshotKey({ ...pair.revise, id: pair.revise.logId }), ConditionExpression: 'recommendationIds = :ids', ExpressionAttributeValues: { ':ids': snapshot.recommendationIds } } },
    { ConditionCheck: { TableName: table(), Key: { PK: `CLASS#${context.child.schoolId}#${context.child.classId}`, SK: `STUDENT#${context.child.id}` }, ConditionExpression: '#active = :active AND studentEmail = :email', ExpressionAttributeNames: { '#active': 'active' }, ExpressionAttributeValues: { ':active': true, ':email': user.email.trim().toLowerCase() } } },
  ];
  if (input.step === 'practice') {
    const revision = await requireOrigin(user, pair.plan.reviseId, pair.plan.chapterId, 'revise');
    const activity = revision.activity!;
    const content = await recommendationContent<{ cards: { id: string }[] }>(`revise/${pair.plan.chapterId}/en.json`);
    const cards = new Set(content.cards.map(card => card.id));
    if (!cards.size) return fail(503, 'REVISION_UNAVAILABLE', 'Revision cards are temporarily unavailable.');
    if (activity.accountId !== user.id || activity.studentId !== context.child.id || activity.recommendationId !== pair.plan.reviseId || activity.studentEmailHash !== hash(user.email.trim().toLowerCase()) || !(activity.completedCards instanceof Set) || [...cards].some(card => !activity.completedCards.has(card))) return fail(409, 'REVISION_INCOMPLETE', 'Review every revision card and wait for your progress to save before continuing.');
    guards.push({ ConditionCheck: { TableName: table(), Key: revision.key, ConditionExpression: 'accountId = :owner AND studentEmailHash = :email AND completedCards = :completed', ExpressionAttributeValues: { ':owner': user.id, ':email': activity.studentEmailHash, ':completed': activity.completedCards } } });
  }
  if (pair.plan.date < schoolLocalDate(new Date(), context.child.timeZone)) return fail(409, 'TEST_PLAN_CHANGED', 'The test date passed. Open your latest school guidance.');
  const opened = await startOrigin(user, input.step === 'revise' ? pair.plan.reviseId : pair.plan.practiceId, guards);
  return { recommendation: opened.recommendation };
}
async function activitySummary(record: Recommendation, row: Row) {
  if (record.mode === 'practice') {
    if (row.practiceSetId) {
      const set = await get<Row>({ PK: `USER#${row.accountId}`, SK: `PRACTICE_SET#${record.chapterId}#SET#${row.practiceSetId}` });
      if (!set || set.kind !== 'practice-set' || set.id !== row.practiceSetId || set.chapterId !== record.chapterId || set.recommendationId !== record.id || set.studentId !== row.studentId || set.studentEmailHash !== row.studentEmailHash) return { status: 'started', startedAt: row.startedAt, total: 10 };
      const answered = set.questionIds.filter((id: string) => set.answers[id]?.length).length;
      return set.status === 'submitted' ? { status: 'submitted', setId: set.id, startedAt: row.startedAt, submittedAt: set.submittedAt, answered: set.answered, total: set.total, correct: set.score } : { status: 'started', setId: set.id, startedAt: row.startedAt, answered, total: set.total };
    }
    if (!row.sessionId) return { status: 'started', startedAt: row.startedAt, total: 10 };
    const prefix = `PRACTICE#${record.chapterId}#SESSION#${row.sessionId}`;
    const rows = await query(`USER#${row.accountId}`, prefix);
    const meta = rows.find(item => item.SK === prefix);
    if (!meta || meta.recommendationId !== record.id || meta.studentId !== row.studentId) return { status: 'started', startedAt: row.startedAt };
    const bank = await recommendationContent<{ questions: { id: string }[] }>(`practice/${record.chapterId}/en.json`);
    const questions = new Set(bank.questions.map(question => question.id));
    const answers = rows.filter(item => item.kind === 'practice-answer' && questions.has(item.questionId));
    return { status: answers.length === questions.size ? 'completed' : 'started', startedAt: row.startedAt, answered: answers.length, total: questions.size, correct: answers.filter(item => item.correct === true).length };
  }
  const content = await recommendationContent<{ cards: { id: string }[] }>(`${record.mode === 'learn' ? 'lessons' : 'revise'}/${record.chapterId}/en.json`);
  const cards = new Set(content.cards.map(card => card.id)); const completed = [...(row.completedCards || [])].filter(id=>cards.has(id)).length;
  return { status: completed === cards.size ? 'completed' : 'started', startedAt: row.startedAt, completed, total: cards.size };
}
async function teacherResults(user: VerifiedAccount, schoolId: string, classId: string, logId: string) {
  await requireClassStaff(user, schoolId, classId); const log = await getSchoolLog(schoolId, classId, logId);
  if (log.authorId !== user.id) return fail(403, 'LOG_AUTHOR_REQUIRED', 'Learning outcomes are available to the teacher who wrote this note.');
  const roster = (await query(`CLASS#${schoolId}#${classId}`, 'STUDENT#')).filter(student => student.active); const snapshots = await query(`GUIDANCE#${schoolId}#${classId}`, `LOG#${logId}#V#`); const recommendations = [];
  for (const snapshot of snapshots) for (const id of snapshot.allRecommendationIds || []) {
    const record = await recommendation(id); const activities = await query(recPK(id), 'ACTIVITY#'); const learners = [];
    for (const student of roster) {
      if (record.audience.type === 'student' && record.audience.studentId !== student.id) continue;
      const rows = activities.filter(row => row.studentId === student.id && row.studentEmailHash === hash(student.studentEmail));
      learners.push({ studentId: student.id, name: student.name, results: rows.length ? await Promise.all(rows.map(row => activitySummary(record, row))) : [{ status: 'not_started' }] });
    }
    recommendations.push({ ...safeRecommendation(record), version: record.version, superseded: !await active(record), learners });
  }
  const snapshot = await get<Snapshot>(snapshotKey(log));
  return { version: log.version, guidance: snapshot ? guidanceState(snapshot) : log.guidance, recommendations };
}
function body(event: APIGatewayProxyEventV2WithJWTAuthorizer) { try { const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '{}'; if (raw.length > 2000) throw new Error(); const data = JSON.parse(raw); if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error(); return data as Row; } catch { return fail(400, 'INVALID_REQUEST', 'This learning request could not be read.'); } }
export async function handleRecommendations(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount) {
  const path = event.rawPath.replace(/\/$/,''); const method = event.requestContext.http.method;
  if (path === '/api/school/recommendations/mine' && method === 'GET') {
    const links = await linkedFamily(user);
    return { studentStatus: links.student.status, student: await Promise.all(links.student.children.map(child => familyRecommendations(child,'student',user))), parent: await Promise.all(links.parent.children.map(child=>familyRecommendations(child,'parent',user))) };
  }
  const testPlan = path.match(/^\/api\/school\/recommendations\/test-plans\/([a-f0-9]{64})\/start$/);
  if (testPlan && method === 'POST') return startTestPlan(user, testPlan[1], body(event));
  const start = path.match(/^\/api\/school\/recommendations\/([a-f0-9]{64})\/start$/);
  if (start && method === 'POST') { const opened = await startOrigin(user,start[1]); return { recommendation: opened.recommendation }; }
  const staff = path.match(/^\/api\/school\/recommendations\/([^/]+)\/([^/]+)\/logs\/([^/]+)\/(results|retry)$/);
  if (staff) {
    await requireClassStaff(user,staff[1],staff[2]); const log = await getSchoolLog(staff[1],staff[2],staff[3]);
    if (log.authorId !== user.id) return fail(403,'LOG_AUTHOR_REQUIRED','Learning outcomes are available to the teacher who wrote this note.');
    if (method === 'GET' && staff[4] === 'results') return teacherResults(user,staff[1],staff[2],staff[3]);
    if (method === 'POST' && staff[4] === 'retry') { const input = body(event); if (input.version !== log.version) return fail(409,'LOG_CHANGED','This note was corrected. Refresh before retrying.'); await processTeacherLog(log,user,input.attempt); return teacherResults(user,staff[1],staff[2],staff[3]); }
  }
  return fail(404,'NOT_FOUND','This learning guidance page could not be found.');
}
