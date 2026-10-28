import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, RefreshCw } from 'lucide-react';
import { request } from '../api';
import type { Config, User } from '../types';
import { currentSchoolGuidance, friendlySchoolDate, schoolCalendarDate } from '../school/dates';
import './guidance.css';

type Guidance = { id: string; chapterId: string; mode: 'learn' | 'practice' | 'revise'; title: string; reason: string; kind: string; date: string | null };
type TestPlan = { id: string; chapterId: string; chapterTitle: string; subject: string; date: string; reviseId: string; practiceId: string };
type ChildGuidance = { child: { id: string; name: string; schoolName: string; className: string }; recommendations: Guidance[]; timeZone: string; localToday: string; testPlans?: TestPlan[] };
type Mine = { studentStatus: string; student: ChildGuidance[]; parent: ChildGuidance[] };
export function GuidanceHome({ config, user, navigate }: { config: Config; user: User; navigate: (path: string) => void }) {
  const [data, setData] = useState<Mine | null>(null); const [error, setError] = useState(''); const [revision, setRevision] = useState(0); const [opening, setOpening] = useState('');
  const [clock, setClock] = useState(() => new Date());
  const owner = useRef<string | null>(user.id); owner.current = user.id;
  useEffect(() => () => { owner.current = null; }, []);
  useEffect(() => {
    const abort = new AbortController(); let requestNumber = 0; setData(null); setError('');
    const refresh = () => {
      const currentRequest = ++requestNumber; setClock(new Date());
      request<Mine>(config, '/school/recommendations/mine', { authenticated: true, expectedUserId: user.id, signal: abort.signal })
        .then(value => { if (!abort.signal.aborted && currentRequest === requestNumber) { setData(value); setError(''); } })
        .catch(issue => { if (!abort.signal.aborted && currentRequest === requestNumber) setError(issue.message); });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    refresh();
    const timer = window.setInterval(() => { setClock(new Date()); if (document.visibilityState === 'visible') refresh(); }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { abort.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [config, user.id, revision]);
  const currentGroup = (group: ChildGuidance): ChildGuidance => {
    const localToday = [group.localToday, schoolCalendarDate(clock, group.timeZone)].sort().at(-1)!;
    return { ...group, localToday, recommendations: currentSchoolGuidance(group.recommendations, group.timeZone, localToday, clock), testPlans: currentSchoolGuidance(group.testPlans || [], group.timeZone, localToday, clock) };
  };
  const studentGroups = data?.student.map(currentGroup) || [];
  const upcoming = studentGroups.flatMap(group => (group.testPlans || []).map(plan => ({ group, plan })))
    .sort((a, b) => a.plan.date.localeCompare(b.plan.date) || a.plan.id.localeCompare(b.plan.id))[0];
  async function open(item: Guidance) {
    const expectedOwner = user.id; setOpening(item.id); setError('');
    try { await request(config, `/school/recommendations/${item.id}/start`, { authenticated: true, expectedUserId: expectedOwner, method: 'POST', body: {} }); if (owner.current === expectedOwner) navigate(`/${item.mode}/${item.chapterId}?recommendation=${item.id}`); }
    catch(issue) { if (owner.current === expectedOwner) setError((issue as Error).message); } finally { if (owner.current === expectedOwner) setOpening(''); }
  }
  async function startPlan(plan: TestPlan) {
    const expectedOwner = user.id; setOpening(`plan:${plan.id}`); setError('');
    try {
      const { recommendation } = await request<{ recommendation: Guidance }>(config, `/school/recommendations/test-plans/${encodeURIComponent(plan.id)}/start`, { authenticated: true, expectedUserId: expectedOwner, method: 'POST', body: { step: 'revise' } });
      if (owner.current === expectedOwner) navigate(`/revise/${encodeURIComponent(recommendation.chapterId)}?${new URLSearchParams({ recommendation: recommendation.id, plan: plan.id })}`);
    } catch(issue) { if (owner.current === expectedOwner) setError((issue as Error).message); } finally { if (owner.current === expectedOwner) setOpening(''); }
  }
  if (!error && data && data.studentStatus === 'missing' && !data.parent.length) return null;
  return <section className="guidance-home page-width" aria-labelledby="guidance-title">{upcoming && !error && <TestBanner group={upcoming.group} plan={upcoming.plan} disabled={Boolean(opening)} opening={opening === `plan:${upcoming.plan.id}`} onStart={() => void startPlan(upcoming.plan)} />}<div className="guidance-heading"><div><p className="eyebrow">FROM CLASSROOM TO HOME</p><h2 id="guidance-title">Your school’s next steps</h2></div><button className="text-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />Refresh</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}{!data && !error && <p role="status">Finding your school’s learning recommendations…</p>}
    {data?.studentStatus === 'ambiguous' && <p className="guidance-empty">Your student email matches more than one roster record. Ask your school to correct it. You can keep exploring the library.</p>}
    {studentGroups.map(group => <div key={group.child.id}><h3>{group.child.className} · {group.child.schoolName}</h3>{!group.recommendations.length ? <p className="guidance-empty">No current learning recommendations. Your library is ready whenever you are.</p> : <div className="guidance-grid">{group.recommendations.map(item => <article className="guidance-card" key={item.id}><p className="eyebrow">{item.mode} {item.date ? `· ${friendlySchoolDate(item.date, group.timeZone, { localToday: group.localToday })}` : '· At your pace'}</p><h3>{item.title}</h3><p>{item.reason}</p><button className="button primary" disabled={Boolean(opening)} onClick={() => void open(item)}>{opening === item.id ? 'Opening…' : `Open ${item.mode}`}<ArrowRight size={16} /></button></article>)}</div>}</div>)}
    {data?.parent.map(currentGroup).map(group => <div className="guidance-family" key={group.child.id}><h3>{group.child.name}’s next steps</h3><p>{group.child.className} · {group.child.schoolName}</p>{!group.recommendations.length ? <p className="guidance-empty">No current learning recommendations for this child.</p> : <div className="guidance-grid">{group.recommendations.map(item => <article className="guidance-card" key={item.id}><p className="eyebrow">{item.mode} {item.date ? `· ${friendlySchoolDate(item.date, group.timeZone, { localToday: group.localToday })}` : ''}</p><h3>{item.title}</h3><p>{item.reason}</p><button className="text-button" onClick={() => navigate(`/${item.mode}/${item.chapterId}`)}>View the learning activity<BookOpen size={15} /></button><small>Your child follows this recommendation from their own student account.</small></article>)}</div>}</div>)}
    {data && (data.student.length > 0 || data.parent.length > 0) && <p className="guidance-attribution">Built with Llama · Classroom notes become catalog-backed learning activities.</p>}
  </section>;
}

function TestBanner({ group, plan, disabled, opening, onStart }: { group: ChildGuidance; plan: TestPlan; disabled: boolean; opening: boolean; onStart: () => void }) {
  const friendlyDate = friendlySchoolDate(plan.date, group.timeZone, { localToday: group.localToday });
  const today = plan.date === group.localToday;
  const tomorrow = friendlyDate.startsWith('Tomorrow · ');
  const dateHeading = today || tomorrow ? `Test ${friendlyDate}` : `Test · ${friendlyDate}`;
  const when = today ? 'today' : tomorrow ? 'tomorrow' : `on ${friendlyDate}`;
  const firstName = group.child.name.trim().split(/\s+/)[0] || group.child.name;
  return <aside className="school-test-banner" aria-labelledby="school-test-title">
    <p className="school-test-date">{dateHeading}</p>
    <h2 id="school-test-title">{firstName}, you have your {plan.subject} {plan.chapterTitle} test {when}.</h2>
    <p className="school-test-invitation">Let’s spend some time practising.</p>
    <ol className="school-test-steps" aria-label="Your test preparation steps"><li><span>1</span>Revise<span className="school-test-arrow" aria-hidden="true">→</span></li><li><span>2</span>Practice set</li></ol>
    <button type="button" className="button primary" disabled={disabled} onClick={onStart}>{opening ? 'Opening…' : 'Start'}<ArrowRight size={18} /></button>
    <p className="guidance-attribution">Built with Llama · from your teacher’s note</p>
  </aside>;
}
