import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, request } from '../api';
import type { Config } from '../types';
import type { FamilyProfile, UnreadSummary } from './types';

export type SchoolAuth = { config: Config; userId: string };
const problem = (issue: unknown) => issue instanceof Error ? issue.message : 'Please try again.';
const POLL_MS = 60_000;

/** Refreshes keep the rendered records and composers mounted; a new scope never sees old data. */
export function useSchoolRead<T>({ config, userId }: SchoolAuth, path: string | null, revision = 0, poll = false) {
  const scope = `${userId}:${config.apiBaseUrl}:${path || ''}`;
  const [state, setState] = useState<{ scope: string; data: T | null; error: string }>({ scope, data: null, error: '' });
  useEffect(() => {
    if (!path) return;
    let active = true; let sequence = 0; let abort: AbortController | undefined;
    const load = async () => {
      const current = ++sequence; abort?.abort(); abort = new AbortController();
      setState(previous => previous.scope === scope ? { ...previous, error: '' } : { scope, data: null, error: '' });
      try {
        const data = await request<T>(config, path, { authenticated: true, expectedUserId: userId, signal: abort.signal });
        if (active && current === sequence) setState({ scope, data, error: '' });
      } catch (issue) {
        if (!active || current !== sequence || (issue as Error).name === 'AbortError') return;
        const revoked = issue instanceof ApiError && [401, 403, 404].includes(issue.status);
        setState(previous => ({ scope, data: !revoked && previous.scope === scope ? previous.data : null, error: problem(issue) }));
      }
    };
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = poll ? window.setInterval(tick, POLL_MS) : undefined;
    if (poll) document.addEventListener('visibilitychange', tick);
    return () => { active = false; abort?.abort(); if (timer) window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [config, userId, path, revision, poll, scope]);
  return path && state.scope === scope ? { data: state.data, error: state.error } : { data: null, error: '' };
}

/** Count polling is read-only. It never advances an update or conversation cursor. */
export function useUnreadCounts({ config, userId }: SchoolAuth, paths: string[], revision = 0) {
  const pathsKey = JSON.stringify(paths);
  const scope = `${userId}:${config.apiBaseUrl}:${pathsKey}`;
  const [state, setState] = useState<{ scope: string; counts: Record<string, number> }>({ scope, counts: {} });
  useEffect(() => {
    const currentPaths = JSON.parse(pathsKey) as string[];
    if (!currentPaths.length) return;
    let active = true; let generation = 0; let abort: AbortController | undefined;
    const load = async () => {
      const requestGeneration = ++generation; abort?.abort(); abort = new AbortController();
      const signal = abort.signal;
      const results = await Promise.allSettled(currentPaths.map(path => request<UnreadSummary>(config, `${path}/unread`, { authenticated: true, expectedUserId: userId, signal })));
      if (!active || signal.aborted || generation !== requestGeneration) return;
      setState(previous => {
        const counts = previous.scope === scope ? { ...previous.counts } : {};
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') counts[currentPaths[index]] = result.value.unreadCount;
          else if ([401, 403, 404].includes(result.reason?.status)) delete counts[currentPaths[index]];
        });
        return { scope, counts };
      });
    };
    void load();
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const timer = window.setInterval(tick, POLL_MS); document.addEventListener('visibilitychange', tick);
    return () => { active = false; abort?.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [config, userId, pathsKey, revision, scope]);
  return state.scope === scope ? state.counts : {};
}

export function NewActivity({ count, label = 'New' }: { count?: number; label?: string }) {
  return count && count > 0 ? <span className="family-new-badge" aria-label={`${count} new ${count === 1 ? 'activity' : 'activities'}`}>{label} {count}</span> : null;
}

/** Called only by an opened view after the exact version/sequence is rendered. */
export function useRenderedRead(auth: SchoolAuth, path: string, field: 'observedVersion' | 'observedSequence', observed: number, open: boolean, onRead: (observed: number) => void) {
  const scope = `${auth.userId}:${path}`;
  const [state, setState] = useState({ scope, read: 0, error: '' });
  const [retry, setRetry] = useState(0);
  const callback = useRef(onRead); callback.current = onRead;
  const read = state.scope === scope ? state.read : 0;
  useEffect(() => {
    if (!open || observed <= 0 || observed <= read) return;
    const abort = new AbortController(); let pending = false; let done = false;
    const mark = async () => {
      if (pending || done || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const result = await request<{ readVersion?: number; readSequence?: number }>(auth.config, path, { authenticated: true, expectedUserId: auth.userId, signal: abort.signal, method: 'POST', body: { [field]: observed } });
        if (abort.signal.aborted) return;
        done = true;
        setState(previous => ({ scope, read: Math.max(previous.scope === scope ? previous.read : 0, field === 'observedVersion' ? result.readVersion || observed : result.readSequence || observed), error: '' }));
        callback.current(observed);
      } catch (issue) {
        if (!abort.signal.aborted) setState(previous => ({ scope, read: previous.scope === scope ? previous.read : 0, error: problem(issue) }));
      } finally { pending = false; }
    };
    void mark(); document.addEventListener('visibilitychange', mark);
    return () => { abort.abort(); document.removeEventListener('visibilitychange', mark); };
  }, [auth.config, auth.userId, scope, path, field, observed, open, read, retry]);
  return { read, error: state.scope === scope ? state.error : '', retry: () => setRetry(value => value + 1) };
}

export function ParentNameForm({ profile, onSaved, onCancel, onConflict, ...auth }: SchoolAuth & { profile: FamilyProfile | null; onSaved: (profile: FamilyProfile) => void; onCancel?: () => void; onConflict: () => void }) {
  const [name, setName] = useState(profile?.displayName || ''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), [auth.userId]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (pending.current) return;
    const abort = new AbortController(); pending.current = abort; setBusy(true); setError('');
    try {
      const result = await request<{ profile: FamilyProfile }>(auth.config, '/school/family/profile', { authenticated: true, expectedUserId: auth.userId, signal: abort.signal, method: 'PUT', body: { displayName: name.trim(), version: profile?.version || 0 } });
      if (!abort.signal.aborted) onSaved(result.profile);
    } catch (issue) { if (!abort.signal.aborted) { setError(problem(issue)); if (issue instanceof ApiError && issue.status === 409) onConflict(); } }
    finally { if (!abort.signal.aborted) setBusy(false); pending.current = null; }
  }
  return <form className="school-card school-form family-name-form" onSubmit={submit}>
    <h3>{profile ? 'Your name in conversations' : 'What should your child’s teacher call you?'}</h3>
    <p className="school-help">Your name appears with your acknowledgements and private replies. You only need to add it once.</p>
    <label>Your name<input required minLength={1} maxLength={100} autoComplete="name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="school-form-actions"><button className="button primary" disabled={busy || !name.trim()}>{busy ? 'Saving name…' : 'Save my name'}</button>{onCancel && <button type="button" className="button secondary" onClick={onCancel} disabled={busy}>Cancel</button>}</div>
  </form>;
}
