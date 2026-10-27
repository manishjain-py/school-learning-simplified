import { useEffect, useRef, useState } from 'react';
import { request, session } from '../api';
import type { Config, Language, User } from '../types';

export type LearnerPreferences = { displayName: string; grade: number | null; curriculum: 'cbse' | 'other' | null; language: Language | null; setupStep: number; completed: boolean; version: number; updatedAt: string | null };
export type PreferenceChanges = Partial<Pick<LearnerPreferences, 'displayName' | 'grade' | 'curriculum' | 'language' | 'setupStep' | 'completed'>>;
export const emptyPreferences = (): LearnerPreferences => ({ displayName: '', grade: null, curriculum: null, language: null, setupStep: 0, completed: false, version: 0, updatedAt: null });
const guestKey = 'sls-guest-learner-v1';
const message = (issue: unknown) => issue instanceof Error ? issue.message : 'Your preferences could not be saved. Please try again.';
function readGuest(): LearnerPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(guestKey) || '{}') as LearnerPreferences;
    if (typeof value.displayName !== 'string' || value.displayName.length > 60 || !Number.isInteger(value.setupStep) || value.setupStep < 0 || value.setupStep > 5 || !Number.isInteger(value.version) || value.version < 0 || (value.grade !== null && (!Number.isInteger(value.grade) || value.grade < 1 || value.grade > 12)) || ![null, 'cbse', 'other'].includes(value.curriculum) || ![null, 'en', 'hi'].includes(value.language) || typeof value.completed !== 'boolean') return emptyPreferences();
    if (value.completed && (!value.displayName || !value.grade || !value.curriculum || !value.language)) return emptyPreferences();
    return value;
  } catch { return emptyPreferences(); }
}

/** Guest choices and each verified account stay separate; no implicit guest-to-account copy. */
export function useStudentPreferences(config: Config | null, user: User | null) {
  const ownerId = user?.id || 'guest';
  const restoringAccount = Boolean(session()) && !user;
  const owner = useRef(ownerId); owner.current = ownerId;
  const [state, setState] = useState<{ owner: string; profile: LearnerPreferences }>({ owner: '', profile: emptyPreferences() });
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!config || restoringAccount) { setLoading(true); return; }
    const abort = new AbortController(); setLoading(true); setError('');
    if (!user) { setState({ owner: 'guest', profile: readGuest() }); setLoading(false); return; }
    request<{ preferences: LearnerPreferences }>(config, '/preferences', { authenticated: true, expectedUserId: user.id, signal: abort.signal }).then(({ preferences }) => setState({ owner: user.id, profile: preferences })).catch((issue) => { if (issue.name !== 'AbortError') setError(message(issue)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [config, user?.id, restoringAccount, revision]);
  const profile = state.owner === ownerId ? state.profile : emptyPreferences();
  const latest = useRef(profile); latest.current = profile;
  async function save(changes: PreferenceChanges) {
    const expectedOwner = ownerId;
    if (!config || loading || restoringAccount || state.owner !== ownerId) throw new Error('Your learner preferences are still opening. Please try again.');
    const before = latest.current;
    let next: LearnerPreferences;
    if (user) {
      const result = await request<{ preferences: LearnerPreferences }>(config, '/preferences', { authenticated: true, expectedUserId: user.id, method: 'PUT', body: { ...changes, version: before.version } });
      next = result.preferences;
    } else {
      next = { ...before, ...changes, version: before.version + 1, updatedAt: new Date().toISOString() };
      localStorage.setItem(guestKey, JSON.stringify(next));
    }
    if (owner.current !== expectedOwner) throw new Error('The account changed. Open learner preferences again.');
    latest.current = next; setState({ owner: expectedOwner, profile: next }); setError('');
    return next;
  }
  return { profile, loading: loading || restoringAccount || (state.owner !== ownerId && !error), error, save, reload: () => setRevision((value) => value + 1), ownerId };
}
export type PreferenceController = ReturnType<typeof useStudentPreferences>;
export const hasLibrary = (profile: LearnerPreferences) => profile.grade === 4 && profile.curriculum === 'cbse';
export const curriculumLabel = (curriculum: LearnerPreferences['curriculum']) => curriculum === 'cbse' ? 'CBSE' : curriculum === 'other' ? 'Other curriculum' : 'Choose curriculum';
