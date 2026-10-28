import { createHash } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { bindLearnerAccount, classPK, fail, get, id, linkedFamily, normalizeEmail, query, requireFamilyChild, type LearnerAccountBinding, type Student, type VerifiedAccount } from '../school/index.js';
import { recommendationContent } from '../recommendations/content.js';

type Row = Record<string, any>;
type Chapter = { id: string; title: string; subject: string };
type Coverage = { completed: number; total: number; percent: number };
const hash = (email: string) => createHash('sha256').update(normalizeEmail(email)).digest('hex');
const validTime = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const coverage = (ids: Set<string>, total: number): Coverage => ({ completed: ids.size, total, percent: total ? Math.round(ids.size / total * 100) : 0 });
const values = (value: unknown): string[] => value instanceof Set || Array.isArray(value) ? [...value].filter((id): id is string => typeof id === 'string') : [];

async function originActivities(accountId: string, indexes: Row[], chapters: Chapter[]) {
  const result: Row[] = [];
  for (const index of indexes) {
    if (index.kind !== 'report-origin' || index.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(index.recommendationId) || typeof index.studentId !== 'string' || index.SK !== `REPORT_ORIGIN#${index.recommendationId}#${index.studentId}` || !chapters.some(chapter => chapter.id === index.chapterId) || !['learn', 'revise', 'practice'].includes(index.mode)) continue;
    const [meta, activity] = await Promise.all([get<Row>(`RECOMMENDATION#${index.recommendationId}`, 'META'), get<Row>(`RECOMMENDATION#${index.recommendationId}`, `ACTIVITY#${index.studentId}#${accountId}`)]);
    if (!meta || !activity || meta.id !== index.recommendationId || meta.chapterId !== index.chapterId || meta.mode !== index.mode || activity.accountId !== accountId || activity.studentId !== index.studentId || activity.recommendationId !== index.recommendationId) continue;
    // Ownership survives expiry, corrections and old school links. This is not a current-guidance list.
    result.push({ ...activity, chapterId: meta.chapterId, mode: meta.mode });
  }
  return result;
}
export async function buildReport(accountId: string, view: 'self' | 'parent', timeZone: string, fallbackName = 'Your learning') {
  const [catalog, rows] = await Promise.all([recommendationContent<{ chapters: Chapter[] }>('catalog.json'), query(`USER#${accountId}`, '')]);
  const preferences = rows.find(row => row.SK === 'LEARNER_PREFERENCES');
  const origins = await originActivities(accountId, rows.filter(row => row.SK.startsWith('REPORT_ORIGIN#')), catalog.chapters);
  const summary = { chaptersStudied: 0, ideasExplored: 0, cardsRevised: 0, practiceSetsDone: 0 };
  const subjects: { subject: string; title: string; chapters: { id: string; title: string; learn: Coverage; revise: Coverage; practice: { setsSubmitted: number; latest: { score: number; total: 10; submittedAt: string; language: 'en' | 'hi' } | null }; lastStudiedAt: string | null }[] }[] = [];
  for (const chapter of catalog.chapters) {
    const [lesson, revision, bank] = await Promise.all([recommendationContent<{ cards: { id: string }[] }>(`lessons/${chapter.id}/en.json`), recommendationContent<{ cards: { id: string }[] }>(`revise/${chapter.id}/en.json`), recommendationContent<{ questions: { id: string }[] }>(`practice/${chapter.id}/en.json`)]);
    const learnIds = new Set(lesson.cards.map(card => card.id)); const reviseIds = new Set(revision.cards.map(card => card.id)); const questionIds = new Set(bank.questions.map(question => question.id));
    const completed = { learn: new Set<string>(), revise: new Set<string>() }; const timestamps: string[] = []; let studied = false;
    const time = (...values: unknown[]) => { for (const value of values) { const timestamp = validTime(value); if (timestamp) timestamps.push(timestamp); } };
    for (const mode of ['learn', 'revise'] as const) {
      const canonical = mode === 'learn' ? learnIds : reviseIds;
      const ordinary = rows.find(row => row.SK === (mode === 'learn' ? `PROGRESS#${chapter.id}` : `PROGRESS#revise#${chapter.id}`));
      const activityRows = [...(ordinary ? [ordinary] : []), ...origins.filter(row => row.chapterId === chapter.id && row.mode === mode)];
      for (const activity of activityRows) {
        const ids = values(activity.completedCards).filter(card => canonical.has(card));
        ids.forEach(card => completed[mode].add(card));
        if (ids.length || canonical.has(activity.currentCardId) || (activity.recommendationId && validTime(activity.startedAt))) { studied = true; time(activity.updatedAt, activity.startedAt); }
      }
    }
    const sets = rows.filter(row => row.kind === 'practice-set' && row.schemaVersion === 1 && row.contentRelease === 'm2' && row.chapterId === chapter.id && row.SK === `PRACTICE_SET#${chapter.id}#SET#${row.id}` && Array.isArray(row.questionIds) && row.questionIds.length === 10 && new Set(row.questionIds).size === 10 && row.questionIds.every((id: string) => questionIds.has(id)) && ['draft', 'submitted'].includes(row.status));
    for (const set of sets) { studied = true; time(set.createdAt, set.updatedAt, set.submittedAt); }
    const submitted = sets.filter(set => set.status === 'submitted' && Number.isInteger(set.score) && set.score >= 0 && set.score <= 10 && set.total === 10 && validTime(set.submittedAt)).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id));
    const last = submitted[0];
    const legacy = rows.filter(row => row.kind === 'practice-session' && row.chapterId === chapter.id && row.SK === `PRACTICE#${chapter.id}#SESSION#${row.sessionId}`);
    for (const round of legacy) {
      studied = true; time(round.startedAt);
      for (const answer of rows.filter(row => row.kind === 'practice-answer' && row.chapterId === chapter.id && row.sessionId === round.sessionId && row.SK === `PRACTICE#${chapter.id}#SESSION#${round.sessionId}#ANSWER#${row.questionId}` && questionIds.has(row.questionId))) time(answer.answeredAt);
    }
    for (const origin of origins.filter(row => row.chapterId === chapter.id && row.mode === 'practice')) { studied = true; time(origin.startedAt, origin.updatedAt); }
    const result = { id: chapter.id, title: chapter.title, learn: coverage(completed.learn, learnIds.size), revise: coverage(completed.revise, reviseIds.size), practice: { setsSubmitted: submitted.length, latest: last ? { score: last.score as number, total: 10 as const, submittedAt: validTime(last.submittedAt)!, language: (last.submittedLanguage === 'hi' ? 'hi' : 'en') as 'en' | 'hi' } : null }, lastStudiedAt: timestamps.sort().at(-1) || null };
    let subject = subjects.find(subject => subject.subject === chapter.subject);
    if (!subject) { subject = { subject: chapter.subject, title: chapter.subject === 'EVS' ? 'Environmental Studies' : chapter.subject, chapters: [] }; subjects.push(subject); }
    subject.chapters.push(result);
    summary.chaptersStudied += Number(studied); summary.ideasExplored += completed.learn.size; summary.cardsRevised += completed.revise.size; summary.practiceSetsDone += submitted.length;
  }
  return { view, readOnly: view === 'parent', learner: { name: typeof preferences?.displayName === 'string' && preferences.displayName.trim() ? preferences.displayName : fallbackName, language: preferences?.language === 'hi' ? 'hi' as const : 'en' as const }, timeZone, generatedAt: new Date().toISOString(), summary, subjects };
}
async function parentContext(user: VerifiedAccount, schoolId: string, classId: string, studentId: string) {
  const child = await requireFamilyChild(user, schoolId, classId, studentId, 'parent');
  const [roster, binding] = await Promise.all([get<Student>(classPK(schoolId, classId), `STUDENT#${studentId}`), get<LearnerAccountBinding>(classPK(schoolId, classId), `LEARNER_ACCOUNT#${studentId}`)]);
  if (!roster?.active || !roster.parentEmails.includes(normalizeEmail(user.email))) return fail(403, 'CHILD_ACCESS_DENIED', 'This child is no longer linked to your account.');
  if (!binding || binding.kind !== 'learner-account' || binding.schemaVersion !== 1 || binding.schoolId !== schoolId || binding.classId !== classId || binding.studentId !== studentId || binding.emailHash !== hash(roster.studentEmail) || typeof binding.accountId !== 'string' || !binding.accountId) return null;
  const profile = await get<Row>(`USER#${binding.accountId}`, 'PROFILE');
  if (profile?.emailVerified !== true || typeof profile.email !== 'string' || profile.email !== normalizeEmail(roster.studentEmail) || hash(profile.email) !== binding.emailHash) return null;
  const learnerLinks = await linkedFamily({ id: binding.accountId, email: profile.email, emailVerified: true });
  const linked = learnerLinks.student.children[0];
  if (learnerLinks.student.status !== 'linked' || linked.schoolId !== schoolId || linked.classId !== classId || linked.id !== studentId) return null;
  return { child, binding, fingerprint: JSON.stringify([roster.version, roster.studentEmail, roster.parentEmails, binding.accountId, binding.emailHash, binding.boundAt, profile.email, profile.emailVerified]) };
}
export async function handleReports(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount) {
  if (event.requestContext.http.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'Report cards are read-only.');
  if (Object.keys(event.queryStringParameters || {}).length || event.body) return fail(400, 'INVALID_REQUEST', 'Open the report from your own account or current family page.');
  const path = event.rawPath.replace(/\/$/, '');
  if (path === '/api/reports/mine') {
    const child = await bindLearnerAccount(user);
    return { report: await buildReport(user.id, 'self', child?.timeZone || 'Asia/Kolkata') };
  }
  const match = path.match(/^\/api\/school\/family\/parent\/([^/]+)\/([^/]+)\/([^/]+)\/report$/);
  if (!match) return fail(404, 'NOT_FOUND', 'This report could not be found.');
  const [, rawSchool, rawClass, rawStudent] = match; const schoolId = id(rawSchool); const classId = id(rawClass); const studentId = id(rawStudent);
  const context = await parentContext(user, schoolId, classId, studentId);
  if (!context) return { report: null, status: 'learner_not_connected' };
  const report = await buildReport(context.binding.accountId, 'parent', context.child.timeZone, context.child.name);
  const latest = await parentContext(user, schoolId, classId, studentId);
  if (!latest || latest.fingerprint !== context.fingerprint) return fail(409, 'REPORT_LINK_CHANGED', 'The school connection changed. Refresh the family page before opening this report.');
  return { report };
}
