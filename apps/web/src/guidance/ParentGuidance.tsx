import { useEffect, useState } from 'react';
import { request } from '../api';
import { currentSchoolGuidance, friendlySchoolDate, schoolCalendarDate } from '../school/dates';
import type { LinkedChild } from '../school/types';
import type { Config } from '../types';
import './guidance.css';

type Guidance = { id: string; mode: 'learn' | 'practice' | 'revise'; title: string; reason: string; date: string | null };
type ChildGuidance = { child: { id: string; name: string }; timeZone: string; localToday: string; recommendations: Guidance[] };
type GuidanceState = { scope: string; groups: ChildGuidance[] | null; error: string };

/** One read for the family's current children; the API rechecks every parent link. */
export function useParentGuidance(config: Config, userId: string, children: LinkedChild[], enabled: boolean, revision: number) {
  const linkKey = children.map(child => `${child.schoolId}:${child.classId}:${child.id}`).sort().join('|');
  const scope = `${userId}|${enabled}|${linkKey}`;
  const [state, setState] = useState<GuidanceState>({ scope: '', groups: null, error: '' });
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    if (!enabled || !linkKey) { setState({ scope, groups: [], error: '' }); return; }
    const abort = new AbortController(); let requestNumber = 0;
    const childIds = new Set(children.map(child => child.id));
    setState({ scope, groups: null, error: '' });
    const refresh = () => {
      const currentRequest = ++requestNumber; setClock(new Date());
      request<{ parent: ChildGuidance[] }>(config, '/school/recommendations/mine', { authenticated: true, expectedUserId: userId, signal: abort.signal })
        .then(data => {
          if (!abort.signal.aborted && currentRequest === requestNumber) setState({ scope, groups: data.parent.filter(group => childIds.has(group.child.id)), error: '' });
        })
        .catch(issue => {
          // Do not retain a previous child's guidance after a failed authorization/read.
          if (!abort.signal.aborted && currentRequest === requestNumber) setState({ scope, groups: [], error: issue.message || 'Your child’s next steps could not load. Refresh school connections to try again.' });
        });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    refresh();
    const timer = window.setInterval(() => { setClock(new Date()); if (document.visibilityState === 'visible') refresh(); }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { abort.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [config, userId, scope, linkKey, enabled, revision]);
  return { ...(state.scope === scope ? state : { scope, groups: null, error: '' }), clock };
}

export function ParentGuidance({ child, state }: { child: LinkedChild; state: ReturnType<typeof useParentGuidance> }) {
  const group = state.groups?.find(item => item.child.id === child.id);
  // A missing group after a successful refresh means this link is no longer current.
  if (state.groups && !group && !state.error) return null;
  const localToday = group ? [group.localToday, schoolCalendarDate(state.clock, group.timeZone)].sort().at(-1)! : '';
  const recommendations = group ? currentSchoolGuidance(group.recommendations, group.timeZone, localToday, state.clock) : [];
  return <section className="parent-guidance" aria-labelledby={`next-steps-${child.id}`}>
    <h4 id={`next-steps-${child.id}`}>{child.name}’s next steps</h4>
    {state.error ? <p className="form-error" role="alert">{state.error}</p> : !state.groups ? <p role="status">Finding your child’s next steps…</p> : recommendations.length ? <div className="parent-guidance-list">{recommendations.map(item => <article className="guidance-card" key={item.id}>
      <p className="eyebrow">{item.mode} · {item.date ? friendlySchoolDate(item.date, group!.timeZone, { localToday }) : 'At your pace'}</p>
      <h5>{item.title}</h5><p>{item.reason}</p>
    </article>)}</div> : <p className="guidance-empty">No current learning recommendations for this child.</p>}
    {group && !state.error && <><p className="parent-guidance-note">Your child follows these next steps from their own student account.</p><p className="guidance-attribution">Built with Llama · from the teacher’s note</p></>}
  </section>;
}
