import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, RotateCcw } from 'lucide-react';
import { request } from './api';
import { ModeTabs, Text } from './learningShared';
import { Narration } from './Narration';
import { ProgressStatus } from './ProgressStatus';
import { useLearningProgress } from './useLearningProgress';
import type { Config, Language, LearningMode, Revision, User } from './types';

export function ReviseView({ config, chapterId, user, onSignIn, onBack, onMode, recommendationId, preferredLanguage, onContinueToPractice }: { config: Config; chapterId: string; user: User | null; onSignIn: () => void; onBack: () => void; onMode: (mode: LearningMode) => void; recommendationId?: string; preferredLanguage?: Language; onContinueToPractice?: () => Promise<void> }) {
  const progress = useLearningProgress(config, chapterId, user, 'revise', recommendationId, preferredLanguage);
  const [revision, setRevision] = useState<Revision | null>(null);
  const [face, setFace] = useState<'question' | 'answer'>('question');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const { language } = progress;
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError('');
    void request<Revision>(config, `/lessons/${chapterId}?mode=revise&language=${language}`, { signal: abort.signal }).then((data) => { if (!data.cards?.length) throw new Error('Revision cards are not available yet.'); setRevision(data); }).catch((issue: Error) => { if (issue.name !== 'AbortError') setError(issue.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [config, chapterId, language, retry]);
  const index = Math.max(0, revision?.cards.findIndex((card) => card.id === progress.currentCardId) ?? 0);
  const card = revision?.cards[index];
  useEffect(() => setFace('question'), [card?.id, language]);
  const complete = progress.completedIds.filter((id) => revision?.cards.some((item) => item.id === id));
  const allReviewed = Boolean(revision?.cards.length && complete.length === revision.cards.length);
  const waitingForSave = progress.saving || !progress.saved || Boolean(progress.error) || progress.loading;
  const journeyPending = Boolean(onContinueToPractice) && (progress.saving || continuing);
  async function continueToPractice() {
    if (!onContinueToPractice || !allReviewed || waitingForSave || continuing || loading || error) return;
    setContinuing(true); setContinueError('');
    try { await onContinueToPractice(); }
    catch (issue) { if (mounted.current) setContinueError((issue as Error).message || 'Your practice set could not open. Please try again.'); }
    finally { if (mounted.current) setContinuing(false); }
  }
  function changeMode(mode: LearningMode) {
    if (journeyPending) { setContinueError('Wait for your revision to finish saving before changing modes.'); return; }
    onMode(mode);
  }
  function goTo(next: number) { if (!continuing && revision?.cards[next]) progress.visit(revision.cards[next].id); }
  function markReviewed() { if (card && revision) { const next = Math.min(index + 1, revision.cards.length - 1); progress.visit(revision.cards[next].id, [...new Set([...complete, card.id])]); } }
  return <main className="lesson-page page-width full-lesson"><button className="text-button back-link" disabled={journeyPending} onClick={onBack}><ArrowLeft size={16} />Back to chapter</button><ModeTabs mode="revise" onMode={changeMode} /><div className="lesson-heading"><div><p className="eyebrow">CLASS 4 · EVS · REVISE</p><h1>{revision?.title || 'Bring the big ideas back'}</h1></div><div className="language-toggle" aria-label="Revision language"><button disabled={progress.loading || continuing} aria-pressed={language === 'en'} onClick={() => progress.changeLanguage('en', card?.id)}>English</button><button disabled={progress.loading || continuing} aria-pressed={language === 'hi'} onClick={() => progress.changeLanguage('hi', card?.id)} lang="hi">हिन्दी</button></div></div>
    {continueError && !allReviewed && <p className="form-error" role="alert">{continueError}</p>}
    {loading ? <div className="status-panel" role="status">Opening your revision cards…</div> : error ? <div className="status-panel"><p role="alert">{error}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>Try again</button></div> : revision && card && <div className="lesson-layout"><button className="mobile-learning-tools" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>{toolsOpen ? 'Hide chapter tools' : 'Chapter tools & progress'}<span>{toolsOpen ? '−' : '+'}</span></button><aside className={`lesson-outline${toolsOpen ? ' tools-open' : ''}`}><p className="eyebrow">RECALL, THEN REVEAL</p><div className="score-card"><strong>{complete.length}<span> / {revision.cards.length}</span></strong><p>cards revisited</p></div><progress value={complete.length} max={revision.cards.length} aria-label="Revision cards reviewed" /><label className="card-jump">Choose a revision card<select disabled={continuing} value={card.id} onChange={(event) => goTo(revision.cards.findIndex((item) => item.id === event.target.value))}>{revision.cards.map((item, itemIndex) => <option key={item.id} value={item.id}>{itemIndex + 1}. {item.question.display.slice(0, 65)}</option>)}</select></label><p className="round-note">Try to recall the answer before turning the card. There’s no timer and no rush.</p>{!user && <button className="text-button" onClick={onSignIn}>Sign in to save revision<ArrowRight size={14} /></button>}</aside><section className="reading-card revision-card"><div className="card-kicker"><span>{face === 'question' ? 'THINK ABOUT IT' : 'THE BIG IDEA'}</span><span>{index + 1} / {revision.cards.length}</span></div><div className="flashcard-face" lang={language}><h2><Text>{card[face].display}</Text></h2><button className="button secondary" disabled={continuing} onClick={() => setFace(face === 'question' ? 'answer' : 'question')}><RotateCcw size={17} />{face === 'question' ? 'Reveal answer' : 'Back to question'}</button></div><Narration key={`${card.id}-${face}-${language}`} lines={[card[face]]} language={language} showText={false} /><div className="lesson-actions"><button className="button secondary" disabled={index === 0 || progress.loading || continuing} onClick={() => goTo(index - 1)}><ArrowLeft size={16} />Previous</button><button className="button primary" disabled={face !== 'answer' || progress.loading || continuing} onClick={markReviewed}>{index === revision.cards.length - 1 ? 'Finish revision' : 'Reviewed, next card'}<ArrowRight size={16} /></button></div>{allReviewed && <div className="completion" role="status"><CheckCircle2 size={23} /><div><strong>You’ve revisited every idea.</strong><p>All {revision.cards.length} cards reviewed. Come back whenever you want a refresher.</p><button className="text-button" disabled={journeyPending} onClick={onBack}>Back to chapter<ArrowRight size={15} /></button>{onContinueToPractice && <div className="test-journey-continuation"><button type="button" className="button primary" disabled={waitingForSave || continuing || loading || Boolean(error)} onClick={() => void continueToPractice()}>{continuing ? 'Opening your Practice set…' : 'Continue to Practice set'}<ArrowRight size={17} /></button>{progress.saving && <p className="save-status" role="status">Saving your final revision cards…</p>}{continueError && <p className="form-error" role="alert">{continueError}</p>}</div>}</div></div>}{user && <ProgressStatus {...progress} retry={() => progress.retry(card.id)} />}</section></div>}
  </main>;
}
