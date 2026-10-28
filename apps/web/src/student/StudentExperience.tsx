import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Globe2, GraduationCap, Headphones, Leaf, ListChecks, Settings2, Sparkles, UserRound } from 'lucide-react';
import { request } from '../api';
import type { Catalog, Chapter, Config, Language, LearningMode, PracticeSet, Progress, User } from '../types';
import { curriculumLabel, hasLibrary, type LearnerPreferences, type PreferenceChanges, type PreferenceController } from './preferences';
import './student.css';
import '../reports/reports.css';

type Props = { config: Config; user: User | null; catalog: Catalog | null; catalogError: string; onRetryCatalog: () => void; path: string; search: string; navigate: (path: string) => void; onSignIn: () => void; preferences: PreferenceController; guidance?: ReactNode };
const modes: LearningMode[] = ['learn', 'revise', 'practice'];
const text = (language: Language, en: string, hi: string) => language === 'hi' ? hi : en;
const subjectLabel = (subject: string, language: Language) => subject === 'EVS' ? text(language, 'Environmental Studies', 'पर्यावरण अध्ययन') : subject;
const subjectPath = (subject: string) => `/subjects/${encodeURIComponent(subject)}`;
const modeLabel = (mode: LearningMode, language: Language) => (language === 'hi' ? { learn: 'सीखें', revise: 'दोहराएँ', practice: 'अभ्यास' } : { learn: 'Learn', revise: 'Revise', practice: 'Practice' })[mode];
const modeDetail = (mode: LearningMode, language: Language) => (language === 'hi' ? {
  learn: 'कहानियों, आवाज़ और गतिविधियों के साथ एक-एक विचार समझें।',
  revise: 'छोटे कार्ड पढ़ें और सुनें, ज़रूरी बातें फिर से याद करें।',
  practice: 'सवाल हल करें, अपनी समझ परखें और हर जवाब से सीखें।',
} : {
  learn: 'Understand one idea at a time with stories, narration and activities.',
  revise: 'Bring the important ideas back with short, voiced revision cards.',
  practice: 'Try questions, check your thinking and learn from each answer.',
})[mode];
const ModeIcon = ({ mode }: { mode: LearningMode }) => mode === 'learn' ? <BookOpen size={25} /> : mode === 'revise' ? <Headphones size={25} /> : <ListChecks size={25} />;
const ErrorText = ({ text }: { text: string }) => text ? <p className="form-error" role="alert">{text}</p> : null;
const message = (issue: unknown) => issue instanceof Error ? issue.message : 'This change could not be saved. Please try again.';
function preferenceError(error: string, language: Language, fallback: string) {
  if (!error || language !== 'hi') return error;
  if (/sign in|session has ended|account changed/i.test(error)) return 'खाता दोबारा खोलने के लिए साइन इन करें। आपका बदलाव अभी सहेजा नहीं गया है।';
  if (/verify your email/i.test(error)) return 'अपनी पसंद सहेजने से पहले अपना ईमेल सत्यापित करें।';
  if (/another session/i.test(error)) return 'आपकी पसंद किसी दूसरे पेज पर बदल गई है। पेज फिर से लोड करके कोशिश करें।';
  if (/60 characters/i.test(error)) return 'अपना नाम 60 अक्षरों तक में लिखें।';
  if (/class from 1 to 12/i.test(error)) return 'कक्षा 1 से 12 में से चुनें।';
  if (/choose CBSE/i.test(error)) return 'सीबीएसई या दूसरा पाठ्यक्रम चुनें।';
  if (/choose English or Hindi/i.test(error)) return 'अंग्रेज़ी या हिन्दी चुनें।';
  if (/before finishing setup|each learner setup step/i.test(error)) return 'आगे बढ़ने से पहले नाम, कक्षा, पाठ्यक्रम और भाषा चुनें।';
  return fallback;
}

export function StudentExperience(props: Props) {
  const { preferences, navigate, path, user } = props;
  const language = preferences.profile.language || 'en';
  const copy = (en: string, hi: string) => text(language, en, hi);
  if (!user?.emailVerified) return <main className="student-area page-width student-loading" lang={language}><h1>{copy('Sign in to your learning space.', 'अपने सीखने के पेज पर साइन इन करें।')}</h1><button className="button primary" onClick={props.onSignIn}>{copy('Sign in', 'साइन इन करें')}<ArrowRight size={17} /></button></main>;
  if (preferences.loading) return <main className="student-area page-width student-loading" lang={language} role="status">{copy('Opening your learning space…', 'आपका सीखने का पेज खुल रहा है…')}</main>;
  if (preferences.error) return <main className="student-area page-width student-loading" lang={language}><h1>{copy('Let’s reconnect.', 'फिर से जुड़ें।')}</h1><ErrorText text={preferenceError(preferences.error, language, 'आपकी पसंद लोड नहीं हो सकी। फिर कोशिश करें या दोबारा साइन इन करें।')} /><button className="button primary" onClick={preferences.reload}>{copy('Try again', 'फिर कोशिश करें')}</button><button className="button secondary" onClick={props.onSignIn}>{copy('Sign in again', 'दोबारा साइन इन करें')}</button><a href="/school">{copy('Open school workspace', 'स्कूल का पेज खोलें')}</a></main>;
  if (!preferences.profile.completed) return <Setup key={preferences.ownerId} preferences={preferences} onDone={() => navigate(path === '/setup' ? '/' : `${path}${props.search}`)} />;
  if (path === '/profile') return <ProfileEditor key={preferences.ownerId} preferences={preferences} navigate={navigate} />;
  return <StudentLibrary {...props} />;
}

function Setup({ preferences, onDone }: { preferences: PreferenceController; onDone: () => void }) {
  const { profile, save } = preferences;
  const [draft, setDraft] = useState(profile); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { setDraft(profile); }, [profile.version]);
  const language = draft.language || 'en';
  const copy = (en: string, hi: string) => text(language, en, hi);
  const step = profile.setupStep;
  async function commit(changes: PreferenceChanges) { setBusy(true); setError(''); try { await save(changes); window.scrollTo(0, 0); } catch (issue) { setError(message(issue)); } finally { setBusy(false); } }
  async function next(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const change = step === 0 ? { displayName: draft.displayName.trim() } : step === 1 ? { grade: draft.grade } : step === 2 ? { curriculum: draft.curriculum } : step === 3 ? { language: draft.language || 'en' as const } : {};
    await commit({ ...change, setupStep: Math.min(step + 1, 5) });
  }
  async function finish() { setBusy(true); setError(''); try { await save({ completed: true, setupStep: 5 }); onDone(); } catch (issue) { setError(message(issue)); } finally { setBusy(false); } }
  const valid = step === 0 ? Boolean(draft.displayName.trim()) : step === 1 ? Boolean(draft.grade) : step === 2 ? Boolean(draft.curriculum) : true;
  return <main className="student-area page-width setup-page" lang={language}>
    <div className="setup-top"><span className="student-kicker">{copy('YOUR LEARNING SPACE', 'आपका सीखने का पेज')}</span>{step < 5 && <span>{copy(`Step ${step + 1} of 5`, `चरण ${step + 1} / 5`)}</span>}</div>
    {step < 5 && <progress value={step + 1} max={5} aria-label={copy('Learner setup progress', 'शुरुआती जानकारी भरने की प्रगति')} />}
    <form className="setup-card" onSubmit={next}>
      <span className="student-symbol">{step === 0 ? <UserRound /> : step === 1 ? <GraduationCap /> : step === 2 ? <BookOpen /> : step === 3 ? <Globe2 /> : <Sparkles />}</span>
      {step === 0 && <><h1>{copy('What should we call you?', 'हम आपको किस नाम से बुलाएँ?')}</h1><p>{copy('A first name or a nickname is enough.', 'आपका पहला नाम या घर में बुलाने वाला नाम काफ़ी है।')}</p><label className="student-field">{copy('Learner name', 'आपका नाम')}<input autoFocus autoComplete="given-name" maxLength={60} required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder={copy('Your name', 'अपना नाम लिखें')} /></label></>}
      {step === 1 && <><h1>{copy(`Which class are you in${profile.displayName ? `, ${profile.displayName}` : ''}?`, `${profile.displayName ? `${profile.displayName}, ` : ''}आप किस कक्षा में हैं?`)}</h1><p>{copy('We’ll shape your library around your class.', 'आपकी कक्षा के अनुसार अध्याय दिखाए जाएँगे।')}</p><div className="grade-grid" role="group" aria-label={copy('Choose your class', 'अपनी कक्षा चुनें')}>{Array.from({ length: 12 }, (_, index) => index + 1).map((grade) => <button type="button" key={grade} aria-pressed={draft.grade === grade} onClick={() => setDraft({ ...draft, grade })}>{copy(`Class ${grade}`, `कक्षा ${grade}`)}</button>)}</div><p className="student-note">{copy('Our current chapters are for Class 4. You can still save a different class and change it later.', 'अभी हमारे अध्याय कक्षा 4 के लिए हैं। आप अपनी कक्षा सहेज सकते हैं और बाद में बदल भी सकते हैं।')}</p></>}
      {step === 2 && <><h1>{copy('Which curriculum do you follow?', 'आपका पाठ्यक्रम कौन-सा है?')}</h1><p>{copy('Choose the one your school uses.', 'अपने स्कूल का पाठ्यक्रम चुनें।')}</p><div className="student-choices" role="group" aria-label={copy('Choose curriculum', 'पाठ्यक्रम चुनें')}><button type="button" aria-pressed={draft.curriculum === 'cbse'} onClick={() => setDraft({ ...draft, curriculum: 'cbse' })}><span><strong>{copy('CBSE', 'सीबीएसई')}</strong><small>{copy('Our available Class 4 EVS library', 'कक्षा 4 के पर्यावरण अध्ययन के उपलब्ध अध्याय')}</small></span><Check /></button><button type="button" aria-pressed={draft.curriculum === 'other'} onClick={() => setDraft({ ...draft, curriculum: 'other' })}><span><strong>{copy('Another curriculum', 'कोई दूसरा पाठ्यक्रम')}</strong><small>{copy('No matching chapters available yet', 'इस पाठ्यक्रम के अध्याय अभी उपलब्ध नहीं हैं')}</small></span><Check /></button></div></>}
      {step === 3 && <><h1>{copy('How would you like to learn?', 'आप किस भाषा में सीखना चाहेंगे?')}</h1><p>{copy('Choose the language for your lessons, revision and practice.', 'पढ़ने, दोहराने और अभ्यास करने की भाषा चुनें।')}</p><div className="student-choices language-choices" role="group" aria-label={copy('Preferred learning language', 'सीखने की पसंदीदा भाषा')}><button type="button" aria-pressed={(draft.language || 'en') === 'en'} onClick={() => setDraft({ ...draft, language: 'en' })}><span className="language-letter">Aa</span><span><strong lang="en">English</strong><small>{copy('Read and listen in English', 'अंग्रेज़ी में पढ़ें और सुनें')}</small></span><Check /></button><button type="button" aria-pressed={draft.language === 'hi'} onClick={() => setDraft({ ...draft, language: 'hi' })}><span className="language-letter" lang="hi">अ</span><span><strong lang="hi">हिन्दी</strong><small>{copy('Read and listen in Hindi', 'हिन्दी में पढ़ें और सुनें')}</small></span><Check /></button></div><p className="student-note">{copy('You can change your preference later or switch languages while learning.', 'आप बाद में अपनी पसंद बदल सकते हैं या पढ़ते समय दूसरी भाषा चुन सकते हैं।')}</p></>}
      {step === 4 && <><h1>{copy('Your learning library.', 'आपकी सीखने की लाइब्रेरी।')}</h1><p>{hasLibrary(profile) ? copy('Here are the chapters in your current library.', 'अभी आपकी लाइब्रेरी में ये अध्याय हैं।') : copy(`We don't have chapters for Class ${profile.grade} · ${curriculumLabel(profile.curriculum)} yet.`, `कक्षा ${profile.grade} · ${curriculumLabel(profile.curriculum, language)} के अध्याय अभी उपलब्ध नहीं हैं।`)}</p><div className="setup-book"><div className="book-cover"><Leaf size={35} /><strong>{copy('Our world, one idea at a time.', 'एक-एक विचार से अपनी दुनिया को जानें।')}</strong><span>{copy('ENVIRONMENTAL STUDIES', 'पर्यावरण अध्ययन')}</span></div><div><span className="student-kicker">{copy('AVAILABLE NOW', 'अभी उपलब्ध')}</span><h2>{copy('Class 4 Environmental Studies', 'कक्षा 4 पर्यावरण अध्ययन')}</h2><p>{copy('CBSE · 2026', 'सीबीएसई · 2026')}</p><ul><li>Our Earth</li><li>Animal Life</li></ul><span className="student-note">{copy('English and Hindi', 'अंग्रेज़ी और हिन्दी')}</span></div></div>{!hasLibrary(profile) && <button type="button" className="button secondary full" disabled={busy} onClick={() => void commit({ grade: 4, curriculum: 'cbse', setupStep: 4 })}>{copy('Choose Class 4 · CBSE instead', 'कक्षा 4 · सीबीएसई चुनें')}</button>}</>}
      {step === 5 && <><h1>{copy(`You’re ready, ${profile.displayName}.`, `${profile.displayName}, अब सीखना शुरू करें।`)}</h1><p>{copy('A chapter, three ways to make it stick.', 'एक अध्याय को समझने और याद रखने के तीन तरीके।')}</p><div className="setup-cycle">{modes.map((mode) => <div key={mode}><span><ModeIcon mode={mode} /></span><div><h2>{modeLabel(mode, language)}</h2><p>{modeDetail(mode, language)}</p></div></div>)}</div></>}
      <ErrorText text={preferenceError(error, language, 'यह बदलाव सहेजा नहीं जा सका। फिर कोशिश करें।')} />
      <div className="setup-actions">{step > 0 && <button type="button" className="button secondary" disabled={busy} onClick={() => void commit({ setupStep: step - 1 })}><ArrowLeft size={17} />{copy('Back', 'पीछे')}</button>}{step < 5 ? <button className="button primary" disabled={busy || !valid}>{busy ? copy('Saving…', 'सहेजा जा रहा है…') : step === 4 ? hasLibrary(profile) ? copy('Looks right', 'हाँ, सही है') : copy('Keep my selection', 'मेरी पसंद रखें') : copy('Continue', 'आगे बढ़ें')}<ArrowRight size={17} /></button> : <button type="button" className="button primary" disabled={busy} onClick={() => void finish()}>{busy ? copy('Saving…', 'सहेजा जा रहा है…') : copy('Start learning', 'सीखना शुरू करें')}<ArrowRight size={17} /></button>}</div>
      <p className="setup-save-note">{copy('Your choices are saved to your own account as you go.', 'आगे बढ़ते समय आपकी पसंद आपके अपने खाते में सहेजी जाती है।')}</p>
    </form>
  </main>;
}

function ProfileEditor({ preferences, navigate }: { preferences: PreferenceController; navigate: (path: string) => void }) {
  const [draft, setDraft] = useState(preferences.profile); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  const language = draft.language || 'en';
  const copy = (en: string, hi: string) => text(language, en, hi);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setSaved(false); setError('');
    try { await preferences.save({ displayName: draft.displayName.trim(), grade: draft.grade, curriculum: draft.curriculum, language: draft.language, ...(preferences.profile.completed ? { completed: true, setupStep: 5 } : {}) }); setSaved(true); }
    catch (issue) { setError(message(issue)); } finally { setBusy(false); }
  }
  return <main className="student-area page-width profile-page" lang={language}>
    <button className="student-back" onClick={() => navigate('/')}><ArrowLeft size={18} />{copy('My library', 'मेरी लाइब्रेरी')}</button>
    <div className="student-page-heading"><span className="student-symbol"><Settings2 /></span><h1>{copy('Your learner preferences', 'सीखने के लिए आपकी पसंद')}</h1><p>{copy('A few choices that make this space yours.', 'कुछ बातें जो इस पेज को आपके अनुसार बनाती हैं।')}</p></div>
    <form className="student-profile-form" onSubmit={submit}>
      <label className="student-field">{copy('Learner name', 'आपका नाम')}<input required maxLength={60} value={draft.displayName} onChange={(event) => { setDraft({ ...draft, displayName: event.target.value }); setSaved(false); }} /></label>
      <div className="student-form-row">
        <label className="student-field">{copy('Class', 'कक्षा')}<select aria-label={copy('Class', 'कक्षा')} required value={draft.grade || ''} onChange={(event) => { setDraft({ ...draft, grade: Number(event.target.value) }); setSaved(false); }}><option value="" disabled>{copy('Choose class', 'कक्षा चुनें')}</option>{Array.from({ length: 12 }, (_, index) => index + 1).map((grade) => <option key={grade} value={grade}>{copy(`Class ${grade}`, `कक्षा ${grade}`)}</option>)}</select></label>
        <label className="student-field">{copy('Curriculum', 'पाठ्यक्रम')}<select aria-label={copy('Curriculum', 'पाठ्यक्रम')} required value={draft.curriculum || ''} onChange={(event) => { setDraft({ ...draft, curriculum: event.target.value as 'cbse' | 'other' }); setSaved(false); }}><option value="" disabled>{copy('Choose curriculum', 'पाठ्यक्रम चुनें')}</option><option value="cbse">{copy('CBSE', 'सीबीएसई')}</option><option value="other">{copy('Another curriculum', 'कोई दूसरा पाठ्यक्रम')}</option></select></label>
      </div>
      <label className="student-field">{copy('Preferred learning language', 'सीखने की पसंदीदा भाषा')}<select aria-label={copy('Preferred learning language', 'सीखने की पसंदीदा भाषा')} required value={draft.language || ''} onChange={(event) => { setDraft({ ...draft, language: event.target.value as 'en' | 'hi' }); setSaved(false); }}><option value="" disabled>{copy('Choose language', 'भाषा चुनें')}</option><option value="en" lang="en">English</option><option value="hi" lang="hi">हिन्दी</option></select></label>
      <p className="student-note">{copy('Your preferred language opens the next activity. You can still switch while studying. Class and curriculum shape your library; they do not change your school’s records.', 'अगली गतिविधि आपकी पसंदीदा भाषा में खुलेगी। पढ़ते समय भी भाषा बदल सकते हैं। कक्षा और पाठ्यक्रम से आपकी लाइब्रेरी तय होती है; स्कूल के रिकॉर्ड नहीं बदलते।')}</p>
      <div className="profile-library-note"><BookOpen size={22} /><p>{copy('Available library: Class 4 · CBSE', 'उपलब्ध लाइब्रेरी: कक्षा 4 · सीबीएसई')}<br /><strong>{copy('Environmental Studies: Our Earth and Animal Life', 'पर्यावरण अध्ययन: Our Earth और Animal Life')}</strong></p></div>
      <ErrorText text={preferenceError(error, language, 'आपकी पसंद सहेजी नहीं जा सकी। फिर कोशिश करें।')} />
      {saved && <p className="notice" role="status">{copy('Preferences saved.', 'आपकी पसंद सहेज ली गई है।')}</p>}
      <button className="button primary full" disabled={busy}>{busy ? copy('Saving…', 'सहेजा जा रहा है…') : copy('Save preferences', 'अपनी पसंद सहेजें')}<Check size={17} /></button><p className="setup-save-note">{copy('Saved to your verified account.', 'आपके सत्यापित खाते में सहेजा जाता है।')}</p>
    </form>
  </main>;
}

function StudentLibrary({ config, user, catalog, catalogError, onRetryCatalog, path, search, navigate, preferences, guidance }: Props) {
  const profile = preferences.profile; const [switchError, setSwitchError] = useState(''); const [switching, setSwitching] = useState(false);
  const language = profile.language || 'en';
  const copy = (en: string, hi: string) => text(language, en, hi);
  const subjectMatch = path.match(/^\/subjects\/([^/]+)\/?$/); const chapterMatch = path.match(/^\/chapters\/([A-Za-z0-9_-]+)\/?$/);
  let selectedSubject: string | null = null;
  try { selectedSubject = subjectMatch ? decodeURIComponent(subjectMatch[1]) : null; } catch { /* Unknown subject state below. */ }
  const chapter = chapterMatch ? catalog?.chapters.find((item) => item.id === chapterMatch[1]) : null;
  const available = hasLibrary(profile) ? catalog?.chapters.filter((item) => item.grade === profile.grade) || [] : [];
  const subjects = [...new Set(available.map((item) => item.subject))];
  const selectedChapters = available.filter((item) => item.subject === selectedSubject);
  async function explore() { setSwitching(true); setSwitchError(''); try { await preferences.save({ grade: 4, curriculum: 'cbse' }); navigate('/'); } catch (issue) { setSwitchError(message(issue)); } finally { setSwitching(false); } }
  if (chapterMatch && chapter) return <ChapterWorkspace key={`${chapter.id}:${user?.id || ''}`} config={config} user={user} chapter={chapter} profile={profile} search={search} navigate={navigate} />;
  return <main className="student-area page-width library-home" lang={language}>
    {subjectMatch ? <button className="student-back" onClick={() => navigate('/')}><ArrowLeft size={18} />{copy('All subjects', 'सभी विषय')}</button> : <div className="learner-bar"><button className="learner-profile" onClick={() => navigate('/profile')}><span className="learner-avatar">{profile.displayName.slice(0, 1).toLocaleUpperCase()}</span><span><strong>{profile.displayName}</strong><small>{copy(`Class ${profile.grade}`, `कक्षा ${profile.grade}`)} · {curriculumLabel(profile.curriculum, language)}</small></span><ChevronRight size={18} /></button><span className="learner-language"><Globe2 size={16} />{language === 'hi' ? 'हिन्दी' : 'English'}</span></div>}
    {!subjectMatch && !chapterMatch && guidance}
    <div className="student-page-heading"><span className="student-kicker">{subjectMatch ? `${copy('CLASS', 'कक्षा')} ${profile.grade} · ${curriculumLabel(profile.curriculum, language)}` : copy('A LITTLE MORE CURIOUS, EVERY DAY', 'हर दिन कुछ नया जानें')}</span><h1>{subjectMatch ? subjectLabel(selectedSubject || copy('Subject', 'विषय'), language) : copy('What would you like to learn?', 'आप क्या सीखना चाहेंगे?')}</h1><p>{subjectMatch ? copy(`${selectedChapters.length} chapters to explore, one idea at a time.`, `${selectedChapters.length} अध्याय, एक-एक विचार समझते हुए पढ़ें।`) : copy('Choose a subject to find your next chapter.', 'अपना अगला अध्याय खोजने के लिए विषय चुनें।')}</p></div>
    {!subjectMatch && !chapterMatch && <div className="report-entry-row"><button type="button" className="button secondary report-entry" onClick={() => navigate('/report')}><ListChecks size={17} />{copy('My report card', 'मेरा रिपोर्ट कार्ड')}<ArrowRight size={16} /></button></div>}
    {catalogError ? <div className="student-empty"><h2>{copy('Your library couldn’t load.', 'आपकी लाइब्रेरी लोड नहीं हो सकी।')}</h2><ErrorText text={copy(catalogError, 'अध्याय नहीं खोले जा सके। फिर कोशिश करें।')} /><button className="button primary" onClick={onRetryCatalog}>{copy('Try again', 'फिर कोशिश करें')}</button></div>
      : !catalog ? <p className="student-loading" role="status">{copy('Finding your chapters…', 'आपके अध्याय खोजे जा रहे हैं…')}</p>
      : chapterMatch ? <div className="student-empty"><h2>{copy('This chapter is not available.', 'यह अध्याय उपलब्ध नहीं है।')}</h2><button className="button primary" onClick={() => navigate('/')}>{copy('Back to my subjects', 'मेरे विषयों पर वापस जाएँ')}</button></div>
      : !available.length ? <div className="student-empty"><span className="student-symbol"><BookOpen /></span><h2>{copy('No chapters for this selection yet.', 'इस चयन के लिए अभी अध्याय उपलब्ध नहीं हैं।')}</h2><p>{copy(`Your saved choice is Class ${profile.grade} · ${curriculumLabel(profile.curriculum)}. Our current library has two Class 4 CBSE EVS chapters.`, `आपकी सहेजी पसंद कक्षा ${profile.grade} · ${curriculumLabel(profile.curriculum, language)} है। अभी हमारी लाइब्रेरी में कक्षा 4 सीबीएसई पर्यावरण अध्ययन के दो अध्याय हैं।`)}</p><button className="button primary" disabled={switching} onClick={() => void explore()}>{switching ? copy('Saving selection…', 'आपकी पसंद सहेजी जा रही है…') : copy('Explore Class 4 · CBSE', 'कक्षा 4 · सीबीएसई के अध्याय देखें')}<ArrowRight size={17} /></button><button className="student-back" onClick={() => navigate('/profile')}>{copy('Change learner preferences', 'सीखने की पसंद बदलें')}</button><ErrorText text={preferenceError(switchError, language, 'आपकी पसंद सहेजी नहीं जा सकी। फिर कोशिश करें।')} /></div>
      : subjectMatch ? selectedChapters.length ? <div className="student-chapter-list">{selectedChapters.map((item, index) => <button className="student-chapter" key={item.id} onClick={() => navigate(`/chapters/${item.id}`)}><span className="student-chapter-number">{String(index + 1).padStart(2, '0')}</span><span className="student-chapter-copy"><strong>{item.title}</strong><small>{item.description}</small><span>{copy(`${item.partCount || 1} topics · English & Hindi`, `${item.partCount || 1} विषय · अंग्रेज़ी और हिन्दी`)}</span></span><ChevronRight size={22} /></button>)}</div> : <div className="student-empty"><h2>{copy('This subject is not in your library.', 'यह विषय आपकी लाइब्रेरी में नहीं है।')}</h2><button className="button secondary" onClick={() => navigate('/')}>{copy('Choose a subject', 'विषय चुनें')}</button></div>
      : <div className="student-subjects">{subjects.map((subject) => <button className="student-subject" key={subject} onClick={() => navigate(subjectPath(subject))}><span className="subject-art"><Leaf size={41} strokeWidth={1.4} /><span>{copy('OUR WORLD', 'हमारी दुनिया')}</span></span><span><strong>{subjectLabel(subject, language)}</strong><small>{copy(`${available.filter((item) => item.subject === subject).length} chapters · Class 4 · CBSE`, `${available.filter((item) => item.subject === subject).length} अध्याय · कक्षा 4 · सीबीएसई`)}</small></span><ArrowRight size={23} /></button>)}</div>}
  </main>;
}

function ChapterWorkspace({ config, user, chapter, profile, search, navigate }: { config: Config; user: User | null; chapter: Chapter; profile: LearnerPreferences; search: string; navigate: (path: string) => void }) {
  const [progress, setProgress] = useState<Partial<Record<LearningMode, string>>>({}); const [error, setError] = useState('');
  const language = profile.language || 'en';
  const copy = (en: string, hi: string) => text(language, en, hi);
  useEffect(() => {
    const abort = new AbortController(); setProgress({}); setError('');
    if (!user) return;
    Promise.all(modes.filter((mode) => chapter.modes?.includes(mode) ?? mode === 'learn').map(async (mode) => {
      if (mode === 'practice') {
        const { set } = await request<{ set: PracticeSet | null }>(config, `/practice/${chapter.id}/sets/current`, { authenticated: true, expectedUserId: user.id, signal: abort.signal });
        return [mode, set ? set.status === 'submitted'
          ? text(language, `${set.score}/${set.total} · submitted`, `${set.score}/${set.total} · जमा किया गया`)
          : text(language, `${Object.values(set.answers).filter(picks => picks.length).length}/${set.total} answered · in progress`, `${Object.values(set.answers).filter(picks => picks.length).length}/${set.total} जवाब दिए · जारी है`)
          : text(language, 'Start 10 questions', '10 सवालों का अभ्यास शुरू करें')] as const;
      }
      const value = await request<Progress>(config, `/progress/${chapter.id}?mode=${mode}`, { authenticated: true, expectedUserId: user.id, signal: abort.signal });
      const total = mode === 'learn' ? chapter.cardCount : chapter.reviseCount || 25;
      return [mode, text(language, `${value.completedCardIds.length} of ${total} ${mode === 'learn' ? 'ideas explored' : 'cards reviewed'}`, `${total} में से ${value.completedCardIds.length} ${mode === 'learn' ? 'विचार देखे' : 'कार्ड दोहराए'}`)] as const;
    })).then((entries) => { if (!abort.signal.aborted) setProgress(Object.fromEntries(entries)); }).catch((issue) => { if (issue.name !== 'AbortError') setError('Saved progress could not load. You can still open an activity to retry.'); });
    return () => abort.abort();
  }, [config, chapter.id, user?.id, language]);
  const query = new URLSearchParams(search); const originId = query.get('recommendation'); const originMode = query.get('mode'); const planId = query.get('plan');
  const hasOrigin = !!originId && /^[a-f0-9]{64}$/.test(originId) && modes.includes(originMode as LearningMode);
  function openMode(mode: LearningMode) {
    const continuation = new URLSearchParams();
    if (hasOrigin && originMode === mode) { continuation.set('recommendation', originId!); if (mode === 'revise' && planId) continuation.set('plan', planId); }
    navigate(`/${mode}/${chapter.id}${continuation.size ? `?${continuation}` : ''}`);
  }
  return <main className="student-area page-width chapter-workspace" lang={language}>
    <button className="student-back" onClick={() => navigate(subjectPath(chapter.subject))}><ArrowLeft size={18} />{subjectLabel(chapter.subject, language)}</button>
    <div className="chapter-workspace-heading"><div><p className="student-kicker">{copy(`CLASS ${chapter.grade} · ${chapter.subject}`, `कक्षा ${chapter.grade} · ${subjectLabel(chapter.subject, language)}`)}</p><h1>{chapter.title}</h1><p>{chapter.description}</p><span className="chapter-language"><Globe2 size={16} />{copy('Your preferred language: English', 'आपकी पसंदीदा भाषा: हिन्दी')}</span></div><span className="chapter-workspace-art"><Leaf size={68} strokeWidth={1.1} /></span></div>
    <div className="chapter-report-entry"><button type="button" className="button secondary report-entry" onClick={() => navigate('/report')}><ListChecks size={17} />{copy('My report card', 'मेरा रिपोर्ट कार्ड')}<ArrowRight size={16} /></button></div>
    {hasOrigin && <p className="notice">{copy(`Your teacher recommended ${modeLabel(originMode as LearningMode, language)}. Return to that activity below to keep its recorded progress together.`, `आपके शिक्षक ने “${modeLabel(originMode as LearningMode, language)}” का सुझाव दिया है। उसी गतिविधि को नीचे से खोलें ताकि उसकी प्रगति एक साथ दर्ज रहे।`)}</p>}
    <h2 className="mode-heading">{copy('How would you like to study?', 'आप किस तरह पढ़ना चाहेंगे?')}</h2>
    <div className="student-mode-grid">{modes.filter((mode) => chapter.modes?.includes(mode) ?? mode === 'learn').map((mode) => <button className={`student-mode ${mode}`} key={mode} onClick={() => openMode(mode)}><span className="student-mode-icon"><ModeIcon mode={mode} /></span><span className="student-mode-copy"><strong>{modeLabel(mode, language)}{hasOrigin && originMode === mode && <small className="recommended-mode">{copy('FROM YOUR TEACHER', 'आपके शिक्षक का सुझाव')}</small>}</strong><span>{modeDetail(mode, language)}</span><small>{hasOrigin && originMode === mode ? copy('Continue your recommended activity', 'सुझाई गई गतिविधि जारी रखें') : progress[mode] || copy('Opening saved progress…', 'सहेजी गई प्रगति खुल रही है…')}</small></span><ArrowRight size={20} /></button>)}</div>
    <ErrorText text={error ? copy(error, 'सहेजी गई प्रगति लोड नहीं हो सकी। फिर कोशिश करने के लिए गतिविधि खोल सकते हैं।') : ''} />
  </main>;
}
