import type { SceneBeat, SceneCue, SceneDocument, VisualLanguage } from './types';

export const inkColors: Record<string, string> = {
  ink: '#283c35', amber: '#ad762b', blue: '#3377a1', brown: '#876344',
  coral: '#c46b52', muted: '#7c8a80', yellow: '#d4aa42', green: '#4b8562',
  red: '#bb4e43', sky: '#6aacc2', purple: '#80669d', leaf: '#6d9255',
};
export function ink(value?: string): string {
  return inkColors[value || 'ink'] || (/^#[a-f\d]{3,8}$/i.test(value || '') ? value! : inkColors.ink);
}
export const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
export function cueFor(beat: SceneBeat, language: VisualLanguage): SceneCue {
  return beat.cues?.[language] || beat.cue;
}
export function cueProgress(cue: SceneCue, line: number, seconds: number): number {
  if (line < cue.line) return 0;
  if (line > cue.line) return 1;
  return clamp((seconds * 1000 - cue.start_ms) / Math.max(1, cue.end_ms - cue.start_ms));
}
export function sameOriginAsset(value: string): boolean {
  return /^\/(?:content|media)\//.test(value) && !value.includes('\\') && !value.includes('..');
}

/** The file is prepared data, never HTML, script, an iframe or executable code. */
export function validateScene(value: unknown): SceneDocument {
  const scene = value as SceneDocument;
  if (!scene || scene.schema_version !== 2 || !scene.canvas ||
      !Number.isFinite(scene.canvas.w) || !Number.isFinite(scene.canvas.h) ||
      scene.canvas.w <= 0 || scene.canvas.h <= 0 ||
      !Array.isArray(scene.nodes) || !Array.isArray(scene.beats)) throw new Error('This visual format is not supported.');
  if (scene.nodes.some(node => !node.id || !Array.isArray(node.strokes) || node.strokes.some(stroke => typeof stroke.d !== 'string')) ||
      scene.beats.some(beat => !beat.id || !beat.cue || !['draw', 'reveal', 'guide'].includes(beat.treatment))) throw new Error('This visual data is incomplete.');
  for (const layer of scene.assets?.layers || []) {
    if (!sameOriginAsset(layer.url) || !Array.isArray(layer.bbox) || layer.bbox.length !== 4 || layer.bbox.some(n => !Number.isFinite(n))) throw new Error('This visual contains an unavailable image reference.');
  }
  return scene;
}
