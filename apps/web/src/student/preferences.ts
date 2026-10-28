import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import type { Config, Language, User } from '../types';

export type LearnerPreferences = { displayName: string; grade: number | null; curriculum: 'cbse' | 'other' | null; language: Language | null; setupStep: number; completed: boolean; version: number; updatedAt: string | null };
export type PreferenceChanges = Partial<Pick<LearnerPreferences, 'displayName' | 'grade' | 'curriculum' | 'language' | 'setupStep' | 'completed'>>;
export const emptyPreferences = (): LearnerPreferences => ({ displayName: '', grade: null, curriculum: null, language: null, setupStep: 0, completed: false, version: 0, updatedAt: null });
const message = (issue: unknown) => issue instanceof Error ? issue.message : 'Your preferences could not be saved. Please try again.';
type PreferenceState = { owner: string; profile: LearnerPreferences; loading: boolean; error: string };

/** Only verified account preferences are used. Legacy device data is left untouched. */
export function useStudentPreferences(config: Config | null, user: User | null) {
  const ownerId = user?.emailVerified ? user.id : '';
  const owner = useRef(ownerId); owner.current = ownerId;
  const [state, setState] = useState<PreferenceState>({ owner: '', profile: emptyPreferences(), loading: false, error: '' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!config || !ownerId) {
      setState({ owner: '', profile: emptyPreferences(), loading: false, error: '' });
      return;
    }
    const abort = new AbortController();
    setState({ owner: ownerId, profile: emptyPreferences(), loading: true, error: '' });
    request<{ preferences: LearnerPreferences }>(config, '/preferences', { authenticated: true, expectedUserId: ownerId, signal: abort.signal }).then(({ preferences }) => {
      if (!abort.signal.aborted && owner.current === ownerId) setState({ owner: ownerId, profile: preferences, loading: false, error: '' });
    }).catch((issue) => {
      if (!abort.signal.aborted && owner.current === ownerId) setState({ owner: ownerId, profile: emptyPreferences(), loading: false, error: message(issue) });
    });
    return () => abort.abort();
  }, [config, ownerId, revision]);
  const ownsState = Boolean(ownerId) && state.owner === ownerId;
  const profile = ownsState ? state.profile : emptyPreferences();
  const loading = Boolean(ownerId) && (!config || !ownsState || state.loading);
  const error = ownsState ? state.error : '';
  const latest = useRef(profile); latest.current = profile;
  async function save(changes: PreferenceChanges) {
    if (!ownerId || owner.current !== ownerId) throw new Error('Sign in to save your learner preferences.');
    if (!config || loading || !ownsState || error) throw new Error('Your learner preferences are still opening. Please try again.');
    const result = await request<{ preferences: LearnerPreferences }>(config, '/preferences', { authenticated: true, expectedUserId: ownerId, method: 'PUT', body: { ...changes, version: latest.current.version } });
    if (owner.current !== ownerId) throw new Error('The account changed. Open learner preferences again.');
    latest.current = result.preferences;
    setState({ owner: ownerId, profile: result.preferences, loading: false, error: '' });
    return result.preferences;
  }
  return { profile, loading, error, save, reload: () => setRevision((value) => value + 1), ownerId };
}
export type PreferenceController = ReturnType<typeof useStudentPreferences>;
export const hasLibrary = (profile: LearnerPreferences) => profile.grade === 4 && profile.curriculum === 'cbse';
export const curriculumLabel = (curriculum: LearnerPreferences['curriculum'], language: Language = 'en') => language === 'hi'
  ? curriculum === 'cbse' ? 'सीबीएसई' : curriculum === 'other' ? 'अन्य पाठ्यक्रम' : 'पाठ्यक्रम चुनें'
  : curriculum === 'cbse' ? 'CBSE' : curriculum === 'other' ? 'Other curriculum' : 'Choose curriculum';
