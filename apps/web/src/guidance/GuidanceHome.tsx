import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, RefreshCw } from 'lucide-react';
import { request } from '../api';
import type { Config, User } from '../types';
import './guidance.css';

type Guidance = { id: string; chapterId: string; mode: 'learn' | 'practice' | 'revise'; title: string; reason: string; kind: string; date: string | null };
type ChildGuidance = { child: { id: string; name: string; schoolName: string; className: string }; recommendations: Guidance[] };
type Mine = { studentStatus: string; student: ChildGuidance[]; parent: ChildGuidance[] };
export function GuidanceHome({ config, user, navigate }: { config: Config; user: User; navigate: (path: string) => void }) {
  const [data, setData] = useState<Mine | null>(null); const [error, setError] = useState(''); const [revision, setRevision] = useState(0); const [opening, setOpening] = useState('');
  useEffect(() => { const abort = new AbortController(); setData(null); setError('');
    request<Mine>(config, '/school/recommendations/mine', { authenticated: true, expectedUserId: user.id, signal: abort.signal }).then(setData).catch(issue => { if (issue.name !== 'AbortError') setError(issue.message); }); return () => abort.abort();
  }, [config, user.id, revision]);
  async function open(item: Guidance) {
    setOpening(item.id); setError('');
    try { await request(config, `/school/recommendations/${item.id}/start`, { authenticated: true, expectedUserId: user.id, method: 'POST', body: {} }); navigate(`/${item.mode}/${item.chapterId}?recommendation=${item.id}`); }
    catch(issue) { setError((issue as Error).message); } finally { setOpening(''); }
  }
  if (!error && data && data.studentStatus === 'missing' && !data.parent.length) return null;
  return <section className="guidance-home page-width" aria-labelledby="guidance-title"><div className="guidance-heading"><div><p className="eyebrow">FROM CLASSROOM TO HOME</p><h2 id="guidance-title">Your school’s next steps</h2></div><button className="text-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />Refresh</button></div>
    {error && <p role="alert" className="form-error">{error}</p>}{!data && !error && <p role="status">Finding your school’s learning recommendations…</p>}
    {data?.studentStatus === 'ambiguous' && <p className="guidance-empty">Your student email matches more than one roster record. Ask your school to correct it. You can keep exploring the library.</p>}
    {data?.student.map(group => <div key={group.child.id}><h3>{group.child.className} · {group.child.schoolName}</h3>{!group.recommendations.length ? <p className="guidance-empty">No current learning recommendations. Your library is ready whenever you are.</p> : <div className="guidance-grid">{group.recommendations.map(item => <article className="guidance-card" key={item.id}><p className="eyebrow">{item.mode} {item.date ? `· ${item.date}` : '· At your pace'}</p><h3>{item.title}</h3><p>{item.reason}</p><button className="button primary" disabled={Boolean(opening)} onClick={() => void open(item)}>{opening === item.id ? 'Opening…' : `Open ${item.mode}`}<ArrowRight size={16} /></button></article>)}</div>}</div>)}
    {data?.parent.map(group => <div className="guidance-family" key={group.child.id}><h3>{group.child.name}’s next steps</h3><p>{group.child.className} · {group.child.schoolName}</p>{!group.recommendations.length ? <p className="guidance-empty">No current learning recommendations for this child.</p> : <div className="guidance-grid">{group.recommendations.map(item => <article className="guidance-card" key={item.id}><p className="eyebrow">{item.mode} {item.date ? `· ${item.date}` : ''}</p><h3>{item.title}</h3><p>{item.reason}</p><button className="text-button" onClick={() => navigate(`/${item.mode}/${item.chapterId}`)}>View the learning activity<BookOpen size={15} /></button><small>Your child follows this recommendation from their own student account.</small></article>)}</div>}</div>)}
    {data && (data.student.length > 0 || data.parent.length > 0) && <p className="guidance-attribution">Built with Llama · Classroom notes become catalog-backed learning activities.</p>}
  </section>;
}
