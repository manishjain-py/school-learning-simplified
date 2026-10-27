import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import type { Language, NarratedLine } from './types';
import { Text } from './learningShared';

export type NarrationClock = { currentLine: number; currentTime: number; playing: boolean; replayKey: number; clipSha256?: string; hasStarted: boolean };
export function Narration({ lines, language, showText = true, children }: { lines: NarratedLine[]; language: Language; showText?: boolean; children?: (clock: NarrationClock) => ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [line, setLine] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [replayKey, setReplayKey] = useState(0);
  const [error, setError] = useState('');
  const shouldPlay = useRef(false);
  const source = lines[line];
  const clipSha256 = source?.audioSha256 || source?.audioUrl.match(/([a-f0-9]{64})\.mp3/)?.[1];
  async function start() {
    window.dispatchEvent(new CustomEvent('sls:narration-start', { detail: audio.current }));
    shouldPlay.current = true; setStarted(true); setError('');
    try { await audio.current?.play(); setPlaying(true); }
    catch { shouldPlay.current = false; setPlaying(false); setError('Audio could not play. Please try again.'); }
  }
  useEffect(() => {
    const element = audio.current;
    if (!element || !source) return;
    element.src = source.audioUrl; setTime(0); setDuration(0);
    if (shouldPlay.current) void start();
  }, [line, source?.audioUrl]);
  useEffect(() => {
    const element = audio.current;
    const pauseOther = (event: Event) => { if ((event as CustomEvent).detail !== element) { shouldPlay.current = false; element?.pause(); setPlaying(false); } };
    window.addEventListener('sls:narration-start', pauseOther);
    return () => { window.removeEventListener('sls:narration-start', pauseOther); shouldPlay.current = false; element?.pause(); };
  }, []);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => { setTime(audio.current?.currentTime || 0); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [playing]);
  function toggle() { if (playing) { shouldPlay.current = false; audio.current?.pause(); setPlaying(false); } else void start(); }
  function replay() {
    setReplayKey((value) => value + 1); setStarted(true); setError(''); shouldPlay.current = true;
    setTime(0);
    if (line !== 0) setLine(0); else { if (audio.current) audio.current.currentTime = 0; void start(); }
  }
  if (!source) return null;
  const clock = { currentLine: line, currentTime: time, playing, replayKey, clipSha256, hasStarted: started };
  return <>
    {children?.(clock)}
    {showText && <div className="lesson-copy" lang={language}>{lines.map((item, index) => <p key={index} className={line === index && playing ? 'spoken-line' : ''}><Text>{item.display}</Text></p>)}</div>}
    <div className="audio-player"><button className="audio-play" onClick={toggle} aria-label={playing ? 'Pause narration' : 'Play narration'}>{playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><div className="audio-info"><strong>{playing ? (language === 'hi' ? 'सुनते रहिए…' : 'Listen and discover') : (language === 'hi' ? 'पाठ सुनिए' : 'Listen to this idea')}</strong><span><Volume2 size={13} />{language === 'hi' ? 'हिन्दी' : 'English'} · Line {line + 1} of {lines.length}</span><input aria-label="Narration position" type="range" min={0} max={duration || 1} step={0.05} value={Math.min(time, duration || 1)} disabled={!duration} onChange={(event) => { const value = Number(event.target.value); if (audio.current) audio.current.currentTime = value; setTime(value); setStarted(true); }} /></div><button className="icon-button" onClick={replay} aria-label="Replay narration from the beginning"><RotateCcw size={19} /></button><audio ref={audio} preload="metadata" onLoadedMetadata={() => setDuration(audio.current?.duration || 0)} onSeeked={() => setTime(audio.current?.currentTime || 0)} onEnded={() => { if (line < lines.length - 1) { setLine(line + 1); setTime(0); } else { shouldPlay.current = false; setPlaying(false); } }} onError={() => { setError('This audio is unavailable. You can keep reading and try playback again.'); setPlaying(false); shouldPlay.current = false; }} /></div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </>;
}
