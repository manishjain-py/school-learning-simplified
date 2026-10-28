import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Globe2, GraduationCap, Headphones, Leaf, ListChecks, Settings2, Sparkles, UserRound } from 'lucide-react';
import { request } from '../api';
import type { Catalog, Chapter, Config, LearningMode, PracticeSession, Progress, User } from '../types';
import { curriculumLabel, hasLibrary, type LearnerPreferences, type PreferenceChanges, type PreferenceController } from './preferences';
import './student.css';

type Props = { config: Config; user: User | null; catalog: Catalog | null; catalogError: string; onRetryCatalog: () => void; path: string; search: string; navigate: (path: string) => void; onSignIn: () => void; preferences: PreferenceController; guidance?: ReactNode };
const modes: LearningMode[] = ['learn', 'revise', 'practice'];
const subjectLabel = (subject: string) => subject === 'EVS' ? 'Environmental Studies' : subject;
const subjectPath = (subject: string) => `/subjects/${encodeURIComponent(subject)}`;
const modeLabel = (mode: LearningMode) => ({ learn: 'Learn', revise: 'Revise', practice: 'Practice' }[mode]);
const modeDetail = { learn: 'Understand one idea at a time with stories, narration and activities.', revise: 'Bring the important ideas back with short, voiced revision cards.', practice: 'Try questions, check your thinking and learn from each answer.' };
const ModeIcon = ({ mode }: { mode: LearningMode }) => mode === 'learn' ? <BookOpen size={25} /> : mode === 'revise' ? <Headphones size={25} /> : <ListChecks size={25} />;
const ErrorText = ({ text }: { text: string }) => text ? <p className="form-error" role="alert">{text}</p> : null;
const message = (issue: unknown) => issue instanceof Error ? issue.message : 'This change could not be saved. Please try again.';

export function StudentExperience(props: Props) {
  const { preferences, navigate, path, user } = props;
  if (!user?.emailVerified) return <main className="student-area page-width student-loading"><h1>Sign in to your learning space.</h1><button className="button primary" onClick={props.onSignIn}>Sign in<ArrowRight size={17} /></button></main>;
  if (preferences.loading) return <main className="student-area page-width student-loading" role="status">Opening your learning space…</main>;
  if (preferences.error) return <main className="student-area page-width student-loading"><h1>Let’s reconnect.</h1><ErrorText text={preferences.error} /><button className="button primary" onClick={preferences.reload}>Try again</button><button className="button secondary" onClick={props.onSignIn}>Sign in again</button><a href="/school">Open school workspace</a></main>;
  if (!preferences.profile.completed) return <Setup key={preferences.ownerId} preferences={preferences} onDone={() => navigate(path === '/setup' ? '/' : `${path}${props.search}`)} />;
  if (path === '/profile') return <ProfileEditor key={preferences.ownerId} preferences={preferences} navigate={navigate} />;
  return <StudentLibrary {...props} />;
}

function Setup({ preferences, onDone }: { preferences: PreferenceController; onDone: () => void }) {
  const { profile, save } = preferences;
  const [draft, setDraft] = useState(profile); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { setDraft(profile); }, [profile.version]);
  const step = profile.setupStep;
  async function commit(changes: PreferenceChanges) { setBusy(true); setError(''); try { await save(changes); window.scrollTo(0, 0); } catch (issue) { setError(message(issue)); } finally { setBusy(false); } }
  async function next(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const change = step === 0 ? { displayName: draft.displayName.trim() } : step === 1 ? { grade: draft.grade } : step === 2 ? { curriculum: draft.curriculum } : step === 3 ? { language: draft.language || 'en' as const } : {};
    await commit({ ...change, setupStep: Math.min(step + 1, 5) });
  }
  async function finish() { setBusy(true); setError(''); try { await save({ completed: true, setupStep: 5 }); onDone(); } catch (issue) { setError(message(issue)); } finally { setBusy(false); } }
  const valid = step === 0 ? Boolean(draft.displayName.trim()) : step === 1 ? Boolean(draft.grade) : step === 2 ? Boolean(draft.curriculum) : true;
  return <main className="student-area page-width setup-page">
    <div className="setup-top"><span className="student-kicker">YOUR LEARNING SPACE</span>{step < 5 && <span>Step {step + 1} of 5</span>}</div>
    {step < 5 && <progress value={step + 1} max={5} aria-label="Learner setup progress" />}
    <form className="setup-card" onSubmit={next}>
      <span className="student-symbol">{step === 0 ? <UserRound /> : step === 1 ? <GraduationCap /> : step === 2 ? <BookOpen /> : step === 3 ? <Globe2 /> : <Sparkles />}</span>
      {step === 0 && <><h1>What should we call you?</h1><p>A first name or a nickname is enough.</p><label className="student-field">Learner name<input autoFocus autoComplete="given-name" maxLength={60} required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder="Your name" /></label></>}
      {step === 1 && <><h1>Which class are you in{profile.displayName ? `, ${profile.displayName}` : ''}?</h1><p>We’ll shape your library around your class.</p><div className="grade-grid" role="group" aria-label="Choose your class">{Array.from({ length: 12 }, (_, index) => index + 1).map((grade) => <button type="button" key={grade} aria-pressed={draft.grade === grade} onClick={() => setDraft({ ...draft, grade })}>Class {grade}</button>)}</div><p className="student-note">Our current chapters are for Class 4. You can still save a different class and change it later.</p></>}
      {step === 2 && <><h1>Which curriculum do you follow?</h1><p>Choose the one your school uses.</p><div className="student-choices" role="group" aria-label="Choose curriculum"><button type="button" aria-pressed={draft.curriculum === 'cbse'} onClick={() => setDraft({ ...draft, curriculum: 'cbse' })}><span><strong>CBSE</strong><small>Our available Class 4 EVS library</small></span><Check /></button><button type="button" aria-pressed={draft.curriculum === 'other'} onClick={() => setDraft({ ...draft, curriculum: 'other' })}><span><strong>Another curriculum</strong><small>No matching chapters available yet</small></span><Check /></button></div></>}
      {step === 3 && <><h1>How would you like to learn?</h1><p>Choose the language for your lessons, revision and practice.</p><div className="student-choices language-choices" role="group" aria-label="Preferred learning language"><button type="button" aria-pressed={(draft.language || 'en') === 'en'} onClick={() => setDraft({ ...draft, language: 'en' })}><span className="language-letter">Aa</span><span><strong>English</strong><small>Read and listen in English</small></span><Check /></button><button type="button" aria-pressed={draft.language === 'hi'} onClick={() => setDraft({ ...draft, language: 'hi' })}><span className="language-letter" lang="hi">अ</span><span><strong lang="hi">हिन्दी</strong><small>Read and listen in Hindi</small></span><Check /></button></div><p className="student-note">You can change your preference later or switch languages while learning.</p></>}
      {step === 4 && <><h1>Your learning library.</h1><p>{hasLibrary(profile) ? 'Here are the chapters in your current library.' : `We don't have chapters for Class ${profile.grade} · ${curriculumLabel(profile.curriculum)} yet.`}</p><div className="setup-book"><div className="book-cover"><Leaf size={35} /><strong>Our world,<br />one idea<br />at a time.</strong><span>ENVIRONMENTAL STUDIES</span></div><div><span className="student-kicker">AVAILABLE NOW</span><h2>Class 4 Environmental Studies</h2><p>CBSE · 2026</p><ul><li>Our Earth</li><li>Animal Life</li></ul><span className="student-note">English and Hindi</span></div></div>{!hasLibrary(profile) && <button type="button" className="button secondary full" disabled={busy} onClick={() => void commit({ grade: 4, curriculum: 'cbse', setupStep: 4 })}>Choose Class 4 · CBSE instead</button>}</>}
      {step === 5 && <><h1>You’re ready, {profile.displayName}.</h1><p>A chapter, three ways to make it stick.</p><div className="setup-cycle">{modes.map((mode) => <div key={mode}><span><ModeIcon mode={mode} /></span><div><h2>{modeLabel(mode)}</h2><p>{modeDetail[mode]}</p></div></div>)}</div></>}
      <ErrorText text={error} />
      <div className="setup-actions">{step > 0 && <button type="button" className="button secondary" disabled={busy} onClick={() => void commit({ setupStep: step - 1 })}><ArrowLeft size={17} />Back</button>}{step < 5 ? <button className="button primary" disabled={busy || !valid}>{busy ? 'Saving…' : step === 4 ? hasLibrary(profile) ? 'Looks right' : 'Keep my selection' : 'Continue'}<ArrowRight size={17} /></button> : <button type="button" className="button primary" disabled={busy} onClick={() => void finish()}>{busy ? 'Saving…' : 'Start learning'}<ArrowRight size={17} /></button>}</div>
      <p className="setup-save-note">Your choices are saved to your own account as you go.</p>
    </form>
  </main>;
}

function ProfileEditor({ preferences, navigate }: { preferences: PreferenceController; navigate: (path: string) => void }) {
  const [draft, setDraft] = useState(preferences.profile); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setSaved(false); setError('');
    try { await preferences.save({ displayName: draft.displayName.trim(), grade: draft.grade, curriculum: draft.curriculum, language: draft.language, ...(preferences.profile.completed ? { completed: true, setupStep: 5 } : {}) }); setSaved(true); }
    catch (issue) { setError(message(issue)); } finally { setBusy(false); }
  }
  return <main className="student-area page-width profile-page"><button className="student-back" onClick={() => navigate('/')}><ArrowLeft size={18} />My library</button><div className="student-page-heading"><span className="student-symbol"><Settings2 /></span><h1>Your learner preferences</h1><p>A few choices that make this space yours.</p></div><form className="student-profile-form" onSubmit={submit}><label className="student-field">Learner name<input required maxLength={60} value={draft.displayName} onChange={(event) => { setDraft({ ...draft, displayName: event.target.value }); setSaved(false); }} /></label><div className="student-form-row"><label className="student-field">Class<select aria-label="Class" required value={draft.grade || ''} onChange={(event) => { setDraft({ ...draft, grade: Number(event.target.value) }); setSaved(false); }}><option value="" disabled>Choose class</option>{Array.from({ length: 12 }, (_, index) => index + 1).map((grade) => <option key={grade} value={grade}>Class {grade}</option>)}</select></label><label className="student-field">Curriculum<select aria-label="Curriculum" required value={draft.curriculum || ''} onChange={(event) => { setDraft({ ...draft, curriculum: event.target.value as 'cbse' | 'other' }); setSaved(false); }}><option value="" disabled>Choose curriculum</option><option value="cbse">CBSE</option><option value="other">Another curriculum</option></select></label></div><label className="student-field">Preferred learning language<select aria-label="Preferred learning language" required value={draft.language || ''} onChange={(event) => { setDraft({ ...draft, language: event.target.value as 'en' | 'hi' }); setSaved(false); }}><option value="" disabled>Choose language</option><option value="en">English</option><option value="hi">हिन्दी · Hindi</option></select></label><p className="student-note">Your preferred language opens the next activity. You can still switch while studying. Class and curriculum shape your library; they do not change your school’s records.</p><div className="profile-library-note"><BookOpen size={22} /><p>Available library: Class 4 · CBSE<br /><strong>Environmental Studies: Our Earth and Animal Life</strong></p></div><ErrorText text={error} />{saved && <p className="notice" role="status">Preferences saved.</p>}<button className="button primary full" disabled={busy}>{busy ? 'Saving…' : 'Save preferences'}<Check size={17} /></button><p className="setup-save-note">Saved to your verified account.</p></form></main>;
}

function StudentLibrary({ config, user, catalog, catalogError, onRetryCatalog, path, search, navigate, preferences, guidance }: Props) {
  const profile = preferences.profile; const [switchError, setSwitchError] = useState(''); const [switching, setSwitching] = useState(false);
  const subjectMatch = path.match(/^\/subjects\/([^/]+)\/?$/); const chapterMatch = path.match(/^\/chapters\/([A-Za-z0-9_-]+)\/?$/);
  let selectedSubject: string | null = null;
  try { selectedSubject = subjectMatch ? decodeURIComponent(subjectMatch[1]) : null; } catch { /* Unknown subject state below. */ }
  const chapter = chapterMatch ? catalog?.chapters.find((item) => item.id === chapterMatch[1]) : null;
  const available = hasLibrary(profile) ? catalog?.chapters.filter((item) => item.grade === profile.grade) || [] : [];
  const subjects = [...new Set(available.map((item) => item.subject))];
  const selectedChapters = available.filter((item) => item.subject === selectedSubject);
  async function explore() { setSwitching(true); setSwitchError(''); try { await preferences.save({ grade: 4, curriculum: 'cbse' }); navigate('/'); } catch (issue) { setSwitchError(message(issue)); } finally { setSwitching(false); } }
  if (chapterMatch && chapter) return <ChapterWorkspace key={`${chapter.id}:${user?.id || ''}`} config={config} user={user} chapter={chapter} profile={profile} search={search} navigate={navigate} />;
  return <main className="student-area page-width library-home">
    {subjectMatch ? <button className="student-back" onClick={() => navigate('/')}><ArrowLeft size={18} />All subjects</button> : <div className="learner-bar"><button className="learner-profile" onClick={() => navigate('/profile')}><span className="learner-avatar">{profile.displayName.slice(0, 1).toLocaleUpperCase()}</span><span><strong>{profile.displayName}</strong><small>Class {profile.grade} · {curriculumLabel(profile.curriculum)}</small></span><ChevronRight size={18} /></button><span className="learner-language"><Globe2 size={16} />{profile.language === 'hi' ? 'हिन्दी' : 'English'}</span></div>}
    {!subjectMatch && !chapterMatch && guidance}
    <div className="student-page-heading"><span className="student-kicker">{subjectMatch ? `CLASS ${profile.grade} · ${curriculumLabel(profile.curriculum)}` : 'A LITTLE MORE CURIOUS, EVERY DAY'}</span><h1>{subjectMatch ? subjectLabel(selectedSubject || 'Subject') : 'What would you like to learn?'}</h1><p>{subjectMatch ? `${selectedChapters.length} chapters to explore, one idea at a time.` : 'Choose a subject to find your next chapter.'}</p></div>
    {catalogError ? <div className="student-empty"><h2>Your library couldn’t load.</h2><ErrorText text={catalogError} /><button className="button primary" onClick={onRetryCatalog}>Try again</button></div> : !catalog ? <p className="student-loading" role="status">Finding your chapters…</p> : chapterMatch ? <div className="student-empty"><h2>This chapter is not available.</h2><button className="button primary" onClick={() => navigate('/')}>Back to my subjects</button></div> : !available.length ? <div className="student-empty"><span className="student-symbol"><BookOpen /></span><h2>No chapters for this selection yet.</h2><p>Your saved choice is Class {profile.grade} · {curriculumLabel(profile.curriculum)}. Our current library has two Class 4 CBSE EVS chapters.</p><button className="button primary" disabled={switching} onClick={() => void explore()}>{switching ? 'Saving selection…' : 'Explore Class 4 · CBSE'}<ArrowRight size={17} /></button><button className="student-back" onClick={() => navigate('/profile')}>Change learner preferences</button><ErrorText text={switchError} /></div> : subjectMatch ? selectedChapters.length ? <div className="student-chapter-list">{selectedChapters.map((item, index) => <button className="student-chapter" key={item.id} onClick={() => navigate(`/chapters/${item.id}`)}><span className="student-chapter-number">{String(index + 1).padStart(2, '0')}</span><span className="student-chapter-copy"><strong>{item.title}</strong><small>{item.description}</small><span>{item.partCount || 1} parts · English & Hindi</span></span><ChevronRight size={22} /></button>)}</div> : <div className="student-empty"><h2>This subject is not in your library.</h2><button className="button secondary" onClick={() => navigate('/')}>Choose a subject</button></div> : <div className="student-subjects">{subjects.map((subject) => <button className="student-subject" key={subject} onClick={() => navigate(subjectPath(subject))}><span className="subject-art"><Leaf size={41} strokeWidth={1.4} /><span>OUR WORLD</span></span><span><strong>{subjectLabel(subject)}</strong><small>{available.filter((item) => item.subject === subject).length} chapters · Class 4 · CBSE</small></span><ArrowRight size={23} /></button>)}</div>}
  </main>;
}

function ChapterWorkspace({ config, user, chapter, profile, search, navigate }: { config: Config; user: User | null; chapter: Chapter; profile: LearnerPreferences; search: string; navigate: (path: string) => void }) {
  const [progress, setProgress] = useState<Partial<Record<LearningMode, string>>>({}); const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController(); setProgress({}); setError('');
    if (!user) return;
    Promise.all(modes.filter((mode) => chapter.modes?.includes(mode) ?? mode === 'learn').map(async (mode) => {
      if (mode === 'practice') {
        const { session } = await request<{ session: PracticeSession | null }>(config, `/practice/${chapter.id}/session`, { authenticated: true, expectedUserId: user.id, signal: abort.signal });
        return [mode, session ? `${session.answered} of ${session.totalQuestions} answered · ${session.correctCount} correct` : 'Ready for your first round'] as const;
      }
      const value = await request<Progress>(config, `/progress/${chapter.id}?mode=${mode}`, { authenticated: true, expectedUserId: user.id, signal: abort.signal });
      return [mode, `${value.completedCardIds.length} of ${mode === 'learn' ? chapter.cardCount : chapter.reviseCount || 25} ${mode === 'learn' ? 'ideas explored' : 'cards reviewed'}`] as const;
    })).then((entries) => setProgress(Object.fromEntries(entries))).catch((issue) => { if (issue.name !== 'AbortError') setError('Saved progress could not load. You can still open an activity to retry.'); });
    return () => abort.abort();
  }, [config, chapter.id, user?.id]);
  const query = new URLSearchParams(search); const originId = query.get('recommendation'); const originMode = query.get('mode');
  const hasOrigin = !!originId && /^[a-f0-9]{64}$/.test(originId) && modes.includes(originMode as LearningMode);
  function openMode(mode: LearningMode) { navigate(`/${mode}/${chapter.id}${hasOrigin && originMode === mode ? `?recommendation=${originId}` : ''}`); }
  return <main className="student-area page-width chapter-workspace"><button className="student-back" onClick={() => navigate(subjectPath(chapter.subject))}><ArrowLeft size={18} />{subjectLabel(chapter.subject)}</button><div className="chapter-workspace-heading"><div><p className="student-kicker">CLASS {chapter.grade} · {chapter.subject}</p><h1>{chapter.title}</h1><p>{chapter.description}</p><span className="chapter-language"><Globe2 size={16} />{profile.language === 'hi' ? 'Your preferred language: हिन्दी' : 'Your preferred language: English'}</span></div><span className="chapter-workspace-art"><Leaf size={68} strokeWidth={1.1} /></span></div>{hasOrigin && <p className="notice">Your teacher recommended {modeLabel(originMode as LearningMode)}. Return to that activity below to keep its recorded progress together.</p>}<h2 className="mode-heading">How would you like to study?</h2><div className="student-mode-grid">{modes.filter((mode) => chapter.modes?.includes(mode) ?? mode === 'learn').map((mode) => <button className={`student-mode ${mode}`} key={mode} onClick={() => openMode(mode)}><span className="student-mode-icon"><ModeIcon mode={mode} /></span><span className="student-mode-copy"><strong>{modeLabel(mode)}{hasOrigin && originMode === mode && <small className="recommended-mode">FROM YOUR TEACHER</small>}</strong><span>{modeDetail[mode]}</span><small>{hasOrigin && originMode === mode ? 'Continue your recommended activity' : progress[mode] || 'Opening saved progress…'}</small></span><ArrowRight size={20} /></button>)}</div><ErrorText text={error} /></main>;
}
