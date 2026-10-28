import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, History, ListChecks } from 'lucide-react';
import { request } from './api';
import { ModeTabs } from './learningShared';
import { createDraftSaver, type DraftSaveState, type DraftSnapshot } from './practice/draftSaver';
import { DraftQuestion, LegacyResults, PracticeHistory, PracticeResults, ReviewPicks, practiceCopy } from './practice/PracticePanels';
import type { Config, Language, LearningMode, LegacyRoundSummary, PracticeBank, PracticeSession, PracticeSet, PracticeSetSummary, User } from './types';
import './practice/practice.css';

type Props = { config: Config; chapterId: string; user: User | null; onSignIn: () => void; onBack: () => void; onMode: (mode: LearningMode) => void; recommendationId?: string; preferredLanguage?: Language; registerBeforeLeave?: (guard: (() => Promise<void>) | null) => void; onPracticeAgain?: () => void; requestedSetId?: string; onOpenDraftContext?: (setId: string, recommendationId?: string) => void };
type View = 'intro' | 'runner' | 'review' | 'results' | 'history' | 'legacy';
type HistoryData = { sets: PracticeSetSummary[]; legacyRounds: LegacyRoundSummary[] };
const cleanSave: DraftSaveState = { saving: false, dirty: false, error: '' };
const message = (issue: unknown) => issue instanceof Error ? issue.message : 'Your practice could not be saved. Please try again.';

export function PracticeView({ config, chapterId, user, onSignIn, onBack, onMode, recommendationId, preferredLanguage, registerBeforeLeave, onPracticeAgain, requestedSetId, onOpenDraftContext }: Props) {
  const [language, setLanguage] = useState<Language>(preferredLanguage || 'en');
  const [bank, setBank] = useState<PracticeBank | null>(null);
  const [bankLoading, setBankLoading] = useState(true);
  const [bankError, setBankError] = useState('');
  const [bankRetry, setBankRetry] = useState(0);
  const [active, setActive] = useState<PracticeSet | null>(null);
  const [legacy, setLegacy] = useState<PracticeSession | null>(null);
  const [view, setView] = useState<View>('intro');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<DraftSaveState>(cleanSave);
  const [history, setHistory] = useState<HistoryData>({ sets: [], legacyRounds: [] });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const activeRef = useRef<PracticeSet | null>(null);
  const saver = useRef<ReturnType<typeof createDraftSaver<PracticeSet>> | null>(null);
  const saveRef = useRef<DraftSaveState>(cleanSave);
  const newRequestId = useRef<string | null>(null);
  const owner = useRef(user?.id || null); owner.current = user?.id || null;
  const base = `/practice/${chapterId}/sets`;
  const text = (en: string, hi: string) => practiceCopy(language, en, hi);

  function installSet(set: PracticeSet) {
    saver.current?.dispose(); saver.current = null;
    activeRef.current = set; setActive(set); setLegacy(null); setLanguage(set.language); setError('');
    saveRef.current = cleanSave; setSaveState(cleanSave);
    setView(set.status === 'submitted' ? 'results' : 'runner');
    if (set.status !== 'draft' || !user) return;
    const expectedOwner = user.id;
    saver.current = createDraftSaver<PracticeSet>(set, {
      save: async (snapshot, version) => (await request<{ set: PracticeSet }>(config, `${base}/${set.id}`, { authenticated: true, expectedUserId: expectedOwner, method: 'PUT', body: { ...snapshot, version } })).set,
      read: async () => (await request<{ set: PracticeSet }>(config, `${base}/${set.id}`, { authenticated: true, expectedUserId: expectedOwner })).set,
      onSaved: saved => {
        if (owner.current !== expectedOwner || activeRef.current?.id !== saved.id) return;
        const current = activeRef.current;
        // A response must not roll back a newer answer or navigation queued while it travelled.
        const next = { ...saved, answers: current.answers, currentIndex: current.currentIndex, language: current.language } as PracticeSet;
        activeRef.current = next; setActive(next);
      },
      onState: state => { if (owner.current === expectedOwner && activeRef.current?.id === set.id) { saveRef.current = state; setSaveState(state); } },
    });
  }
  const flush = useCallback(async () => { if (saver.current) await saver.current.flush(); }, []);
  useEffect(() => { registerBeforeLeave?.(flush); return () => registerBeforeLeave?.(null); }, [registerBeforeLeave, flush]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (saveRef.current.dirty || saveRef.current.saving) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { owner.current = null; saver.current?.dispose(); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  useEffect(() => {
    const abort = new AbortController(); setBankLoading(true); setBankError('');
    request<PracticeBank>(config, `/lessons/${chapterId}?mode=practice&language=${language}`, { signal: abort.signal }).then(data => {
      if (!data.questions?.length) throw new Error('No practice questions are available for this chapter.');
      if (!abort.signal.aborted) setBank(data);
    }).catch(issue => { if (!abort.signal.aborted) setBankError(message(issue)); }).finally(() => { if (!abort.signal.aborted) setBankLoading(false); });
    return () => abort.abort();
  }, [config, chapterId, language, bankRetry]);
  useEffect(() => {
    const abort = new AbortController(); saver.current?.dispose(); saver.current = null; activeRef.current = null;
    setActive(null); setLoading(Boolean(user)); setLoadError('');
    if (!user) return;
    const expectedOwner = user.id;
    async function load() {
      let set = (await request<{ set: PracticeSet | null }>(config, requestedSetId ? `${base}/${encodeURIComponent(requestedSetId)}` : `${base}/current${recommendationId ? `?recommendation=${encodeURIComponent(recommendationId)}` : ''}`, { authenticated: true, expectedUserId: expectedOwner, signal: abort.signal })).set;
      if (!set && recommendationId) {
        newRequestId.current ||= crypto.randomUUID();
        set = (await request<{ set: PracticeSet }>(config, base, { authenticated: true, expectedUserId: expectedOwner, method: 'POST', body: { requestId: newRequestId.current, language: preferredLanguage || 'en', recommendationId }, signal: abort.signal })).set;
      }
      if (abort.signal.aborted || owner.current !== expectedOwner) return;
      if (set?.status === 'draft' && (set.recommendationId || undefined) !== recommendationId) {
        if (!onOpenDraftContext) throw new Error('Open this draft from its library or school recommendation to continue.');
        onOpenDraftContext(set.id, set.recommendationId); return;
      }
      if (set) { installSet(set); newRequestId.current = null; } else setView('intro');
    }
    void load().catch(issue => { if (!abort.signal.aborted && owner.current === expectedOwner) setLoadError(message(issue)); }).finally(() => { if (!abort.signal.aborted && owner.current === expectedOwner) setLoading(false); });
    return () => abort.abort();
  }, [config, chapterId, user?.id, recommendationId, requestedSetId, retry]);
  useEffect(() => {
    if (view !== 'runner' || !active) return;
    const frame = window.requestAnimationFrame(() => document.querySelector('.practice-runner')?.scrollIntoView({ block: 'start' }));
    return () => window.cancelAnimationFrame(frame);
  }, [active?.id, active?.currentIndex, view]);
  async function refreshHistory() {
    if (!user) return;
    const expectedOwner = user.id; setHistoryLoading(true); setHistoryError('');
    try { const data = await request<HistoryData>(config, base, { authenticated: true, expectedUserId: expectedOwner }); if (owner.current === expectedOwner) setHistory(data); }
    catch (issue) { if (owner.current === expectedOwner) setHistoryError(message(issue)); }
    finally { if (owner.current === expectedOwner) setHistoryLoading(false); }
  }
  useEffect(() => { void refreshHistory(); }, [config, chapterId, user?.id]);

  function updateDraft(change: Partial<DraftSnapshot>) {
    const current = activeRef.current;
    if (!current || current.status !== 'draft' || !saver.current || busy) return;
    const next = { ...current, ...change }; activeRef.current = next; setActive(next);
    if (change.language) setLanguage(change.language);
    setError(''); saver.current.update({ answers: next.answers, currentIndex: next.currentIndex, language: next.language });
  }
  async function action(work: () => Promise<void>) {
    if (busy) return; const expectedOwner = user?.id; setBusy(true); setError('');
    try { await work(); }
    catch (issue) { if (owner.current === expectedOwner) setError(message(issue)); }
    finally { if (owner.current === expectedOwner) setBusy(false); }
  }
  function leave(work: () => void) { void action(async () => { await flush(); work(); }); }
  function startSet(ordinary = false) {
    if (!user) { onSignIn(); return; }
    void action(async () => {
      await flush(); const expectedOwner = user.id; newRequestId.current ||= crypto.randomUUID();
      const result = await request<{ set: PracticeSet }>(config, base, { authenticated: true, expectedUserId: expectedOwner, method: 'POST', body: { requestId: newRequestId.current, language, ...(!ordinary && recommendationId ? { recommendationId } : {}) } });
      if (owner.current !== expectedOwner) return;
      newRequestId.current = null;
      if (ordinary && recommendationId && onPracticeAgain) { onPracticeAgain(); return; }
      installSet(result.set); void refreshHistory();
    });
  }
  function openSet(id: string) {
    if (!user) return;
    void action(async () => {
      await flush(); const expectedOwner = user.id;
      const { set } = await request<{ set: PracticeSet }>(config, `${base}/${id}?language=${language}`, { authenticated: true, expectedUserId: expectedOwner });
      if (owner.current !== expectedOwner) return;
      if (set.status === 'draft' && (set.recommendationId || undefined) !== recommendationId) {
        if (!onOpenDraftContext) throw new Error('Open this draft from its library or school recommendation to continue.');
        onOpenDraftContext(set.id, set.recommendationId); return;
      }
      installSet(set);
    });
  }
  function openLegacy(id: string) {
    if (!user) return;
    void action(async () => {
      await flush(); const expectedOwner = user.id;
      const { session } = await request<{ session: PracticeSession }>(config, `/practice/${chapterId}/rounds/${id}?language=${language}`, { authenticated: true, expectedUserId: expectedOwner });
      if (owner.current === expectedOwner) { setLegacy(session); setView('legacy'); }
    });
  }
  function showHistory() { void action(async () => { await flush(); setView('history'); await refreshHistory(); }); }
  function showCurrent() { setView(activeRef.current ? activeRef.current.status === 'submitted' ? 'results' : 'runner' : 'intro'); if (activeRef.current) setLanguage(activeRef.current.language); setLegacy(null); }
  function changeLanguage(next: Language) {
    if (next === language || busy) return;
    if (view === 'legacy' && legacy) {
      if (!user) return;
      void action(async () => { const expectedOwner = user.id; const { session } = await request<{ session: PracticeSession }>(config, `/practice/${chapterId}/rounds/${legacy.id}?language=${next}`, { authenticated: true, expectedUserId: expectedOwner }); if (owner.current === expectedOwner) { setLegacy(session); setLanguage(next); } });
    } else if (active?.status === 'draft') updateDraft({ language: next });
    else if (active?.status === 'submitted' && user) {
      void action(async () => { const expectedOwner = user.id; const { set } = await request<{ set: PracticeSet }>(config, `${base}/${active.id}?language=${next}`, { authenticated: true, expectedUserId: expectedOwner }); if (owner.current === expectedOwner) installSet(set); });
    } else setLanguage(next);
  }
  function submitSet() {
    if (!user || !saver.current) return;
    void action(async () => {
      const saved = await saver.current!.flush(); const expectedOwner = user.id;
      const { set } = await request<{ set: PracticeSet }>(config, `${base}/${saved.id}/submit`, { authenticated: true, expectedUserId: expectedOwner, method: 'POST', body: { version: saved.version } });
      if (owner.current === expectedOwner) { installSet(set); void refreshHistory(); }
    });
  }
  function retrySave() { void action(async () => { await saver.current?.retry(); }); }
  function reopenSaved() {
    if (!user || !active) return;
    if (saveRef.current.dirty && !window.confirm(text('Replace the unsaved choices on this page with the saved set? Your unsaved changes will be lost.', 'इस पेज के बिना सहेजे उत्तरों की जगह सहेजा हुआ सेट खोलें? बिना सहेजे बदलाव हट जाएँगे।'))) return;
    void action(async () => { const expectedOwner = user.id; const { set } = await request<{ set: PracticeSet }>(config, `${base}/${active.id}`, { authenticated: true, expectedUserId: expectedOwner }); if (owner.current === expectedOwner) installSet(set); });
  }
  const questions = active && bank ? active.questionIds.map(id => bank.questions.find(question => question.id === id)).filter(item => item !== undefined) : [];
  const question = active ? questions[active.currentIndex] : undefined;
  const answered = active ? active.questionIds.filter(id => active.answers[id]?.length).length : 0;
  const missingQuestions = active && bank && questions.length !== active.questionIds.length;
  const pendingText = saveState.error ? text('Your latest choices are still on this page. Retry saving before leaving.', 'आपके नए उत्तर अभी इस पेज पर हैं। जाने से पहले उन्हें फिर सहेजें।') : saveState.saving || saveState.dirty ? text('Saving your choices…', 'आपके उत्तर सहेजे जा रहे हैं…') : text('Your choices are saved to your account.', 'आपके उत्तर आपके खाते में सहेज दिए गए हैं।');

  return <main className="lesson-page page-width full-lesson practice-page"><button type="button" className="text-button back-link" disabled={busy} onClick={() => leave(onBack)}><ArrowLeft size={16} />{text('Back to chapter', 'अध्याय पर वापस जाएँ')}</button><ModeTabs mode="practice" onMode={mode => leave(() => onMode(mode))} />
    <div className="lesson-heading"><div><p className="eyebrow">{text('CLASS 4 · EVS · PRACTICE', 'कक्षा 4 · पर्यावरण अध्ययन · अभ्यास')}</p><h1>{bank?.title || text('Put your ideas to work', 'अपनी समझ को परखें')}</h1></div>{view !== 'history' && <div className="language-toggle" aria-label="Practice language"><button type="button" disabled={busy || loading} aria-pressed={language === 'en'} onClick={() => changeLanguage('en')}>English</button><button type="button" disabled={busy || loading} aria-pressed={language === 'hi'} onClick={() => changeLanguage('hi')} lang="hi">हिन्दी</button></div>}</div>
    {user && <div className="practice-toolbar"><span>{view === 'history' ? text('YOUR RECORDED WORK', 'आपका किया हुआ अभ्यास') : view === 'legacy' ? text('EARLIER PRACTICE ROUND', 'पुराना अभ्यास दौर') : active?.recommendationId ? text('FROM YOUR TEACHER', 'शिक्षक के सुझाव से') : text('TEN QUESTIONS AT A TIME', 'एक बार में दस प्रश्न')}</span>{view === 'history' || view === 'legacy' ? <button type="button" className="text-button" disabled={busy} onClick={showCurrent}><ArrowLeft size={16} />{text('Current set', 'मौजूदा सेट')}</button> : <button type="button" className="text-button" disabled={busy || loading} onClick={showHistory}><History size={16} />{text('Past sets', 'पिछले सेट')}</button>}</div>}
    {(error || saveState.error) && <div className="practice-save-error" role="alert"><p>{saveState.error || error}</p>{saveState.error && <><p>{pendingText}</p><div><button type="button" className="button secondary" disabled={busy} onClick={retrySave}>{text('Retry saving', 'फिर सहेजें')}</button><button type="button" className="text-button" disabled={busy} onClick={reopenSaved}>{text('Reopen saved set', 'सहेजा सेट खोलें')}</button></div></>}</div>}
    {busy && <p className="practice-busy" role="status">{text('Saving and opening your practice…', 'आपका अभ्यास सहेजकर खोला जा रहा है…')}</p>}
    {loading ? <div className="status-panel" role="status">{text('Opening your saved practice…', 'आपका सहेजा अभ्यास खोला जा रहा है…')}</div> : loadError ? <div className="status-panel"><p role="alert">{loadError}</p><button type="button" className="button primary" onClick={() => setRetry(value => value + 1)}>{text('Try again', 'फिर कोशिश करें')}</button></div> : view === 'history' ? <>{historyError && <p className="form-error" role="alert">{historyError}<button type="button" className="text-button" onClick={() => void refreshHistory()}>{text('Try again', 'फिर कोशिश करें')}</button></p>}{historyLoading ? <p role="status">{text('Opening past sets…', 'पिछले सेट खोले जा रहे हैं…')}</p> : <PracticeHistory {...history} language={language} disabled={busy} onOpen={openSet} onLegacy={openLegacy} />}</> : bankLoading ? <div className="status-panel" role="status">{text('Getting your questions ready…', 'आपके प्रश्न तैयार हो रहे हैं…')}</div> : bankError || missingQuestions ? <div className="status-panel"><p role="alert">{bankError || text('Some questions could not load. Your answers are safe in your saved set.', 'कुछ प्रश्न नहीं खुल सके। आपके उत्तर सहेजे हुए सेट में सुरक्षित हैं।')}</p><button type="button" className="button primary" onClick={() => setBankRetry(value => value + 1)}>{text('Try again', 'फिर कोशिश करें')}</button></div> : bank && <>
      {!user || view === 'intro' ? <section className="mode-intro practice-intro"><span className="mode-count">10</span><h2>{text('A little practice. A clearer idea.', 'थोड़ा अभ्यास। बेहतर समझ।')}</h2><p>{text('Try ten questions, review your picks, then submit. You’ll see your results and the reason behind every answer together.', 'दस प्रश्न करें, अपने उत्तर देखें, फिर जमा करें। उसके बाद नतीजे और हर उत्तर का कारण एक साथ देखें।')}</p><button type="button" className="button primary" disabled={busy} onClick={() => startSet()}>{user ? text('Start 10 questions', '10 प्रश्न शुरू करें') : text('Sign in to practise', 'अभ्यास के लिए साइन इन करें')}<ArrowRight size={17} /></button></section>
      : view === 'legacy' && legacy ? <LegacyResults round={legacy} bank={bank} language={language} />
      : active?.status === 'submitted' ? <PracticeResults key={active.id} set={active} questions={questions} language={language} disabled={busy} onAgain={() => startSet(true)} onKeepLearning={() => leave(() => onMode('learn'))} />
      : active && view === 'review' ? <><ReviewPicks set={active} questions={questions} language={language} disabled={busy} onEdit={index => { updateDraft({ currentIndex: index }); setView('runner'); }} onSubmit={submitSet} /><p className="save-status" role="status">{pendingText}</p></>
      : active && question ? <section className="practice-runner"><div className="practice-runner-progress"><div><span>{text('QUESTION', 'प्रश्न')} {active.currentIndex + 1} / {active.total}</span><span>{answered} {text('answered', 'के उत्तर दिए')}</span></div><progress value={active.currentIndex + 1} max={active.total} aria-label={text('Question position', 'प्रश्न संख्या')} /></div><div className="reading-card"><DraftQuestion key={`${active.id}:${question.id}:${language}`} question={question} selected={active.answers[question.id] || []} language={language} disabled={busy} onChange={ids => updateDraft({ answers: { ...activeRef.current!.answers, [question.id]: ids } })} />
        <div className="lesson-actions"><button type="button" className="button secondary" disabled={busy || active.currentIndex === 0} onClick={() => updateDraft({ currentIndex: active.currentIndex - 1 })}><ArrowLeft size={16} />{text('Previous', 'पिछला')}</button>{active.currentIndex < active.total - 1 ? <button type="button" className="button primary" disabled={busy} onClick={() => updateDraft({ currentIndex: active.currentIndex + 1 })}>{text('Next', 'अगला')}<ArrowRight size={16} /></button> : <button type="button" className="button primary" disabled={busy} onClick={() => setView('review')}>{text('Review picks', 'उत्तर देखें')}<ListChecks size={17} /></button>}</div>
        <button type="button" className="text-button practice-review-link" disabled={busy} onClick={() => setView('review')}><ListChecks size={16} />{text('Review all answers', 'सभी उत्तर देखें')} · {answered}/{active.total}</button><p className="save-status" role="status">{pendingText}</p></div></section> : null}
    </>}
  </main>;
}
