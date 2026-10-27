import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, Check, Globe2, GraduationCap, Headphones, HeartHandshake, LogOut, MoveUpRight, Sprout } from 'lucide-react';
import { GlobalSignOutCommand } from '@aws-sdk/client-cognito-identity-provider';
import { AuthDialog } from './AuthDialog';
import { EarthArt } from './Illustrations';
import { LessonView } from './LessonView';
import { clearSession, identityClient, request, session } from './api';
import type { Catalog, Config, User } from './types';

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'signin' | 'signup' | null>(null);
  const [path, setPath] = useState(window.location.pathname);
  const [sessionNotice, setSessionNotice] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const pop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const abort = new AbortController(); setConfigError('');
    fetch('/config.json', { cache: 'no-store', signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error('The website is still connecting. Please try again shortly.');
      const value = await response.json() as Config;
      if (!value.apiBaseUrl?.startsWith('/') || !value.region) throw new Error('The website configuration is temporarily unavailable.');
      setConfig(value);
    }).catch((issue: Error) => { if (issue.name !== 'AbortError') setConfigError(issue.message); });
    return () => abort.abort();
  }, [retry]);
  useEffect(() => {
    if (!config) return;
    const abort = new AbortController(); setCatalogError('');
    void request<Catalog>(config, '/catalog', { signal: abort.signal }).then(setCatalog).catch((issue: Error) => { if (issue.name !== 'AbortError') setCatalogError(issue.message); });
    if (session()) void request<User>(config, '/me', { authenticated: true, signal: abort.signal }).then(setUser).catch((issue: Error) => { if (issue.name !== 'AbortError') { clearSession(); setSessionNotice('Please sign in again to access your saved progress.'); } });
    return () => abort.abort();
  }, [config, retry]);
  function navigate(next: string) { window.history.pushState({}, '', next); setPath(next); window.scrollTo(0, 0); }
  async function signOut() {
    const token = session()?.accessToken; clearSession(); setUser(null); setSessionNotice('You are signed out on this device.');
    if (config && token) { try { await identityClient(config).send(new GlobalSignOutCommand({ AccessToken: token })); } catch { /* Local session is already removed. */ } }
  }
  const chapter = catalog?.chapters[0];
  const lessonMatch = path.match(/^\/learn\/([a-zA-Z0-9_-]+)\/?$/);
  const isSchool = path === '/school' || path === '/school/';
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header page-width"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }} aria-label="School Learning Simplified home"><span className="brand-mark"><BookOpen size={25} strokeWidth={1.8} /><span /></span><span>School Learning<span>Simplified</span></span></a><nav aria-label="Main navigation"><a className={!isSchool ? 'nav-link current' : 'nav-link'} href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>Discover</a><a className={isSchool ? 'nav-link current' : 'nav-link'} href="/school" onClick={(event) => { event.preventDefault(); navigate('/school'); }}>For schools</a>{user ? <button className="button header-account" onClick={signOut} title={user.email}><LogOut size={16} />Sign out</button> : <button className="button header-account" onClick={() => setAuthMode('signin')} disabled={!config}>Sign in<ArrowRight size={16} /></button>}</nav></header>
    {sessionNotice && <div className="session-notice page-width" role="status">{sessionNotice}<button className="text-button" onClick={() => setSessionNotice('')} aria-label="Dismiss account notification">Dismiss</button></div>}
    <div id="main">
      {configError ? <main className="status-panel page-width"><h1>A moment to reconnect.</h1><p role="alert">{configError}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>Try again</button></main> : lessonMatch && !config ? <main className="status-panel page-width" role="status">Opening your learning space…</main> : lessonMatch && config ? <LessonView key={lessonMatch[1]} config={config} chapterId={lessonMatch[1]} user={user} onSignIn={() => setAuthMode('signin')} onBack={() => navigate('/')} /> : isSchool ? <main className="school-page page-width"><span className="section-symbol"><GraduationCap size={28} /></span><p className="eyebrow">FOR SCHOOLS</p><h1>From today’s classroom<br />to tomorrow’s discovery.</h1><p className="school-intro">A shared space for teachers, students and families is on its way. Classroom updates will help children find their next useful learning step at home.</p><div className="school-notice"><Sprout size={25} /><div><h2>We’re laying the foundations.</h2><p>The school workspace is being built. School registration, class updates and family conversations are not available yet.</p></div></div><button className="button primary" onClick={() => navigate('/')}>Explore the lesson preview<ArrowRight size={18} /></button></main> : path !== '/' ? <main className="status-panel page-width"><h1>Let’s find your way back.</h1><p>This page is not in our learning library.</p><button className="button primary" onClick={() => navigate('/')}>Go to the library<ArrowRight size={18} /></button></main> : <main>
        <section className="hero page-width"><div className="hero-copy"><p className="eyebrow"><span className="tiny-star">✳</span> SMALL STEPS. BIG DISCOVERIES.</p><h1>A little wonder.<br />A little learning.<br /><em>Every day.</em></h1><p className="hero-description">Make sense of the world, one idea at a time.<br className="desktop-break" /> Thoughtful lessons to read, listen to and explore<br className="desktop-break" /> in English and Hindi.</p><div className="hero-actions"><button className="button primary large" disabled={!chapter} onClick={() => chapter && navigate(`/learn/${chapter.id}`)}>Let’s explore<ArrowRight size={19} /></button><span><Headphones size={18} />Learn at your own pace</span></div><div className="hero-footnote"><span className="tiny-check"><Check size={12} /></span>Start exploring. No school account needed.</div></div><div className="hero-visual"><div className="hero-art"><EarthArt /></div><div className="float-note language-note"><span className="note-icon"><Globe2 size={20} /></span><span>One idea.<strong>Two languages.</strong></span></div><div className="float-note curiosity-note"><span className="note-icon warm"><Sprout size={21} /></span><span>A world of<strong>“Oh, now I get it!”</strong></span></div><div className="orbit-caption">THERE’S SO MUCH TO DISCOVER</div></div></section>
        <section className="library-section page-width" aria-labelledby="library-title"><div className="section-heading"><div><p className="eyebrow">FOLLOW YOUR CURIOSITY</p><h2 id="library-title">Your next discovery</h2></div><span className="collection-label">Class 4 <span>·</span> Environmental Studies</span></div>
          {catalogError ? <div className="library-error"><p role="alert">The lesson library could not be loaded. {catalogError}</p><button className="text-button" onClick={() => setRetry(retry + 1)}>Try again<ArrowRight size={15} /></button></div> : !catalog ? <div className="library-loading" role="status">Getting your learning space ready…</div> : catalog.chapters.length === 0 ? <p className="library-loading">New lessons are on their way. Please check back soon.</p> : <div className="library-grid">{catalog.chapters.map((item) => <article className="chapter-card" key={item.id}><div className="chapter-picture"><span className="preview-pill">LESSON PREVIEW</span><EarthArt small /><span className="chapter-number">01</span></div><div className="chapter-details"><div className="chapter-meta"><span>CLASS {item.grade} · {item.subject}</span><span><Headphones size={14} />EN / हिन्दी</span></div><h3>{item.title}</h3><p>{item.description}</p><div className="chapter-bottom"><span>{item.cardCount} small ideas to explore</span><button aria-label={`Explore ${item.title}`} onClick={() => navigate(`/learn/${item.id}`)}><ArrowRight size={21} /></button></div></div></article>)}<article className="coming-card"><div className="coming-art"><Sprout size={48} strokeWidth={1.2} /><span>IN THE MAKING</span></div><h3>Curiosity is growing.</h3><p>More of Our Earth, Animal Life, practice and revision are taking shape.</p><span className="coming-label">More learning, coming soon</span></article></div>}
        </section>
        <section className="learning-strip page-width" aria-label="Ways to learn"><div><span className="strip-icon"><BookOpen size={23} /></span><div><h3>One idea at a time</h3><p>Small steps that make things click.</p></div></div><div><span className="strip-icon"><Headphones size={23} /></span><div><h3>Read it. Hear it.</h3><p>Your pace, your way of learning.</p></div></div><div><span className="strip-icon"><HeartHandshake size={23} /></span><div><h3>Better, together</h3><p>Connecting school and home is next.</p></div></div></section>
        <section className="school-teaser page-width"><div><p className="eyebrow">A BRIDGE BETWEEN SCHOOL & HOME</p><h2>Learning doesn’t stop<br />at the classroom door.</h2></div><div><p>We’re building a place where a teacher’s everyday update becomes a helpful next step for a child.</p><a href="/school" onClick={(event) => { event.preventDefault(); navigate('/school'); }}>See what’s coming for schools<MoveUpRight size={18} /></a></div></section>
      </main>}
    </div>
    <footer className="site-footer page-width"><div><span className="footer-name">School Learning Simplified</span><p>A little clearer. A little more curious.</p></div><div><span>Made for learning, together.</span><small>Preview · Existing learning content, a new learning experience.</small></div></footer>
    {authMode && config && <AuthDialog config={config} initialMode={authMode} onClose={() => setAuthMode(null)} onSignedIn={(person) => { setUser(person); setAuthMode(null); setSessionNotice('You’re signed in. Your progress will be saved to your account.'); }} />}
  </>;
}
