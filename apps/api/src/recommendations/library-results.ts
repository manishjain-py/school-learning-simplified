import { createHash } from 'node:crypto';
import { classPK, fail, get, linkedFamily, normalizeEmail, query, type LearnerAccountBinding, type Student } from '../school/index.js';
import { recommendationContent } from './content.js';

type Row = Record<string, any>;
type Mode = 'learn' | 'practice' | 'revise';
export type LibraryResult = { source: 'library'; status: 'started' | 'completed' | 'submitted'; recordedAt: string; completed?: number; answered?: number; correct?: number; total: number };
type Context = { accountId: string; fingerprint: string };
const hash = (email: string) => createHash('sha256').update(email).digest('hex');
const timestamp = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const cardIds = (value: unknown): string[] => value instanceof Set || Array.isArray(value) ? [...value].filter((id): id is string => typeof id === 'string') : [];

/** A roster binding discovers the account; the current profile and unique family link authorize it. */
async function context(schoolId: string, classId: string, student: Student): Promise<Context | null> {
  const PK = classPK(schoolId, classId);
  const [roster, binding] = await Promise.all([get<Student>(PK, `STUDENT#${student.id}`), get<LearnerAccountBinding>(PK, `LEARNER_ACCOUNT#${student.id}`)]);
  if (!roster?.active || roster.version !== student.version || roster.studentEmail !== student.studentEmail || roster.name !== student.name) return null;
  const email = normalizeEmail(roster.studentEmail);
  if (!binding || binding.kind !== 'learner-account' || binding.schemaVersion !== 1 || binding.schoolId !== schoolId || binding.classId !== classId || binding.studentId !== student.id || binding.emailHash !== hash(email) || typeof binding.accountId !== 'string' || !binding.accountId) return null;
  const profile = await get<Row>(`USER#${binding.accountId}`, 'PROFILE');
  if (profile?.emailVerified !== true || profile.email !== email) return null;
  const family = await linkedFamily({ id: binding.accountId, email, emailVerified: true });
  const child = family.student.children[0];
  if (family.student.status !== 'linked' || !child || child.schoolId !== schoolId || child.classId !== classId || child.id !== student.id) return null;
  return { accountId: binding.accountId, fingerprint: JSON.stringify([roster.version, roster.studentEmail, roster.name, binding.accountId, binding.emailHash, binding.boundAt, profile.email, profile.emailVerified]) };
}

async function latestLibraryResult(accountId: string, chapterId: string, mode: Mode): Promise<LibraryResult | null> {
  const PK = `USER#${accountId}`;
  if (mode === 'practice') {
    const [rows, content] = await Promise.all([query(PK, `PRACTICE_SET#${chapterId}#SET#`), recommendationContent<{ questions: { id: string }[] }>(`practice/${chapterId}/en.json`)]);
    const ids = new Set(content.questions.map(question => question.id));
    const sets = rows.filter(row => row.PK === PK && row.kind === 'practice-set' && row.schemaVersion === 1 && row.contentRelease === 'm2' && row.chapterId === chapterId && typeof row.id === 'string' && row.SK === `PRACTICE_SET#${chapterId}#SET#${row.id}` && row.recommendationId === undefined && row.studentId === undefined && row.studentEmailHash === undefined && Array.isArray(row.questionIds) && row.questionIds.length === 10 && new Set(row.questionIds).size === 10 && row.questionIds.every((id: unknown) => typeof id === 'string' && ids.has(id)) && row.total === 10);
    const submitted = sets.filter(row => row.status === 'submitted' && Number.isInteger(row.score) && row.score >= 0 && row.score <= 10 && timestamp(row.submittedAt)).sort((a, b) => timestamp(b.submittedAt)!.localeCompare(timestamp(a.submittedAt)!) || b.id.localeCompare(a.id));
    const final = submitted[0];
    if (final) return { source: 'library', status: 'submitted', recordedAt: timestamp(final.submittedAt)!, correct: final.score, total: 10 };
    const drafts = sets.filter(row => row.status === 'draft' && timestamp(row.updatedAt)).sort((a, b) => timestamp(b.updatedAt)!.localeCompare(timestamp(a.updatedAt)!) || b.id.localeCompare(a.id));
    const draft = drafts[0];
    if (!draft) return null;
    const answered = draft.questionIds.filter((id: string) => Array.isArray(draft.answers?.[id]) && draft.answers[id].some((value: unknown) => typeof value === 'string' && value)).length;
    return { source: 'library', status: 'started', recordedAt: timestamp(draft.updatedAt)!, answered, total: 10 };
  }
  const SK = mode === 'learn' ? `PROGRESS#${chapterId}` : `PROGRESS#revise#${chapterId}`;
  const [row, content] = await Promise.all([get<Row>(PK, SK), recommendationContent<{ cards: { id: string }[] }>(`${mode === 'learn' ? 'lessons' : 'revise'}/${chapterId}/en.json`)]);
  if (!row || row.PK !== PK || row.SK !== SK || row.chapterId !== chapterId || !timestamp(row.updatedAt)) return null;
  const ids = new Set(content.cards.map(card => card.id));
  const completed = new Set(cardIds(row.completedCards).filter(id => ids.has(id))).size;
  if (!completed && !ids.has(row.currentCardId)) return null;
  // Coverage is cumulative: updatedAt does not prove every card was completed after the note.
  return { source: 'library', status: completed === ids.size ? 'completed' : 'started', recordedAt: timestamp(row.updatedAt)!, completed, total: ids.size };
}

/** Request-local caching avoids reading a learner's same chapter/mode for every note revision. */
export function libraryResultsReader(schoolId: string, classId: string) {
  const contexts = new Map<string, { student: Student; value: Promise<Context | null> }>();
  const summaries = new Map<string, Promise<LibraryResult | null>>();
  return {
    async summary(student: Student, chapterId: string, mode: Mode) {
      let entry = contexts.get(student.id);
      if (!entry) { entry = { student, value: context(schoolId, classId, student) }; contexts.set(student.id, entry); }
      const bound = await entry.value;
      if (!bound) return null;
      const key = JSON.stringify([student.id, chapterId, mode]);
      let result = summaries.get(key);
      if (!result) { result = latestLibraryResult(bound.accountId, chapterId, mode); summaries.set(key, result); }
      return result;
    },
    async verify() {
      for (const { student, value } of contexts.values()) {
        const previous = await value;
        if (!previous) continue;
        const latest = await context(schoolId, classId, student);
        if (!latest || latest.fingerprint !== previous.fingerprint) fail(409, 'RESULTS_LINK_CHANGED', 'A student connection changed. Refresh these learning results.');
      }
    },
  };
}
