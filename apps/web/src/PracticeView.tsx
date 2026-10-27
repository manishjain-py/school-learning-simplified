import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, RotateCcw } from 'lucide-react';
import { request } from './api';
import { ModeTabs } from './learningShared';
import { QuestionCard, type Review } from './QuestionCard';
import type { Config, Language, LearningMode, PracticeBank, PracticeSession, User } from './types';

export function PracticeView({ config, chapterId, user, onSignIn, onBack, onMode, recommendationId }: { config: Config; chapterId: string; user: User | null; onSignIn: () => void; onBack: () => void; onMode: (mode: LearningMode) => void; recommendationId?: string }) {
  const [language, setLanguage] = useState<Language>('en');
  const [bank, setBank] = useState<PracticeBank | null>(null);
  const [round, setRound] = useState<PracticeSession | null>(null);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [retry, setRetry] = useState(0);
  const newId = useRef<string | null>(null);
  const resume = useRef(false);
  const owner = useRef(user?.id || null);
  owner.current = user?.id || null;
  useEffect(() => () => { owner.current = null; }, []);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError('');
    void request<PracticeBank>(config, `/lessons/${chapterId}?mode=practice&language=${language}`, { signal: abort.signal }).then((data) => { if (!data.questions?.length) throw new Error('No practice questions are available for this chapter.'); setBank(data); }).catch((issue: Error) => { if (issue.name !== 'AbortError') setError(issue.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [config, chapterId, language, retry]);
  useEffect(() => {
    const abort = new AbortController(); setRound(null); setSessionError(''); newId.current = null;
    if (!user) { setSessionLoading(false); return; }
    setSessionLoading(true);
    void request<{ session: PracticeSession | null }>(config, `/practice/${chapterId}/session${recommendationId !== undefined ? `?recommendation=${encodeURIComponent(recommendationId)}` : ''}`, { authenticated: true, expectedUserId: user.id, signal: abort.signal }).then(({ session }) => { setRound(session); if (session) { setLanguage(session.language); resume.current = true; } }).catch((issue: Error) => { if (issue.name !== 'AbortError') setSessionError(issue.message); }).finally(() => { if (!abort.signal.aborted) setSessionLoading(false); });
    return () => abort.abort();
  }, [config, chapterId, user?.id, recommendationId, retry]);
  useEffect(() => { if (resume.current && bank && round) { const next = bank.questions.findIndex((question) => !round.answers.some((answer) => answer.questionId === question.id)); setIndex(next < 0 ? bank.questions.length - 1 : next); resume.current = false; } }, [bank, round]);
  async function startRound() {
    if (!user) { onSignIn(); return; }
    const expectedOwner = user.id;
    setSessionLoading(true); setSessionError(''); newId.current ||= crypto.randomUUID();
    try { const result = await request<{ session: PracticeSession }>(config, `/practice/${chapterId}/sessions`, { authenticated: true, expectedUserId: user.id, method: 'POST', body: { sessionId: newId.current, language, recommendationId } }); if (owner.current !== expectedOwner) return; setRound(result.session); setIndex(0); newId.current = null; }
    catch (issue) { setSessionError((issue as Error).message); }
    finally { setSessionLoading(false); }
  }
  async function changeLanguage(next: Language) {
    if (next === language) return;
    setLanguage(next);
    if (!user || !round) return;
    const expectedOwner = user.id;
    setSessionLoading(true); setSessionError('');
    try { const result = await request<{ session: PracticeSession }>(config, `/practice/${chapterId}/session`, { authenticated: true, expectedUserId: user.id, method: 'PUT', body: { language: next, recommendationId } }); if (owner.current === expectedOwner) setRound(result.session); }
    catch (issue) { setSessionError((issue as Error).message); }
    finally { setSessionLoading(false); }
  }
  const question = bank?.questions[index];
  const recorded = round?.answers.find((answer) => answer.questionId === question?.id);
  async function answer(selectedOptionIds: string[]): Promise<Review> {
    if (!round || !question || !user) throw new Error('Start a practice round first.');
    const expectedOwner = user.id;
    const result = await request<{ session: PracticeSession }>(config, `/practice/${chapterId}/attempts`, { authenticated: true, expectedUserId: user.id, method: 'POST', body: { sessionId: round.id, questionId: question.id, language, selectedOptionIds, recommendationId } });
    if (owner.current !== expectedOwner) throw new Error('The account changed. Open this practice round again.');
    setRound(result.session);
    const feedback = result.session.answers.find((item) => item.questionId === question.id);
    if (!feedback) throw new Error('Your answer was received, but its review could not be loaded. Try again.');
    return feedback;
  }
  return <main className="lesson-page page-width full-lesson"><button className="text-button back-link" onClick={onBack}><ArrowLeft size={16} />Back to your library</button><ModeTabs mode="practice" onMode={onMode} /><div className="lesson-heading"><div><p className="eyebrow">CLASS 4 · EVS · PRACTICE</p><h1>{bank?.title || 'Put your ideas to work'}</h1></div><div className="language-toggle" aria-label="Practice language"><button disabled={sessionLoading} aria-pressed={language === 'en'} onClick={() => void changeLanguage('en')}>English</button><button disabled={sessionLoading} aria-pressed={language === 'hi'} onClick={() => void changeLanguage('hi')} lang="hi">हिन्दी</button></div></div>
    {loading ? <div className="status-panel" role="status">Getting your questions ready…</div> : error ? <div className="status-panel"><p role="alert">{error}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>Try again</button></div> : bank && <>
      {sessionError && <div className="form-error" role="alert">{sessionError} <button className="text-button" onClick={() => setRetry(retry + 1)}>Reload saved round</button></div>}
      {!user || !round ? <section className="mode-intro"><span className="mode-count">{bank.questions.length}</span><h2>A little practice makes ideas clearer.</h2><p>Choose, check your thinking, and read the explanation. Your answers and score are saved to your own account. No school membership needed.</p><button className="button primary" disabled={sessionLoading} onClick={user ? startRound : onSignIn}>{sessionLoading ? 'Loading your round…' : user ? 'Start a practice round' : 'Sign in to practise'}<ArrowRight size={17} /></button></section> : question && <div className="lesson-layout"><aside className="lesson-outline"><p className="eyebrow">YOUR PRACTICE ROUND</p><div className="score-card"><strong>{round.answered}<span> / {round.totalQuestions}</span></strong><p>questions answered</p><span>{round.correctCount} correct so far</span></div><progress value={round.answered} max={round.totalQuestions} aria-label="Practice questions answered" /><label className="card-jump">Choose a question<select value={question.id} onChange={(event) => setIndex(bank.questions.findIndex((item) => item.id === event.target.value))}>{bank.questions.map((item, itemIndex) => <option key={item.id} value={item.id}>{itemIndex + 1}. {round.answers.some((response) => response.questionId === item.id) ? '✓ ' : ''}{item.prompt.slice(0, 65)}</option>)}</select></label><p className="round-note">Each question keeps your first answer in this round. Start another round whenever you want a fresh try.</p><button className="text-button" disabled={sessionLoading} onClick={startRound}><RotateCcw size={14} />{recommendationId ? 'Resume recommended round' : 'Start a new round'}</button></aside><section className="reading-card"><div className="card-kicker"><span>QUESTION {index + 1}</span><span>{index + 1} / {bank.questions.length}</span></div>{sessionLoading || sessionError ? <p role="status">{sessionError ? 'Reload your saved round to continue.' : 'Loading your saved answers…'}</p> : <QuestionCard key={`${round.id}-${question.id}-${language}`} question={question} language={language} existing={recorded} onAnswer={answer} />}<div className="lesson-actions"><button className="button secondary" onClick={() => setIndex(index - 1)} disabled={index === 0 || sessionLoading}><ArrowLeft size={16} />Previous</button><button className="button primary" onClick={() => setIndex(index + 1)} disabled={!recorded || index === bank.questions.length - 1 || sessionLoading}>Next question<ArrowRight size={16} /></button></div>{round.completed && <div className="completion" role="status"><CheckCircle2 size={24} /><div><strong>Your round is complete.</strong><p>{round.correctCount} correct out of {round.totalQuestions}. These are recorded practice results. Review any question or try a new round.</p><button className="text-button" onClick={() => onMode('revise')}>Revise the big ideas<ArrowRight size={15} /></button></div></div>}<p className="save-status">Every checked answer is saved to your account.</p></section></div>}
    </>}
  </main>;
}
