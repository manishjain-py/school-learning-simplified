import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Headphones, Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import { request } from './api';
import type { Card, Config, Language, Lesson, Progress, User } from './types';

function Narration({ card, language }: { card: Card; language: Language }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [line, setLine] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const shouldPlay = useRef(false);
  useEffect(() => {
    const element = audio.current!;
    element.src = card.lines[line]?.audioUrl || '';
    if (shouldPlay.current) void element.play().then(() => setPlaying(true)).catch(() => { setError('Audio could not play. Please try again.'); setPlaying(false); shouldPlay.current = false; });
  }, [card, line]);
  useEffect(() => { const element = audio.current; return () => { shouldPlay.current = false; element?.pause(); }; }, []);
  async function play() {
    setError('');
    if (playing) { shouldPlay.current = false; audio.current?.pause(); setPlaying(false); return; }
    shouldPlay.current = true;
    try { await audio.current?.play(); setPlaying(true); } catch { setPlaying(false); shouldPlay.current = false; setError('Audio could not play. Check your connection and try again.'); }
  }
  function replay() {
    setError(''); shouldPlay.current = true;
    if (line !== 0) setLine(0);
    else { if (audio.current) audio.current.currentTime = 0; void audio.current?.play().then(() => setPlaying(true)).catch(() => { setError('Audio could not play. Please try again.'); shouldPlay.current = false; }); }
  }
  return <>
    <div className="lesson-copy" lang={language}>
      {card.lines.map((item, index) => <p key={index} className={line === index && playing ? 'spoken-line' : ''}>{item.display.split(/(\*\*[^*]+\*\*)/g).map((part, partIndex) => part.startsWith('**') ? <strong key={partIndex}>{part.slice(2, -2)}</strong> : part)}</p>)}
    </div>
    <div className="audio-player">
      <button className="audio-play" onClick={play} aria-label={playing ? 'Pause narration' : 'Play narration'}>{playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button>
      <div className="audio-info"><strong>{playing ? (language === 'hi' ? 'सुनते रहिए…' : 'Listen and discover') : (language === 'hi' ? 'पाठ सुनिए' : 'Listen to this idea')}</strong><span><Volume2 size={13} />{language === 'hi' ? 'हिन्दी' : 'English'} · Line {line + 1} of {card.lines.length}</span></div>
      <button className="icon-button" onClick={replay} aria-label="Replay narration from the beginning"><RotateCcw size={19} /></button>
      <audio ref={audio} preload="metadata" onEnded={() => { if (line < card.lines.length - 1) setLine(line + 1); else { shouldPlay.current = false; setPlaying(false); } }} onError={() => { setError('This audio is unavailable. You can keep reading and try playback again.'); setPlaying(false); shouldPlay.current = false; }} />
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </>;
}

export function LessonView({ config, chapterId, user, onSignIn, onBack }: { config: Config; chapterId: string; user: User | null; onSignIn: () => void; onBack: () => void }) {
  const [language, setLanguage] = useState<Language>('en');
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [index, setIndex] = useState(0);
  const [completed, setCompleted] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [progressOwner, setProgressOwner] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [pendingResume, setPendingResume] = useState<{ id: string | null; language: Language } | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let alive = true;
    if (!user) { setCompleted([]); setSaved(false); setProgressOwner(null); return; }
    void request<Progress>(config, `/progress/${chapterId}`, { authenticated: true }).then((progress) => {
      if (!alive) return;
      setPendingResume({ id: progress.currentCardId, language: progress.language || 'en' });
      setCompleted(progress.completedCardIds || []);
      setLanguage(progress.language || 'en');
      setSaved(Boolean(progress.updatedAt));
    }).catch((issue: Error) => { if (alive) setSaveError(`Saved progress could not be loaded. ${issue.message}`); }).finally(() => { if (alive) setProgressOwner(user.id); });
    return () => { alive = false; };
  }, [user, config, chapterId]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void request<Lesson>(config, `/lessons/${chapterId}?language=${language}`, { signal: controller.signal }).then((data) => {
      if (!data.cards?.length) throw new Error('This lesson has no cards available yet.');
      setLesson(data);
      setIndex((current) => Math.min(current, data.cards.length - 1));
    }).catch((issue: Error) => { if (issue.name !== 'AbortError') setError(issue.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [config, chapterId, language, retry]);

  useEffect(() => {
    if (!lesson || !pendingResume || lesson.language !== pendingResume.language) return;
    if (pendingResume.id) setIndex(Math.max(0, lesson.cards.findIndex((card) => card.id === pendingResume.id)));
    setPendingResume(null);
  }, [lesson, pendingResume]);

  function save(cardId: string, completedIds: string[], selectedLanguage: Language = language) {
    if (!user) return;
    setSaving(true); setSaveError(''); setSaved(false);
    saveQueue.current = saveQueue.current.catch(() => {}).then(async () => {
      try {
        await request<Progress>(config, `/progress/${chapterId}`, { authenticated: true, body: { currentCardId: cardId, completedCardIds: completedIds, language: selectedLanguage } });
        setSaved(true);
      } catch (issue) { setSaveError((issue as Error).message); }
      finally { setSaving(false); }
    });
  }
  function changeLanguage(next: Language) {
    if (next === language) return;
    setLanguage(next);
    if (lesson?.cards[index] && user && progressOwner === user.id) save(lesson.cards[index].id, completed, next);
  }
  function goTo(next: number) {
    if (!lesson) return;
    setIndex(next); save(lesson.cards[next].id, completed);
  }
  function finishCard() {
    if (!lesson) return;
    const nextCompleted = [...new Set([...completed, lesson.cards[index].id])];
    setCompleted(nextCompleted);
    const next = Math.min(index + 1, lesson.cards.length - 1);
    setIndex(next); save(lesson.cards[next].id, nextCompleted);
  }
  const card = lesson?.cards[index];
  const allComplete = Boolean(lesson && lesson.cards.every((item) => completed.includes(item.id)));
  return <main className="lesson-page page-width">
    <button className="text-button back-link" onClick={onBack}><ArrowLeft size={16} />Back to your library</button>
    <div className="lesson-heading"><div><p className="eyebrow">CLASS 4 · EVS · LESSON PREVIEW</p><h1>{lesson?.title || 'Your next discovery'}</h1></div><div className="language-toggle" aria-label="Lesson language"><button onClick={() => changeLanguage('en')} disabled={Boolean(user && progressOwner !== user.id)} aria-pressed={language === 'en'}>English</button><button onClick={() => changeLanguage('hi')} disabled={Boolean(user && progressOwner !== user.id)} aria-pressed={language === 'hi'} lang="hi">हिन्दी</button></div></div>
    <div className="preview-note"><Headphones size={17} /><span>A first look at this chapter. Read a few ideas and listen in either language.</span></div>
    {loading ? <div className="status-panel" role="status">Opening your lesson…</div> : error ? <div className="status-panel"><h2>Let’s try that again.</h2><p role="alert">{error}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>Reload lesson</button></div> : lesson && card && <div className="lesson-layout">
      <aside className="lesson-outline"><p className="eyebrow">YOUR SMALL STEPS</p><ol>{lesson.cards.map((item, itemIndex) => <li key={item.id}><button className={index === itemIndex ? 'active' : ''} aria-current={index === itemIndex ? 'step' : undefined} onClick={() => goTo(itemIndex)}><span className={completed.includes(item.id) ? 'step-number done' : 'step-number'}>{completed.includes(item.id) ? <Check size={15} /> : String(itemIndex + 1).padStart(2, '0')}</span><span>{item.title}</span></button></li>)}</ol><div className="progress-summary"><progress max={lesson.cards.length} value={completed.length} aria-label="Completed lesson cards" /><span>{completed.length} of {lesson.cards.length} ideas explored</span></div>{!user && <div className="save-invitation"><p>Your curiosity deserves a bookmark.</p><button className="text-button" onClick={onSignIn}>Sign in to save your place <ArrowRight size={14} /></button></div>}</aside>
      <section className="reading-card" aria-label="Lesson card"><div className="card-kicker"><span>IDEA {String(index + 1).padStart(2, '0')}</span><span>{String(index + 1).padStart(2, '0')} / {String(lesson.cards.length).padStart(2, '0')}</span></div><h2 lang={language}>{card.title}</h2><Narration key={`${card.id}-${language}`} card={card} language={language} />
        <div className="lesson-actions"><button className="button secondary" onClick={() => goTo(index - 1)} disabled={index === 0}><ArrowLeft size={16} />Previous</button><button className="button primary" onClick={finishCard}>{index === lesson.cards.length - 1 ? 'Finish preview' : 'Got it, next idea'}{index === lesson.cards.length - 1 ? <Check size={17} /> : <ArrowRight size={17} />}</button></div>
        {allComplete && <div className="completion" role="status"><CheckCircle2 size={23} /><div><strong>A little more understood.</strong><p>You’ve explored every idea in this preview. Come back for a listen whenever you like.</p><button className="text-button" onClick={onBack}>Back to library<ArrowRight size={15} /></button></div></div>}
        {user && <div className="save-status" role="status">{saving ? 'Saving your place…' : saveError ? <><span>{saveError}</span><button className="text-button" onClick={() => save(card.id, completed)}>Try saving again</button></> : saved ? <><Check size={14} />Your place is saved</> : 'Your progress saves as you explore.'}</div>}
      </section>
    </div>}
  </main>;
}
