import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Headphones } from 'lucide-react';
import { request } from './api';
import type { Config, Language, LearningMode, Lesson, User } from './types';
import { Narration } from './Narration';
import { QuestionCard } from './QuestionCard';
import { ModeTabs } from './learningShared';
import { useLearningProgress } from './useLearningProgress';
import { ProgressStatus } from './ProgressStatus';
import { VisualStage } from './visuals';

export function LessonView({ config, chapterId, user, onSignIn, onBack, onMode, recommendationId, preferredLanguage }: { config: Config; chapterId: string; user: User | null; onSignIn: () => void; onBack: () => void; onMode: (mode: LearningMode) => void; recommendationId?: string; preferredLanguage?: Language }) {
  const [lesson, setLesson] = useState<Lesson | null>(null);
  // Keep the same media element across cards so a browser audio permission persists.
  const lessonAudio = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [reviewed, setReviewed] = useState<string[]>([]);
  const progress = useLearningProgress(config, chapterId, user, 'learn', recommendationId, preferredLanguage);
  const { language } = progress;
  const copy = (en: string, hi: string) => language === 'hi' ? hi : en;
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void request<Lesson>(config, `/lessons/${chapterId}?language=${language}`, { signal: controller.signal }).then((data) => {
      if (!data.cards?.length) throw new Error('This lesson has no cards available yet.');
      if (data.id !== chapterId || data.language !== language) throw new Error('The requested lesson could not be loaded. Please try again.');
      setLesson(data);
    }).catch((issue: Error) => { if (issue.name !== 'AbortError') setError(issue.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [config, chapterId, language, retry]);
  const index = Math.max(0, lesson?.cards.findIndex((card) => card.id === progress.currentCardId) ?? 0);
  const card = lesson?.cards[index];
  const full = Boolean(lesson && lesson.schemaVersion >= 2);
  const activePart = lesson?.parts?.find((part) => part.id === card?.partId);
  const completed = progress.completedIds.filter((id) => lesson?.cards.some((item) => item.id === id));
  const allComplete = Boolean(lesson && completed.length === lesson.cards.length);
  const lessonPending = loading || progress.loading || (!error && lesson?.language !== language);
  const checkinReady = card?.kind !== 'check_in' || reviewed.includes(card.id) || completed.includes(card.id);
  function goTo(next: number) { if (lesson?.cards[next]) progress.visit(lesson.cards[next].id); }
  function finishCard() {
    if (!lesson || !card) return;
    const next = Math.min(index + 1, lesson.cards.length - 1);
    progress.visit(lesson.cards[next].id, [...new Set([...completed, card.id])]);
  }
  function cardActions(control?: ReactNode) {
    return <div className="lesson-actions"><button className="button secondary" onClick={() => goTo(index - 1)} disabled={index === 0 || progress.loading}><ArrowLeft size={16} />{copy('Previous', 'पिछला')}</button>{control}<button className="button primary" onClick={finishCard} disabled={!checkinReady || progress.loading}>{index === lesson!.cards.length - 1 ? (full ? copy('Finish chapter', 'अध्याय पूरा करें') : copy('Finish preview', 'झलक पूरी करें')) : copy('Got it, next idea', 'समझ गए, आगे बढ़ें')}{index === lesson!.cards.length - 1 ? <Check size={17} /> : <ArrowRight size={17} />}</button></div>;
  }
  return <main className={`lesson-page page-width${full ? ' full-lesson' : ''}`} lang={language}>
    <button className="text-button back-link" onClick={onBack}><ArrowLeft size={16} />{copy('Back to chapter', 'अध्याय पर लौटें')}</button>
    {full && <ModeTabs mode="learn" onMode={onMode} language={language} />}
    <div className="lesson-heading"><div><p className="eyebrow">{copy('CLASS 4 · EVS', 'कक्षा 4 · पर्यावरण अध्ययन')} · {full ? copy('LEARN', 'सीखें') : copy('LESSON PREVIEW', 'पाठ की झलक')}</p><h1>{lesson?.title || copy('Your next discovery', 'आइए, कुछ नया जानें')}</h1></div><div className="language-toggle" aria-label={copy('Lesson language', 'पाठ की भाषा')}><button onClick={() => progress.changeLanguage('en', card?.id)} disabled={progress.loading} aria-pressed={language === 'en'}>English</button><button onClick={() => progress.changeLanguage('hi', card?.id)} disabled={progress.loading} aria-pressed={language === 'hi'} lang="hi">हिन्दी</button></div></div>
    <div className="preview-note"><Headphones size={17} /><span>{full ? copy('One idea at a time. Listen, explore the visuals and try the quick checks.', 'एक बार में एक बात। सुनें, चित्र देखें और छोटे सवालों के जवाब दें।') : copy('A first look at this chapter. Read a few ideas and listen in either language.', 'इस अध्याय की एक झलक। कुछ बातें पढ़ें और अपनी पसंद की भाषा में सुनें।')}</span></div>
    <audio ref={lessonAudio} preload="metadata" />
    {lessonPending ? <div className="status-panel" role="status">{copy('Opening your lesson…', 'आपका पाठ खोला जा रहा है…')}</div> : error ? <div className="status-panel"><h2>{copy('Let’s try that again.', 'फिर से कोशिश करें।')}</h2><p role="alert">{copy(error, 'यह पाठ नहीं खुल सका। फिर कोशिश करें।')}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>{copy('Reload lesson', 'पाठ फिर से खोलें')}</button></div> : lesson && card && <div className="lesson-layout">
      <button className="mobile-learning-tools" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>{toolsOpen ? copy('Hide chapter tools', 'अध्याय के विकल्प छिपाएँ') : copy('Chapter tools & progress', 'अध्याय के विकल्प और प्रगति')}<span>{toolsOpen ? '−' : '+'}</span></button><aside className={`lesson-outline${toolsOpen ? ' tools-open' : ''}`}><p className="eyebrow">{copy('YOUR SMALL STEPS', 'आपके छोटे-छोटे कदम')}</p>
        {full && lesson.parts && <div className="part-list">{lesson.parts.map((part) => <button key={part.id} className={part.id === activePart?.id ? 'part-button active' : 'part-button'} onClick={() => goTo(lesson.cards.findIndex((item) => item.id === part.cardIds[0]))}><span>{copy('TOPIC', 'विषय')} {part.sequence}</span><strong>{part.title}</strong><small>{part.cardIds.filter((id) => completed.includes(id)).length} / {part.cardIds.length} {copy('cards', 'कार्ड')}</small></button>)}</div>}
        {full && <label className="card-jump">{copy('Jump to an idea', 'कोई विचार चुनें')}<select value={card.id} onChange={(event) => goTo(lesson.cards.findIndex((item) => item.id === event.target.value))}>{lesson.cards.map((item, itemIndex) => <option key={item.id} value={item.id}>{itemIndex + 1}. {item.title}</option>)}</select></label>}
        {!full && <ol>{lesson.cards.map((item, itemIndex) => <li key={item.id}><button className={index === itemIndex ? 'active' : ''} aria-current={index === itemIndex ? 'step' : undefined} onClick={() => goTo(itemIndex)}><span className={completed.includes(item.id) ? 'step-number done' : 'step-number'}>{completed.includes(item.id) ? <Check size={15} /> : String(itemIndex + 1).padStart(2, '0')}</span><span>{item.title}</span></button></li>)}</ol>}
        <div className="progress-summary"><progress max={lesson.cards.length} value={completed.length} aria-label={copy('Completed lesson cards', 'पूरे किए गए पाठ कार्ड')} /><span>{copy(`${completed.length} of ${lesson.cards.length} ideas explored`, `${lesson.cards.length} में से ${completed.length} विचार देखे गए`)}</span></div>{!user && <div className="save-invitation"><p>{copy('Your curiosity deserves a bookmark.', 'जहाँ तक पढ़ा है, उसे सहेज लें।')}</p><button className="text-button" onClick={onSignIn}>{copy('Sign in to save your place', 'अपनी प्रगति सहेजने के लिए साइन इन करें')} <ArrowRight size={14} /></button></div>}
      </aside>
      <section className="reading-card" aria-label={copy('Lesson card', 'पाठ का कार्ड')}><div className="card-kicker"><span>{activePart ? `${copy('TOPIC', 'विषय')} ${activePart.sequence} · ` : ''}{card.kind === 'check_in' ? copy('QUICK CHECK', 'छोटा सवाल') : copy('IDEA', 'विचार')} {String(index + 1).padStart(2, '0')}</span><span>{index + 1} / {lesson.cards.length}</span></div><h2 lang={language}>{card.title}</h2>
        {card.kind === 'check_in' && card.question ? <>{card.visual && <VisualStage visual={card.visual} language={language} currentLine={0} currentTime={0} playing={false} replayKey={0} hasStarted={true} />}<QuestionCard key={`${card.id}-${language}`} question={card.question} language={language} onReviewed={() => setReviewed((current) => [...new Set([...current, card.id])])} />{cardActions()}</> : <Narration key={`${card.id}-${language}`} lines={card.lines} language={language} autoPlay waitForVisual={card.visual?.type === 'scene'} mediaRef={lessonAudio} controlMode="play-stop" renderControls={cardActions}>{card.visual ? (clock, onVisualReady) => <VisualStage visual={card.visual!} language={language} {...clock} onReady={onVisualReady} /> : undefined}</Narration>}
        {allComplete && <div className="completion" role="status"><CheckCircle2 size={23} /><div><strong>{copy('A little more understood.', 'कुछ और समझ में आया।')}</strong><p>{copy(`You’ve explored every idea in this ${full ? 'chapter' : 'preview'}. Come back for a listen whenever you like.`, `आपने इस ${full ? 'अध्याय' : 'झलक'} के सभी विचार देख लिए हैं। जब चाहें फिर से सुनें।`)}</p><button className="text-button" onClick={onBack}>{copy('Back to chapter', 'अध्याय पर लौटें')}<ArrowRight size={15} /></button></div></div>}
        {user && <ProgressStatus {...progress} retry={() => progress.retry(card.id)} />}
      </section>
    </div>}
  </main>;
}
