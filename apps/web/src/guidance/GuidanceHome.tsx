import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, RefreshCw } from 'lucide-react';
import { request } from '../api';
import type { Config, Language, User } from '../types';
import { currentSchoolGuidance, friendlySchoolDate, schoolCalendarDate } from '../school/dates';
import './guidance.css';

type Guidance = { id: string; chapterId: string; mode: 'learn' | 'practice' | 'revise'; title: string; reason: string; kind: string; date: string | null };
type TestPlan = { id: string; chapterId: string; chapterTitle: string; subject: string; date: string; reviseId: string; practiceId: string };
type ChildGuidance = { child: { id: string; name: string; schoolName: string; className: string }; recommendations: Guidance[]; timeZone: string; localToday: string; testPlans?: TestPlan[] };
type Mine = { studentStatus: string; student: ChildGuidance[]; parent: ChildGuidance[] };
const modeName = (mode: Guidance['mode'], language: Language) => language === 'hi' ? { learn: 'सीखें', practice: 'अभ्यास करें', revise: 'दोहराएँ' }[mode] : mode;
// These are application templates, not a translation of a teacher's own words.
function guidanceTitle(item: Guidance, language: Language) {
  if (language === 'en') return item.title;
  const prefix = `${{ learn: 'Learn', practice: 'Practise', revise: 'Revise' }[item.mode]}: `;
  return item.title.startsWith(prefix) ? `${modeName(item.mode, language)}: ${item.title.slice(prefix.length)}` : item.title;
}
function guidanceReason(reason: string, language: Language) {
  const translations: Record<string, string> = {
    'Your teacher covered this chapter in class.': 'आपके शिक्षक ने कक्षा में यह अध्याय पढ़ाया है।',
    'Your teacher assigned work on this chapter.': 'आपके शिक्षक ने इस अध्याय पर काम दिया है।',
    'Your teacher recorded a test on this chapter.': 'आपके शिक्षक ने इस अध्याय की परीक्षा की जानकारी दी है।',
    'Your teacher recommended extra practice on this chapter.': 'आपके शिक्षक ने इस अध्याय का थोड़ा और अभ्यास करने को कहा है।',
  };
  return language === 'hi' ? translations[reason] || reason : reason;
}
function guidanceError(error: string, language: Language) {
  if (language === 'en') return error;
  const translations: Record<string, string> = {
    'The classroom guidance changed. Refresh and try again.': 'कक्षा के सुझाव बदल गए हैं। उन्हें फिर से देखें और कोशिश करें।',
    'This learning recommendation is unavailable.': 'सीखने का यह सुझाव उपलब्ध नहीं है।',
    'Open the activity linked to this recommendation.': 'इस सुझाव से जुड़ी गतिविधि खोलें।',
    'Use the verified student account linked to this recommendation.': 'इस सुझाव से जुड़े सत्यापित विद्यार्थी खाते से प्रवेश करें।',
    'This recommendation belongs to another student.': 'यह सुझाव किसी दूसरे विद्यार्थी के लिए है।',
    'Your teacher updated this guidance. Open your latest recommendations.': 'आपके शिक्षक ने सुझाव बदल दिए हैं। अपने नए सुझाव खोलें।',
    'Open this recommendation from your homepage first.': 'पहले अपने होम पेज से यह सुझाव खोलें।',
    'Choose a step from this test plan.': 'परीक्षा की तैयारी का कोई कदम चुनें।',
    'Use the verified student account linked to this test plan.': 'परीक्षा की इस तैयारी से जुड़े सत्यापित विद्यार्थी खाते से प्रवेश करें।',
    'This test plan changed or its date passed. Open your latest school guidance.': 'परीक्षा की तैयारी बदल गई है या उसकी तारीख बीत गई है। स्कूल के नए सुझाव खोलें।',
    'Continue from the revision activity in this test plan.': 'परीक्षा की इस तैयारी में दोहराने वाली गतिविधि से आगे बढ़ें।',
    'Refresh your latest school guidance.': 'स्कूल के नए सुझाव फिर से देखें।',
    'The test date passed. Open your latest school guidance.': 'परीक्षा की तारीख बीत गई है। स्कूल के नए सुझाव खोलें।',
    'Revision cards are temporarily unavailable.': 'दोहराने के कार्ड अभी उपलब्ध नहीं हैं।',
    'Review every revision card and wait for your progress to save before continuing.': 'हर कार्ड दोहराएँ और आगे बढ़ने से पहले अपनी प्रगति सहेजे जाने का इंतज़ार करें।',
    'Sign in to save your learning progress.': 'अपनी सीखने की प्रगति सहेजने के लिए प्रवेश करें।',
    'The account changed. Please sign in again.': 'खाता बदल गया है। कृपया फिर से प्रवेश करें।',
    'Your session has ended. Please sign in again.': 'आपका सत्र समाप्त हो गया है। कृपया फिर से प्रवेश करें।',
    'The account changed. Open this lesson again to continue.': 'खाता बदल गया है। आगे बढ़ने के लिए पाठ फिर से खोलें।',
    'Your account could not reconnect. Check your connection and try again.': 'आपके खाते से दोबारा जुड़ नहीं सके। इंटरनेट कनेक्शन जाँचें और फिर कोशिश करें।',
  };
  return translations[error] || 'यह अनुरोध पूरा नहीं हो सका। कृपया फिर से कोशिश करें।';
}
export function GuidanceHome({ config, user, navigate, language = 'en' }: { config: Config; user: User; navigate: (path: string) => void; language?: Language }) {
  const copy = (en: string, hi: string) => language === 'hi' ? hi : en;
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
  return <section className="guidance-home page-width" lang={language} aria-labelledby="guidance-title">{upcoming && !error && <TestBanner group={upcoming.group} plan={upcoming.plan} language={language} disabled={Boolean(opening)} opening={opening === `plan:${upcoming.plan.id}`} onStart={() => void startPlan(upcoming.plan)} />}<div className="guidance-heading"><div><p className="eyebrow">{copy('FROM CLASSROOM TO HOME', 'कक्षा से घर तक')}</p><h2 id="guidance-title">{copy('Your school’s next steps', 'स्कूल से आपके अगले कदम')}</h2></div><button className="text-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />{copy('Refresh', 'फिर से देखें')}</button></div>
    {error && <p role="alert" className="form-error">{guidanceError(error, language)}</p>}{!data && !error && <p role="status">{copy('Finding your school’s learning recommendations…', 'स्कूल से मिले सीखने के सुझाव खोजे जा रहे हैं…')}</p>}
    {data?.studentStatus === 'ambiguous' && <p className="guidance-empty">{copy('Your student email matches more than one roster record. Ask your school to correct it. You can keep exploring the library.', 'आपका विद्यार्थी ईमेल स्कूल की सूची में एक से ज़्यादा बार दर्ज है। स्कूल से इसे ठीक करने को कहें। तब तक आप लाइब्रेरी में पढ़ सकते हैं।')}</p>}
    {studentGroups.map(group => <div key={group.child.id}><h3>{group.child.className} · {group.child.schoolName}</h3>{!group.recommendations.length ? <p className="guidance-empty">{copy('No current learning recommendations. Your library is ready whenever you are.', 'अभी सीखने का कोई नया सुझाव नहीं है। आप जब चाहें लाइब्रेरी में पढ़ सकते हैं।')}</p> : <div className="guidance-grid">{group.recommendations.map(item => <article className="guidance-card" key={item.id}><p className="eyebrow">{modeName(item.mode, language)} {item.date ? `· ${friendlySchoolDate(item.date, group.timeZone, { localToday: group.localToday, locale: language })}` : copy('· At your pace', '· अपनी गति से')}</p><h3>{guidanceTitle(item, language)}</h3><p>{guidanceReason(item.reason, language)}</p><button className="button primary" disabled={Boolean(opening)} onClick={() => void open(item)}>{opening === item.id ? copy('Opening…', 'खोला जा रहा है…') : copy(`Open ${item.mode}`, modeName(item.mode, language))}<ArrowRight size={16} /></button></article>)}</div>}</div>)}
    {data?.parent.map(currentGroup).map(group => <div className="guidance-family" key={group.child.id}><h3>{copy(`${group.child.name}’s next steps`, `${group.child.name} के अगले कदम`)}</h3><p>{group.child.className} · {group.child.schoolName}</p>{!group.recommendations.length ? <p className="guidance-empty">{copy('No current learning recommendations for this child.', 'इस बच्चे के लिए अभी सीखने का कोई नया सुझाव नहीं है।')}</p> : <div className="guidance-grid">{group.recommendations.map(item => <article className="guidance-card" key={item.id}><p className="eyebrow">{modeName(item.mode, language)} {item.date ? `· ${friendlySchoolDate(item.date, group.timeZone, { localToday: group.localToday, locale: language })}` : ''}</p><h3>{guidanceTitle(item, language)}</h3><p>{guidanceReason(item.reason, language)}</p><button className="text-button" onClick={() => navigate(`/${item.mode}/${item.chapterId}`)}>{copy('View the learning activity', 'सीखने की गतिविधि देखें')}<BookOpen size={15} /></button><small>{copy('Your child follows this recommendation from their own student account.', 'आपका बच्चा अपने विद्यार्थी खाते से इस सुझाव पर काम करता है।')}</small></article>)}</div>}</div>)}
    {data && (data.student.length > 0 || data.parent.length > 0) && <p className="guidance-attribution">Built with Llama · {copy('Classroom notes become catalog-backed learning activities.', 'कक्षा के नोट से हमारी लाइब्रेरी की सीखने की गतिविधियाँ सुझाई जाती हैं।')}</p>}
  </section>;
}

function TestBanner({ group, plan, language, disabled, opening, onStart }: { group: ChildGuidance; plan: TestPlan; language: Language; disabled: boolean; opening: boolean; onStart: () => void }) {
  const copy = (en: string, hi: string) => language === 'hi' ? hi : en;
  const friendlyDate = friendlySchoolDate(plan.date, group.timeZone, { localToday: group.localToday, locale: language });
  const today = plan.date === group.localToday;
  // Compare calendar dates, never translated labels or the browser's time zone.
  const tomorrow = Date.parse(`${plan.date}T12:00:00Z`) - Date.parse(`${group.localToday}T12:00:00Z`) === 86_400_000;
  const dateHeading = copy(today || tomorrow ? `Test ${friendlyDate}` : `Test · ${friendlyDate}`, `परीक्षा · ${friendlyDate}`);
  const when = today ? copy('today', 'आज') : tomorrow ? copy('tomorrow', 'कल') : copy(`on ${friendlyDate}`, `${friendlyDate} को`);
  const firstName = group.child.name.trim().split(/\s+/)[0] || group.child.name;
  const subject = language === 'hi' && plan.subject === 'EVS' ? 'पर्यावरण अध्ययन' : plan.subject;
  return <aside className="school-test-banner" aria-labelledby="school-test-title">
    <p className="school-test-date">{dateHeading}</p>
    <h2 id="school-test-title">{copy(`${firstName}, you have your ${plan.subject} ${plan.chapterTitle} test ${when}.`, `${firstName}, ${when} ${subject} के “${plan.chapterTitle}” अध्याय पर आपकी परीक्षा है।`)}</h2>
    <p className="school-test-invitation">{copy('Let’s spend some time practising.', 'चलिए, थोड़ा समय अभ्यास में लगाएँ।')}</p>
    <ol className="school-test-steps" aria-label={copy('Your test preparation steps', 'परीक्षा की तैयारी के कदम')}><li><span>1</span>{copy('Revise', 'दोहराएँ')}<span className="school-test-arrow" aria-hidden="true">→</span></li><li><span>2</span>{copy('Practice set', 'अभ्यास सेट')}</li></ol>
    <button type="button" className="button primary" disabled={disabled} onClick={onStart}>{opening ? copy('Opening…', 'खोला जा रहा है…') : copy('Start', 'शुरू करें')}<ArrowRight size={18} /></button>
    <p className="guidance-attribution">Built with Llama · {copy('from your teacher’s note', 'आपके शिक्षक के नोट से')}</p>
  </aside>;
}
