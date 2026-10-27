export type VisualLanguage = 'en' | 'hi';

export type VisualDescriptor = {
  title?: string;
  description?: string;
} & (
  | { type: 'scene'; sceneUrl: string; posterUrl?: string }
  | { type: 'replacement'; sourceCardId: string; stage?: number; stages?: number; interactive?: unknown }
  | { type: 'image'; imageUrl: string }
);

/** Times are local to the active narration clip; line numbers are zero-based. */
export type VisualStageProps = {
  visual: VisualDescriptor;
  language: VisualLanguage;
  currentLine: number;
  currentTime: number;
  playing: boolean;
  replayKey: number;
  clipSha256?: string;
  hasStarted?: boolean;
};

export type SceneCue = { line: number; start_ms: number; end_ms: number; clip_sha256?: string; emphasis?: { start_ms: number; end_ms: number } | null };
export type SceneBeat = {
  id: string;
  line?: number;
  cue: SceneCue;
  cues?: Partial<Record<VisualLanguage, SceneCue>>;
  treatment: 'draw' | 'reveal' | 'guide';
  action?: 'introduce' | 'emphasize';
  nodes?: string[];
  targets?: string[];
  region?: string;
  route?: string;
  brushWidth?: number;
};
export type SceneNode = {
  id: string;
  text?: string;
  color?: string;
  w?: number;
  strokes: { d: string; w?: number; color?: string; opacity?: number }[];
  fills?: { d: string; color?: string; opacity?: number }[];
};
export type SceneDocument = {
  schema_version: number;
  canvas: { w: number; h: number };
  nodes: SceneNode[];
  beats: SceneBeat[];
  assets?: { base?: { url: string } | null; layers?: { url: string; bbox: number[]; beat: string; sha256?: string }[] };
};
