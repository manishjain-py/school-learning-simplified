import { uiText, uiError } from './uiCopy';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { ReportCardView } from './reports/ReportCardView';
import { ApiError, clearSession, identityClient, request, session } from './api';
import type { Catalog, Config, Language, LearningMode, User } from './types';
import type { Workspaces } from './school/types';

/** Resolve a new account's family role before offering learner setup. */
function LearnerEntry({ config, user, path, navigate, children, language }: { config: Config; user: User; path: string; navigate: (path: string) => void; children: ReactNode; language: Language }) {
  const copy = (source: string) => uiText(language, source);
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
  if (error) return <main className="status-panel page-width"><h1>{copy("Let’s reconnect to your school.")}</h1><p role="alert">{uiError(language, error)}</p><button className="button primary" onClick={() => setRetry(value => value + 1)}>{copy("Try again")}</button><button className="button secondary" onClick={() => navigate('/school')}>{copy("Open school workspace")}</button></main>;
  if (!roles || (parentOnly && home)) return <main className="status-panel page-width" role="status">{copy("Finding your school and family connections…")}</main>;
  if (parentOnly) {
    const destination = new URL(path, window.location.origin); destination.searchParams.set('learn', '1');
    return <main className="account-entry page-width"><p className="eyebrow">{copy("YOUR OWN LEARNING SPACE")}</p><h1>{copy("Would you like to learn too?")}</h1><p>{copy("Your child’s next steps are in your family workspace. You can also set up a learning space for yourself.")}</p><div className="account-actions"><button className="button primary" onClick={() => navigate('/school')}>{copy("Open family workspace")}</button><button className="button secondary" onClick={() => navigate(destination.pathname + destination.search)}>{copy("Learn for myself")}</button></div></main>;
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
  const currentPath = useRef(path); currentPath.current = path;
  const beforeLeave = useRef<(() => Promise<void>) | null>(null);
  const registerBeforeLeave = useCallback((guard: (() => Promise<void>) | null) => { beforeLeave.current = guard; }, []);
  const [sessionNotice, setSessionNotice] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const pop = async () => {
      const next = window.location.pathname + window.location.search;
      try { await beforeLeave.current?.(); setPath(next); }
      catch (issue) { window.history.pushState({}, '', currentPath.current); setSessionNotice((issue as Error).message || 'Your answers could not save. Try again before leaving.'); }
    };
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
  async function navigate(next: string) {
    try { await beforeLeave.current?.(); }
    catch (issue) { setSessionNotice((issue as Error).message || 'Your answers could not save. Try again before leaving.'); return; }
    if (window.location.pathname + window.location.search !== next) window.history.pushState({}, '', next);
    setPath(next); setSessionNotice(''); window.scrollTo(0, 0);
  }
  async function signOut() {
    try { await beforeLeave.current?.(); }
    catch (issue) { setSessionNotice((issue as Error).message || 'Your answers could not save. Try again before signing out.'); return; }
    beforeLeave.current = null;
    const token = session()?.accessToken; accountGeneration.current += 1; clearSession(); setUser(null); setAccountStatus('signedout'); setAccountError('');
    await navigate(isSchool ? '/school' : '/'); setSessionNotice('You are signed out on this device.');
    if (config && token) { try { await identityClient(config).send(new GlobalSignOutCommand({ AccessToken: token })); } catch { /* Local session is already removed. */ } }
  }
  const preferences = useStudentPreferences(config, user);
  const language: Language = preferences.profile.language || 'en';
  const copy = (source: string) => uiText(language, source);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>('#main h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [path, accountStatus, preferences.loading, preferences.profile.setupStep]);
  const pathname = path.split('?')[0];
  const recommendationId = new URLSearchParams(path.split('?')[1] || '').get('recommendation') ?? undefined;
  const requestedCardId = new URLSearchParams(path.split('?')[1] || '').get('card') ?? undefined;
  const requestedSetId = new URLSearchParams(path.split('?')[1] || '').get('set') ?? undefined;
  const testPlanId = new URLSearchParams(path.split('?')[1] || '').get('plan') ?? undefined;
  const learningMatch = pathname.match(/^\/(learn|practice|revise)\/([a-zA-Z0-9_-]+)\/?$/);
  function learningPage() {
    if (!config || preferences.loading) return <main className="status-panel page-width" role="status">{copy("Opening your learning space…")}</main>;
    if (preferences.error) return <main className="student-area page-width student-loading"><h1>{copy("Your learner preferences couldn’t load.")}</h1><p className="form-error" role="alert">{uiError(language, preferences.error)}</p><button className="button primary" onClick={preferences.reload}>{copy("Try again")}</button></main>;
    if (!catalog && learningMatch![1] !== 'learn') return <main className="status-panel page-width" role="status">{catalogError ? uiError(language, catalogError) : copy('Opening your learning space…')}</main>;
    const mode = learningMatch![1] as LearningMode;
    const chapterId = learningMatch![2];
    const entry = catalog?.chapters.find((item) => item.id === chapterId);
    if (mode !== 'learn' && !entry?.modes?.includes(mode)) return <main className="status-panel page-width"><h1>{copy("This learning mode is on its way.")}</h1><p>{copy("Explore the available lesson in the meantime.")}</p><button className="button primary" onClick={() => navigate(`/learn/${chapterId}`)}>{copy("Go to Learn")}<ArrowRight size={17} /></button></main>;
    const props = { config, chapterId, user, recommendationId, preferredLanguage: preferences.profile.language || undefined, onSignIn: () => setAuthMode('signin'), onBack: () => navigate(`/chapters/${chapterId}${recommendationId !== undefined ? `?recommendation=${encodeURIComponent(recommendationId)}&mode=${mode}${testPlanId ? `&plan=${encodeURIComponent(testPlanId)}` : ''}` : ''}`), onMode: (next: LearningMode) => navigate(`/${next}/${chapterId}${recommendationId !== undefined && next === mode ? `?recommendation=${encodeURIComponent(recommendationId)}${testPlanId ? `&plan=${encodeURIComponent(testPlanId)}` : ''}` : ''}`) };
    if (mode === 'practice') return <PracticeView key={`${chapterId}:${recommendationId || 'library'}:${requestedSetId || 'current'}:${user?.id || 'anonymous'}`} {...props} requestedSetId={requestedSetId} registerBeforeLeave={registerBeforeLeave} onPracticeAgain={() => { void navigate(`/practice/${chapterId}`); }} onOpenDraftContext={(setId, origin) => { void navigate(`/practice/${chapterId}?${new URLSearchParams({ set: setId, ...(origin ? { recommendation: origin } : {}) })}`); }} />;
    if (mode === 'revise') return <ReviseView key={`${chapterId}:${recommendationId || 'library'}:${user?.id || 'anonymous'}`} {...props} onContinueToPractice={testPlanId && recommendationId && user ? async () => {
      const { recommendation } = await request<{ recommendation: { id: string; chapterId: string; mode: string } }>(config, `/school/recommendations/test-plans/${encodeURIComponent(testPlanId)}/start`, { authenticated: true, expectedUserId: user.id, method: 'POST', body: { step: 'practice', recommendationId } });
      if (recommendation.mode !== 'practice' || recommendation.chapterId !== chapterId) throw new Error('This test guidance changed. Open your latest school next steps.');
      await navigate(`/practice/${chapterId}?${new URLSearchParams({ recommendation: recommendation.id, plan: testPlanId })}`);
    } : undefined} />;
    return <LessonView requestedCardId={requestedCardId} key={`${chapterId}:${recommendationId || 'library'}:${user?.id || 'anonymous'}`} {...props} />;
  }
  const parentReportMatch = pathname.match(/^\/school\/report\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/?$/);
  const isSchool = pathname === '/school' || pathname === '/school/' || Boolean(parentReportMatch);
  const isLearner = Boolean(learningMatch) || pathname === '/' || pathname === '/setup' || pathname === '/profile' || pathname === '/report' || /^\/(subjects|chapters)\/[^/]+\/?$/.test(pathname);
  function page() {
    if (configError) return <main className="status-panel page-width"><h1>{copy("A moment to reconnect.")}</h1><p role="alert">{uiError(language, configError)}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>{copy("Try again")}</button></main>;
    if (!config || accountStatus === 'restoring') return <main className="status-panel page-width" role="status">{copy("Opening your account…")}</main>;
    if (accountStatus === 'error') return <main className="status-panel page-width"><h1>{copy("Let’s reconnect to your account.")}</h1><p role="alert">{uiError(language, accountError)}</p><div className="account-actions"><button className="button primary" onClick={() => { setAccountStatus('restoring'); setAccountRetry(value => value + 1); }}>{copy("Try again")}</button><button className="button secondary" onClick={() => { accountGeneration.current += 1; clearSession(); setUser(null); setAccountStatus('signedout'); setAuthMode('signin'); }}>{copy("Sign in again")}</button></div></main>;
    if (parentReportMatch && user) return <ReportCardView key={`${user.id}:${parentReportMatch.slice(1).join(':')}`} config={config} user={user} navigate={navigate} parent={{ schoolId: parentReportMatch[1], classId: parentReportMatch[2], childId: parentReportMatch[3] }} />;
    if (isSchool) return <SchoolWorkspace key={user?.id || 'signedout'} config={config} user={user} onSignIn={() => setAuthMode('signin')} />;
    if (isLearner) {
      if (!user) return <main className="account-entry page-width"><span className="section-symbol"><ShieldCheck size={29} /></span><p className="eyebrow">{copy("YOUR LEARNING SPACE")}</p><h1>{copy("A little learning")}<br />{copy("starts here.")}</h1><p>{copy("Sign up or sign in to make this space yours. Then choose your class and learning language, and pick up where you left off.")}</p><div className="account-actions"><button className="button primary large" onClick={() => setAuthMode('signup')}>{copy("Sign up")}<ArrowRight size={18} /></button><button className="button secondary large" onClick={() => setAuthMode('signin')}>{copy("Sign in")}</button></div><p className="account-standalone">{copy("Learn independently or connect with your school using your own account.")}</p><a className="account-school" href="/school" onClick={event => { event.preventDefault(); navigate('/school'); }}>{copy("School staff or parent? Open your school workspace")}<ArrowRight size={16} /></a></main>;
      if (pathname === '/report' && !preferences.loading && !preferences.error && preferences.profile.completed) return <ReportCardView key={user.id} config={config} user={user} preferredLanguage={language} navigate={navigate} />;
      if (learningMatch && !preferences.loading && !preferences.error && preferences.profile.completed) return <>{recommendationId !== undefined && <div className="recommendation-banner page-width">{copy("This activity was opened from classroom guidance. Its new progress is recorded for your teacher.")} <a href="/" onClick={event => { event.preventDefault(); navigate('/'); }}>{copy("Latest recommendations")}</a></div>}{learningPage()}</>;
      const experience = <StudentExperience config={config} user={user} catalog={catalog} catalogError={catalogError} onRetryCatalog={() => setRetry(retry + 1)} path={pathname} search={path.includes('?') ? path.slice(path.indexOf('?')) : ''} navigate={navigate} onSignIn={() => setAuthMode('signin')} preferences={preferences} guidance={<GuidanceHome key={user.id} config={config} user={user} language={language} navigate={navigate} />} />;
      const personalLearning = new URLSearchParams(path.split('?')[1] || '').get('learn') === '1';
      return !preferences.loading && !preferences.error && !preferences.profile.completed && !personalLearning
        ? <LearnerEntry key={user.id} config={config} user={user} language={language} path={path} navigate={navigate}>{experience}</LearnerEntry> : experience;
    }
    return <main className="status-panel page-width"><h1>{copy("Let’s find your way back.")}</h1><p>{copy("This page is not in our learning library.")}</p><button className="button primary" onClick={() => navigate('/')}>{copy("Go to my library")}<ArrowRight size={18} /></button></main>;
  }
  return <>
    <a className="skip-link" href="#main">{copy("Skip to content")}</a>
    <header className="site-header page-width"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }} aria-label={copy("School Learning Simplified home")}><span className="brand-mark"><BookOpen size={25} strokeWidth={1.8} /><span /></span><span>School Learning<span>Simplified</span></span></a><nav aria-label={copy("Main navigation")}><a className={!isSchool ? 'nav-link current' : 'nav-link'} href="/" onClick={(event) => { event.preventDefault(); navigate('/'); }}>{copy("My library")}</a><a className={isSchool ? 'nav-link current' : 'nav-link'} href="/school" onClick={(event) => { event.preventDefault(); navigate('/school'); }}>{copy("School")}</a>{user ? <button className="button header-account" onClick={signOut} title={user.email}><LogOut size={16} />{copy("Sign out")}</button> : <button className="button header-account" onClick={() => setAuthMode('signin')} disabled={!config || accountStatus === 'restoring' || accountStatus === 'error'}>{copy("Sign in")}<ArrowRight size={16} /></button>}</nav></header>
    {sessionNotice && <div className="session-notice page-width" role="status">{uiError(language, sessionNotice)}<button className="text-button" onClick={() => setSessionNotice('')} aria-label={copy("Dismiss account notification")}>{copy("Dismiss")}</button></div>}
    <div id="main">
      {page()}
    </div>
    <footer className="site-footer page-width"><div><span className="footer-name">School Learning Simplified</span><p>{copy("A little clearer. A little more curious.")}</p></div><div><span>{copy("Made for learning, together.")}</span><small>{copy(catalog?.schemaVersion === 2 ? 'Existing learning content, a new learning experience.' : 'Preview · Existing learning content, a new learning experience.')}</small></div></footer>
    {authMode && config && <AuthDialog language={language} config={config} initialMode={authMode} onClose={() => setAuthMode(null)} onSignedIn={(person) => { accountGeneration.current += 1; setUser(person); setAccountStatus('ready'); setAccountError(''); preferences.reload(); setAuthMode(null); setSessionNotice('You’re signed in to your own account.'); }} />}
  </>;
}
