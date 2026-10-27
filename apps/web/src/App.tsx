import { useEffect, useState } from 'react';
import { ArrowRight, BookOpen, LogOut } from 'lucide-react';
import { GlobalSignOutCommand } from '@aws-sdk/client-cognito-identity-provider';
import { AuthDialog } from './AuthDialog';
import { SchoolWorkspace } from './school/SchoolWorkspace';
import { GuidanceHome } from './guidance/GuidanceHome';
import { StudentExperience } from './student/StudentExperience';
import { useStudentPreferences } from './student/preferences';
import { LessonView } from './LessonView';
import { PracticeView } from './PracticeView';
import { ReviseView } from './ReviseView';
import { clearSession, identityClient, request, session } from './api';
import type { Catalog, Config, LearningMode, User } from './types';

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'signin' | 'signup' | null>(null);
  const [path, setPath] = useState(window.location.pathname + window.location.search);
  const [sessionNotice, setSessionNotice] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const pop = () => setPath(window.location.pathname + window.location.search);
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
  function navigate(next: string) { if (window.location.pathname + window.location.search !== next) window.history.pushState({}, '', next); setPath(next); setSessionNotice(''); window.scrollTo(0, 0); }
  async function signOut() {
    const token = session()?.accessToken; clearSession(); setUser(null); setSessionNotice('You are signed out on this device.');
    if (config && token) { try { await identityClient(config).send(new GlobalSignOutCommand({ AccessToken: token })); } catch { /* Local session is already removed. */ } }
  }
  const preferences = useStudentPreferences(config, user);
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('#main h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [path, preferences.loading, preferences.profile.setupStep]);
  const pathname = path.split('?')[0];
  const recommendationId = new URLSearchParams(path.split('?')[1] || '').get('recommendation') ?? undefined;
  const learningMatch = pathname.match(/^\/(learn|practice|revise)\/([a-zA-Z0-9_-]+)\/?$/);
  function learningPage() {
    if (!config || preferences.loading) return <main className="status-panel page-width" role="status">Opening your learning space…</main>;
    if (preferences.error) return <main className="student-area page-width student-loading"><h1>Your learner preferences couldn’t load.</h1><p className="form-error" role="alert">{preferences.error}</p><button className="button primary" onClick={preferences.reload}>Try again</button></main>;
    if (!catalog && learningMatch![1] !== 'learn') return <main className="status-panel page-width" role="status">{catalogError || 'Opening your learning space…'}</main>;
    const mode = learningMatch![1] as LearningMode;
    const chapterId = learningMatch![2];
    const entry = catalog?.chapters.find((item) => item.id === chapterId);
    if (mode !== 'learn' && !entry?.modes?.includes(mode)) return <main className="status-panel page-width"><h1>This learning mode is on its way.</h1><p>Explore the available lesson in the meantime.</p><button className="button primary" onClick={() => navigate(`/learn/${chapterId}`)}>Go to Learn<ArrowRight size={17} /></button></main>;
    const props = { config, chapterId, user, recommendationId, preferredLanguage: preferences.profile.language || undefined, onSignIn: () => setAuthMode('signin'), onBack: () => navigate(`/chapters/${chapterId}${recommendationId !== undefined ? `?recommendation=${encodeURIComponent(recommendationId)}&mode=${mode}` : ''}`), onMode: (next: LearningMode) => navigate(`/${next}/${chapterId}${recommendationId !== undefined && next === mode ? `?recommendation=${encodeURIComponent(recommendationId)}` : ''}`) };
    if (mode === 'practice') return <PracticeView key={`${chapterId}:${recommendationId || 'library'}:${user?.id || 'anonymous'}`} {...props} />;
    if (mode === 'revise') return <ReviseView key={`${chapterId}:${recommendationId || 'library'}:${user?.id || 'anonymous'}`} {...props} />;
    return <LessonView key={`${chapterId}:${recommendationId || 'library'}:${user?.id || 'anonymous'}`} {...props} />;
  }
  const isSchool = pathname === '/school' || pathname === '/school/';
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header page-width"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }} aria-label="School Learning Simplified home"><span className="brand-mark"><BookOpen size={25} strokeWidth={1.8} /><span /></span><span>School Learning<span>Simplified</span></span></a><nav aria-label="Main navigation"><a className={!isSchool ? 'nav-link current' : 'nav-link'} href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>My library</a><a className={isSchool ? 'nav-link current' : 'nav-link'} href="/school" onClick={(event) => { event.preventDefault(); navigate('/school'); }}>School</a>{user ? <button className="button header-account" onClick={signOut} title={user.email}><LogOut size={16} />Sign out</button> : <button className="button header-account" onClick={() => setAuthMode('signin')} disabled={!config}>Sign in<ArrowRight size={16} /></button>}</nav></header>
    {sessionNotice && <div className="session-notice page-width" role="status">{sessionNotice}<button className="text-button" onClick={() => setSessionNotice('')} aria-label="Dismiss account notification">Dismiss</button></div>}
    <div id="main">
      {learningMatch && recommendationId !== undefined && <div className="recommendation-banner page-width">This activity was opened from classroom guidance. Its new progress is recorded for your teacher. <a href="/" onClick={event => { event.preventDefault(); navigate('/'); }}>Latest recommendations</a></div>}
      {configError ? <main className="status-panel page-width"><h1>A moment to reconnect.</h1><p role="alert">{configError}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>Try again</button></main> : learningMatch ? learningPage() : isSchool ? config ? <SchoolWorkspace config={config} user={user} onSignIn={() => setAuthMode('signin')} /> : <main className="status-panel page-width" role="status">Opening your school workspace…</main> : pathname === '/' || pathname === '/setup' || pathname === '/profile' || /^\/(subjects|chapters)\/[^/]+\/?$/.test(pathname) ? config ? <StudentExperience config={config} user={user} catalog={catalog} catalogError={catalogError} onRetryCatalog={() => setRetry(retry + 1)} path={pathname} search={path.includes('?') ? path.slice(path.indexOf('?')) : ''} navigate={navigate} onSignIn={() => setAuthMode('signin')} preferences={preferences} guidance={user ? <GuidanceHome key={user.id} config={config} user={user} navigate={navigate} /> : undefined} /> : <main className="student-loading page-width" role="status">Opening your learning space…</main> : <main className="status-panel page-width"><h1>Let’s find your way back.</h1><p>This page is not in our learning library.</p><button className="button primary" onClick={() => navigate('/')}>Go to my library<ArrowRight size={18} /></button></main>}
    </div>
    <footer className="site-footer page-width"><div><span className="footer-name">School Learning Simplified</span><p>A little clearer. A little more curious.</p></div><div><span>Made for learning, together.</span><small>{catalog?.schemaVersion === 2 ? 'Existing learning content, a new learning experience.' : 'Preview · Existing learning content, a new learning experience.'}</small></div></footer>
    {authMode && config && <AuthDialog config={config} initialMode={authMode} onClose={() => setAuthMode(null)} onSignedIn={(person) => { setUser(person); setAuthMode(null); setSessionNotice('You’re signed in. Your progress will be saved to your account.'); }} />}
  </>;
}
