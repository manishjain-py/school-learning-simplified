import { useEffect, useId, useMemo, useState } from 'react';
import { clamp, cueFor, cueProgress, ink, sameOriginAsset, validateScene } from './scene';
import type { SceneDocument, VisualStageProps } from './types';

const sceneCache = new Map<string, SceneDocument>();

export function NarratedScene(props: VisualStageProps) {
  const { visual, language, currentLine, currentTime, clipSha256, hasStarted } = props;
  const [scene, setScene] = useState<SceneDocument | null>(null);
  const [error, setError] = useState('');
  const [imageError, setImageError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const prefix = useId().replace(/:/g, '');
  const url = visual.type === 'scene' ? visual.sceneUrl : '';
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setImageError(false); setScene(null);
    if (!sameOriginAsset(url)) { setError('This visual has an invalid asset address.'); return; }
    const cached = sceneCache.get(url);
    if (cached) { setScene(cached); return; }
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('This visual could not be loaded.');
      return validateScene(await response.json());
    }).then(data => { sceneCache.set(url, data); setScene(data); }).catch((issue: Error) => {
      if (issue.name !== 'AbortError') setError(issue.message);
    });
    return () => controller.abort();
  }, [url, attempt]);

  const intros = useMemo(() => {
    const result = new Map<string, SceneDocument['beats']>();
    for (const beat of scene?.beats || []) {
      if (beat.action === 'emphasize' || beat.treatment === 'guide') continue;
      for (const id of new Set([...(beat.nodes || []), ...(beat.targets || [])])) {
        result.set(id, [...(result.get(id) || []), beat]);
      }
    }
    return result;
  }, [scene]);
  if (error) return <div className="sls-visual-message" role="alert"><p>{error} You can keep reading.</p><button type="button" onClick={() => { sceneCache.delete(url); setAttempt(attempt + 1); }}>Retry visual</button></div>;
  if (!scene) return <div className="sls-visual-message" role="status">{language === 'hi' ? 'चित्र खुल रहा है…' : 'Opening the illustration…'}</div>;
  const started = hasStarted ?? (props.playing || currentLine > 0 || currentTime > 0);
  const mismatched = started && clipSha256 && scene.beats.some(beat => {
    const cue = cueFor(beat, language);
    return cue.line === currentLine && cue.clip_sha256 && cue.clip_sha256 !== clipSha256;
  });
  if (mismatched) return <div className="sls-visual-message" role="alert">This illustration does not match the current recording. Reload the lesson to try again.</div>;
  const progress = (beat: SceneDocument['beats'][number]) => started ? cueProgress(cueFor(beat, language), currentLine, currentTime) : 0;
  const nodeProgress = (id: string) => {
    const beats = intros.get(id);
    return !beats?.length ? 1 : Math.max(...beats.map(progress));
  };
  const activeGuides = scene.beats.filter(beat => {
    const cue = cueFor(beat, language);
    return started && beat.treatment === 'guide' && currentLine === cue.line && currentTime * 1000 >= cue.start_ms && currentTime * 1000 <= cue.end_ms;
  });
  const label = visual.description || visual.title || (language === 'hi' ? 'पाठ के साथ बनता चित्र' : 'An illustration drawn with the narration');
  return <div className="sls-narrated-scene" data-scene-state={started ? 'narrating' : 'ready'}>
    {!started && visual.type === 'scene' && visual.posterUrl && sameOriginAsset(visual.posterUrl) ?
      <img className="sls-scene-poster" src={visual.posterUrl} alt={label} onError={() => setImageError(true)} /> :
      <svg viewBox={`0 0 ${scene.canvas.w} ${scene.canvas.h}`} role="img" aria-label={label} className="sls-scene-canvas">
        <title>{label}</title>
        <desc>{scene.nodes.map(node => node.text).filter(Boolean).join(', ')}</desc>
        <rect width={scene.canvas.w} height={scene.canvas.h} fill="#fbf8f1" />
        <defs>{(scene.assets?.layers || []).map((layer, i) => {
          const beat = scene.beats.find(item => item.id === layer.beat);
          const p = beat ? progress(beat) : 1;
          return <mask id={`${prefix}-reveal-${i}`} key={i} maskUnits="userSpaceOnUse" x="0" y="0" width={scene.canvas.w} height={scene.canvas.h}>
            {p >= 1 ? <rect width={scene.canvas.w} height={scene.canvas.h} fill="white" /> : beat?.route ? <path d={beat.route} fill="none" stroke="white" strokeWidth={beat.brushWidth || 70} strokeLinecap="round" strokeLinejoin="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - p} opacity={p > 0 ? 1 : 0} /> : <rect x={layer.bbox[0]} y={layer.bbox[1]} width={layer.bbox[2] * p} height={layer.bbox[3]} fill="white" />}
          </mask>;
        })}</defs>
        {(scene.assets?.layers || []).map((layer, i) => <image key={`${layer.url}-${attempt}`} href={layer.url} x={layer.bbox[0]} y={layer.bbox[1]} width={layer.bbox[2]} height={layer.bbox[3]} mask={`url(#${prefix}-reveal-${i})`} onError={() => setImageError(true)} />)}
        {scene.nodes.map(node => {
          const p = nodeProgress(node.id);
          return <g key={node.id} data-scene-node={node.id} data-progress={p.toFixed(3)}>
            {(node.fills || []).map((fill, i) => <path key={`f${i}`} d={fill.d} fill={ink(fill.color || node.color)} opacity={(fill.opacity ?? 1) * p} />)}
            {node.strokes.map((stroke, i) => {
              const part = clamp(p * node.strokes.length - i);
              return <path key={i} d={stroke.d} fill="none" stroke={ink(stroke.color || node.color)} strokeWidth={stroke.w || node.w || 3} strokeLinecap="round" strokeLinejoin="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - part} opacity={(stroke.opacity ?? 1) * (part > 0 ? 1 : 0)} />;
            })}
          </g>;
        })}
        {activeGuides.map(beat => <g key={beat.id} className="sls-scene-guide" data-guide={beat.id}>
          {beat.region && <path d={beat.region} fill="#e6b967" fillOpacity=".12" stroke="#ad762b" strokeWidth="6" />}
          {!beat.region && scene.nodes.filter(node => [...(beat.targets || []), ...(beat.nodes || [])].includes(node.id)).flatMap(node => node.strokes.map((stroke, i) => <path key={`${node.id}-${i}`} d={stroke.d} fill="none" stroke="#d4a14b" strokeWidth={(stroke.w || node.w || 3) + 8} opacity=".25" strokeLinecap="round" />))}
        </g>)}
      </svg>}
    <p className="sls-visual-caption">{started ? (language === 'hi' ? 'आवाज़ के साथ चित्र बनता है।' : 'The illustration follows your narration.') : (language === 'hi' ? 'चित्र को बनते देखने के लिए पाठ सुनिए।' : 'Play the narration to see this illustration unfold.')}</p>
    {imageError && <p className="sls-visual-error" role="alert">Part of this illustration could not load. <button type="button" onClick={() => { setImageError(false); setAttempt(attempt + 1); }}>Retry images</button></p>}
  </div>;
}
