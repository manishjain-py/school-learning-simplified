import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Pause, Play, RotateCcw, Square, Volume2 } from 'lucide-react';
import type { Language, NarratedLine } from './types';
import { Text } from './learningShared';

export type NarrationClock = { currentLine: number; currentTime: number; playing: boolean; replayKey: number; clipSha256?: string; hasStarted: boolean; ended: boolean };
export function Narration({ lines, language, showText = true, autoPlay = false, waitForVisual = false, mediaRef, controlMode = 'full', renderControls, children }: { lines: NarratedLine[]; language: Language; showText?: boolean; autoPlay?: boolean; waitForVisual?: boolean; mediaRef?: RefObject<HTMLAudioElement | null>; controlMode?: 'full' | 'play-stop'; renderControls?: (control: ReactNode) => ReactNode; children?: (clock: NarrationClock, onVisualReady: () => void) => ReactNode }) {
  const ownAudio = useRef<HTMLAudioElement>(null);
  const audio = mediaRef || ownAudio;
  const [line, setLine] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(autoPlay);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [visualReady, setVisualReady] = useState(!waitForVisual);
  const onVisualReady = useCallback(() => setVisualReady(true), []);
  const [replayKey, setReplayKey] = useState(0);
  const [error, setError] = useState('');
  const shouldPlay = useRef(autoPlay);
  const playGeneration = useRef(0);
  const source = lines[line];
  const clipSha256 = source?.audioSha256 || source?.audioUrl.match(/([a-f0-9]{64})\.mp3/)?.[1];
  async function start() {
    const element = audio.current;
    if (!element || !source) return;
    shouldPlay.current = true; setStarting(true); setEnded(false); setNeedsGesture(false); setError('');
    if (!visualReady) return;
    window.dispatchEvent(new CustomEvent('sls:narration-start', { detail: element }));
    const generation = ++playGeneration.current;
    try {
      await element.play();
      if (generation !== playGeneration.current || !shouldPlay.current) return;
      setStarted(true); setStarting(false); setPlaying(true);
    } catch (issue) {
      if (generation !== playGeneration.current || !shouldPlay.current) return;
      shouldPlay.current = false; setStarting(false); setPlaying(false);
      if ((issue as Error).name === 'NotAllowedError') setNeedsGesture(true);
      else setError('Audio could not play. Please try again.');
    }
  }
  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    const metadata = () => setDuration(element.duration || 0);
    const seeked = () => setTime(element.currentTime || 0);
    const ended = () => {
      if (!shouldPlay.current || !element.ended) return;
      setPlaying(false);
      if (line < lines.length - 1) { setStarting(true); setLine(line + 1); setTime(0); }
      else { playGeneration.current++; shouldPlay.current = false; setStarting(false); setEnded(true); }
    };
    const failed = () => { if (!element.error || (controlMode === 'play-stop' && !shouldPlay.current)) return; playGeneration.current++; setError('This audio is unavailable. You can keep reading and try playback again.'); setStarting(false); setPlaying(false); shouldPlay.current = false; };
    element.addEventListener('loadedmetadata', metadata); element.addEventListener('seeked', seeked);
    element.addEventListener('ended', ended); element.addEventListener('error', failed);
    return () => {
      element.removeEventListener('loadedmetadata', metadata); element.removeEventListener('seeked', seeked);
      element.removeEventListener('ended', ended); element.removeEventListener('error', failed);
    };
  }, [audio, line, lines.length, controlMode]);
  useEffect(() => {
    const element = audio.current;
    if (!element || !source) return;
    playGeneration.current++; element.pause();
    element.src = source.audioUrl; setTime(0); setDuration(0); setPlaying(false);
    if (shouldPlay.current) void start();
  }, [line, source?.audioUrl, visualReady]);
  useEffect(() => {
    const element = audio.current;
    const pauseOther = (event: Event) => { if ((event as CustomEvent).detail !== element) { playGeneration.current++; shouldPlay.current = false; element?.pause(); setStarting(false); setPlaying(false); } };
    window.addEventListener('sls:narration-start', pauseOther);
    return () => { window.removeEventListener('sls:narration-start', pauseOther); playGeneration.current++; shouldPlay.current = false; element?.pause(); };
  }, [audio]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => { setTime(audio.current?.currentTime || 0); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [playing, audio]);
  function toggle() { if (shouldPlay.current) { playGeneration.current++; shouldPlay.current = false; audio.current?.pause(); setStarting(false); setPlaying(false); } else void start(); }
  function replay() {
    playGeneration.current++; audio.current?.pause();
    setReplayKey((value) => value + 1); setEnded(false); setStarted(false); setStarting(true); setPlaying(false); setError(''); setNeedsGesture(false); shouldPlay.current = true;
    setTime(0);
    if (line !== 0) setLine(0); else { if (audio.current) audio.current.currentTime = 0; void start(); }
  }
  function stop() {
    playGeneration.current++; shouldPlay.current = false;
    audio.current?.pause();
    setStarting(false); setPlaying(false); setStarted(true); setEnded(true); setNeedsGesture(false);
  }
  function playOrStop() { if (shouldPlay.current) stop(); else replay(); }
  if (!source) return null;
  const clock = { currentLine: line, currentTime: time, playing, replayKey, clipSha256, hasStarted: started, ended };
  const active = playing || starting;
  const compactLabel = active ? 'Stop narration' : needsGesture ? 'Enable lesson audio' : 'Play narration from the beginning';
  const compactControl = <button type="button" className="lesson-play-stop" aria-label={compactLabel} title={compactLabel} onClick={playOrStop}>{active ? <Square size={17} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>;
  const label = needsGesture ? 'Enable lesson audio' : active ? 'Pause narration' : 'Play narration';
  const title = needsGesture ? (language === 'hi' ? 'आवाज़ शुरू करने के लिए टैप करें' : 'Tap to enable audio') : starting ? (language === 'hi' ? 'पाठ तैयार हो रहा है…' : 'Getting narration ready…') : playing ? (language === 'hi' ? 'सुनते रहिए…' : 'Listen and discover') : (language === 'hi' ? 'पाठ सुनिए' : 'Listen to this idea');
  return <>
    {children?.(clock, onVisualReady)}
    {showText && <div className="lesson-copy" lang={language}>{lines.map((item, index) => <p key={index} className={line === index && playing ? 'spoken-line' : ''}><Text>{item.display}</Text></p>)}</div>}
    {controlMode === 'play-stop' ? (renderControls ? renderControls(compactControl) : compactControl) : <div className="audio-player"><button className="audio-play" onClick={toggle} aria-label={label}>{active ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}</button><div className="audio-info"><strong>{title}</strong><span><Volume2 size={13} />{language === 'hi' ? 'हिन्दी' : 'English'} · Line {line + 1} of {lines.length}</span><input aria-label="Narration position" type="range" min={0} max={duration || 1} step={0.05} value={Math.min(time, duration || 1)} disabled={!duration || (autoPlay && !started)} onChange={(event) => { const value = Number(event.target.value); if (audio.current) audio.current.currentTime = value; setTime(value); setStarted(true); }} /></div><button className="icon-button" onClick={replay} aria-label="Replay narration from the beginning"><RotateCcw size={19} /></button></div>}
    {!mediaRef && <audio ref={ownAudio} preload="metadata" />}
    {error && <p className="form-error" role="alert">{error}</p>}
  </>;
}
