import { createHash } from 'node:crypto';
import { isCalendarDate } from '../ai/dates.js';
import type { CatalogEntry, GuidanceCandidate } from '../ai/types.js';

type Candidate = Pick<GuidanceCandidate, 'id' | 'chapterId' | 'mode' | 'kind' | 'date' | 'audience'> & { schoolId: string; classId: string; logId: string; version: number };
export type TestPlan = { id: string; chapterId: string; chapterTitle: string; subject: string; date: string; reviseId: string; practiceId: string };

/** Input already passed current-family/revision checks. Never pair across source or audience. */
export function pairTestGuidance<T extends Candidate>(records: T[], catalog: CatalogEntry[], localToday: string) {
  const groups = new Map<string, Map<string, T>>();
  for (const record of records) {
    if (record.kind !== 'test' || !record.date || !isCalendarDate(record.date) || record.date < localToday || !['revise', 'practice'].includes(record.mode)) continue;
    const identity = JSON.stringify([record.schoolId, record.classId, record.logId, record.version, record.chapterId, record.date, record.audience.type, record.audience.type === 'student' ? record.audience.studentId : null]);
    const group = groups.get(identity) || new Map<string, T>(); group.set(record.id, record); groups.set(identity, group);
  }
  const pairs: { plan: TestPlan; revise: T; practice: T }[] = [];
  for (const [identity, records] of groups) {
    const revise = [...records.values()].filter(record => record.mode === 'revise');
    const practice = [...records.values()].filter(record => record.mode === 'practice');
    if (revise.length !== 1 || practice.length !== 1) continue;
    const chapter = catalog.find(chapter => chapter.id === revise[0].chapterId && chapter.modes.includes('revise') && chapter.modes.includes('practice'));
    if (!chapter) continue;
    const id = createHash('sha256').update(JSON.stringify(['test-plan-v1', identity, revise[0].id, practice[0].id])).digest('hex');
    pairs.push({ plan: { id, chapterId: chapter.id, chapterTitle: chapter.title, subject: chapter.subject, date: revise[0].date!, reviseId: revise[0].id, practiceId: practice[0].id }, revise: revise[0], practice: practice[0] });
  }
  return pairs.sort((a, b) => a.plan.date.localeCompare(b.plan.date) || a.plan.chapterTitle.localeCompare(b.plan.chapterTitle) || a.plan.id.localeCompare(b.plan.id));
}
