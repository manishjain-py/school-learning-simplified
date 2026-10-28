import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, LogOut, ShieldCheck } from 'lucide-react';
import { GlobalSignOutCommand } from '@aws-sdk/client-cognito-identity-provider';
import { AuthDialog } from './AuthDialog';
import { SchoolWorkspace } from './school/SchoolWorkspace';
import { GuidanceHome } from './guidance/GuidanceHome';
import { StudentExperience } from './student/StudentExperience';
import { useStudentPreferences } from './student/preferences';
import { LessonView } from './LessonView';
import { PracticeView } from './PracticeView';
import { ReviseView } from './ReviseView';
import { ApiError, clearSession, identityClient, request, session } from './api';
import type { Catalog, Config, LearningMode, User } from './types';
import type { Workspaces } from './school/types';

/** Resolve a new account's family role before offering learner setup. */
function LearnerEntry({ config, user, path, navigate, children }: { config: Config; user: User; path: string; navigate: (path: string) => void; children: ReactNode }) {
  const [roles, setRoles] = useState<Workspaces | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setRoles(null); setError('');
    request<Workspaces>(config, '/school/workspaces', { authenticated: true, expectedUserId: user.id, signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setRoles(value); })
      .catch(issue => { if (!abort.signal.aborted) setError(issue.message); });
    return () => abort.abort();
  }, [config, user.id, retry]);
  const parentOnly = Boolean(roles?.family.parent.children.length) && roles?.family.student.status === 'missing';
  const home = path.split('?')[0] === '/';
  useEffect(() => { if (parentOnly && home) navigate('/school'); }, [parentOnly, home]);
  if (error) return <main className="status-panel page-width"><h1>Let’s reconnect to your school.</h1><p role="alert">{error}</p><button className="button primary" onClick={() => setRetry(value => value + 1)}>Try again</button><button className="button secondary" onClick={() => navigate('/school')}>Open school workspace</button></main>;
  if (!roles || (parentOnly && home)) return <main className="status-panel page-width" role="status">Finding your school and family connections…</main>;
  if (parentOnly) {
    const destination = new URL(path, window.location.origin); destination.searchParams.set('learn', '1');
    return <main className="account-entry page-width"><p className="eyebrow">YOUR OWN LEARNING SPACE</p><h1>Would you like to learn too?</h1><p>Your child’s next steps are in your family workspace. You can also set up a learning space for yourself.</p><div className="account-actions"><button className="button primary" onClick={() => navigate('/school')}>Open family workspace</button><button className="button secondary" onClick={() => navigate(destination.pathname + destination.search)}>Learn for myself</button></div></main>;
  }
  return children;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState('');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [accountStatus, setAccountStatus] = useState<'restoring' | 'ready' | 'signedout' | 'error'>(() => session() ? 'restoring' : 'signedout');
  const [accountError, setAccountError] = useState('');
  const [accountRetry, setAccountRetry] = useState(0);
  const accountGeneration = useRef(0);
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
    return () => abort.abort();
  }, [config, retry]);
  useEffect(() => {
    if (!config) return;
    const saved = session();
    if (!saved) { setUser(null); setAccountStatus('signedout'); return; }
    const abort = new AbortController();
    const generation = accountGeneration.current;
    const current = () => !abort.signal.aborted && accountGeneration.current === generation && session()?.refreshToken === saved.refreshToken;
    setAccountStatus('restoring'); setAccountError('');
    void request<User>(config, '/me', { authenticated: true, expectedUserId: saved.subject, signal: abort.signal }).then((person) => {
      if (!current()) return;
      if (!person.emailVerified) throw new ApiError('Verify your email before continuing.', 403);
      setUser(person); setAccountStatus('ready');
    }).catch((issue: Error) => {
      // Refresh may have removed an expired session. An explicit account change
      // still invalidates this request, including its error path.
      if (abort.signal.aborted || accountGeneration.current !== generation) return;
      if (session() && session()?.refreshToken !== saved.refreshToken) return;
      setUser(null);
      if (issue instanceof ApiError && (issue.status === 401 || issue.status === 403)) {
        clearSession(); setAccountStatus('signedout'); setSessionNotice('Please sign in again with your verified email to continue.');
      } else { setAccountError(issue.message); setAccountStatus('error'); }
    });
    return () => abort.abort();
  }, [config, accountRetry]);
  function navigate(next: string) { if (window.location.pathname + window.location.search !== next) window.history.pushState({}, '', next); setPath(next); setSessionNotice(''); window.scrollTo(0, 0); }
  async function signOut() {
    const token = session()?.accessToken; accountGeneration.current += 1; clearSession(); setUser(null); setAccountStatus('signedout'); setAccountError('');
    navigate(isSchool ? '/school' : '/'); setSessionNotice('You are signed out on this device.');
    if (config && token) { try { await identityClient(config).send(new GlobalSignOutCommand({ AccessToken: token })); } catch { /* Local session is already removed. */ } }
  }
  const preferences = useStudentPreferences(config, user);
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('#main h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [path, accountStatus, preferences.loading, preferences.profile.setupStep]);
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
  const isLearner = Boolean(learningMatch) || pathname === '/' || pathname === '/setup' || pathname === '/profile' || /^\/(subjects|chapters)\/[^/]+\/?$/.test(pathname);
  function page() {
    if (configError) return <main className="status-panel page-width"><h1>A moment to reconnect.</h1><p role="alert">{configError}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>Try again</button></main>;
    if (!config || accountStatus === 'restoring') return <main className="status-panel page-width" role="status">Opening your account…</main>;
    if (accountStatus === 'error') return <main className="status-panel page-width"><h1>Let’s reconnect to your account.</h1><p role="alert">{accountError}</p><div className="account-actions"><button className="button primary" onClick={() => { setAccountStatus('restoring'); setAccountRetry(value => value + 1); }}>Try again</button><button className="button secondary" onClick={() => { accountGeneration.current += 1; clearSession(); setUser(null); setAccountStatus('signedout'); setAuthMode('signin'); }}>Sign in again</button></div></main>;
    if (isSchool) return <SchoolWorkspace key={user?.id || 'signedout'} config={config} user={user} onSignIn={() => setAuthMode('signin')} />;
    if (isLearner) {
      if (!user) return <main className="account-entry page-width"><span className="section-symbol"><ShieldCheck size={29} /></span><p className="eyebrow">YOUR LEARNING SPACE</p><h1>A little learning<br />starts here.</h1><p>Sign up or sign in to make this space yours. Then choose your class and learning language, and pick up where you left off.</p><div className="account-actions"><button className="button primary large" onClick={() => setAuthMode('signup')}>Sign up<ArrowRight size={18} /></button><button className="button secondary large" onClick={() => setAuthMode('signin')}>Sign in</button></div><p className="account-standalone">Learn independently or connect with your school using your own account.</p><a className="account-school" href="/school" onClick={event => { event.preventDefault(); navigate('/school'); }}>School staff or parent? Open your school workspace<ArrowRight size={16} /></a></main>;
      if (learningMatch && !preferences.loading && !preferences.error && preferences.profile.completed) return <>{recommendationId !== undefined && <div className="recommendation-banner page-width">This activity was opened from classroom guidance. Its new progress is recorded for your teacher. <a href="/" onClick={event => { event.preventDefault(); navigate('/'); }}>Latest recommendations</a></div>}{learningPage()}</>;
      const experience = <StudentExperience config={config} user={user} catalog={catalog} catalogError={catalogError} onRetryCatalog={() => setRetry(retry + 1)} path={pathname} search={path.includes('?') ? path.slice(path.indexOf('?')) : ''} navigate={navigate} onSignIn={() => setAuthMode('signin')} preferences={preferences} guidance={<GuidanceHome key={user.id} config={config} user={user} navigate={navigate} />} />;
      const personalLearning = new URLSearchParams(path.split('?')[1] || '').get('learn') === '1';
      return !preferences.loading && !preferences.error && !preferences.profile.completed && !personalLearning
        ? <LearnerEntry key={user.id} config={config} user={user} path={path} navigate={navigate}>{experience}</LearnerEntry> : experience;
    }
    return <main className="status-panel page-width"><h1>Let’s find your way back.</h1><p>This page is not in our learning library.</p><button className="button primary" onClick={() => navigate('/')}>Go to my library<ArrowRight size={18} /></button></main>;
  }
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header page-width"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }} aria-label="School Learning Simplified home"><span className="brand-mark"><BookOpen size={25} strokeWidth={1.8} /><span /></span><span>School Learning<span>Simplified</span></span></a><nav aria-label="Main navigation"><a className={!isSchool ? 'nav-link current' : 'nav-link'} href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>My library</a><a className={isSchool ? 'nav-link current' : 'nav-link'} href="/school" onClick={(event) => { event.preventDefault(); navigate('/school'); }}>School</a>{user ? <button className="button header-account" onClick={signOut} title={user.email}><LogOut size={16} />Sign out</button> : <button className="button header-account" onClick={() => setAuthMode('signin')} disabled={!config || accountStatus === 'restoring' || accountStatus === 'error'}>Sign in<ArrowRight size={16} /></button>}</nav></header>
    {sessionNotice && <div className="session-notice page-width" role="status">{sessionNotice}<button className="text-button" onClick={() => setSessionNotice('')} aria-label="Dismiss account notification">Dismiss</button></div>}
    <div id="main">
      {page()}
    </div>
    <footer className="site-footer page-width"><div><span className="footer-name">School Learning Simplified</span><p>A little clearer. A little more curious.</p></div><div><span>Made for learning, together.</span><small>{catalog?.schemaVersion === 2 ? 'Existing learning content, a new learning experience.' : 'Preview · Existing learning content, a new learning experience.'}</small></div></footer>
    {authMode && config && <AuthDialog config={config} initialMode={authMode} onClose={() => setAuthMode(null)} onSignedIn={(person) => { accountGeneration.current += 1; setUser(person); setAccountStatus('ready'); setAccountError(''); preferences.reload(); setAuthMode(null); setSessionNotice('You’re signed in to your own account.'); }} />}
  </>;
}
