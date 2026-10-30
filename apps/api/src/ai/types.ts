export type LearningMode = 'learn' | 'practice' | 'revise';
export type GuidanceKind = 'lesson' | 'assignment' | 'test' | 'support';
export type CatalogEntry = { id: string; title: string; subject: string; modes: LearningMode[]; topics?: string[] };
/** Supply canonical server records after current class authorization, never request-body roster/catalog data. */
export type InterpretationInput = {
  schoolId: string; classId: string; logId: string; actorId: string; version: number; attempt: number;
  subject: string; note: string; localDate: string; timeZone: string;
  roster: { id: string; name: string }[]; catalog: CatalogEntry[];
};
export type GuidanceCandidate = {
  id: string; chapterId: string; mode: LearningMode; kind: GuidanceKind;
  audience: { type: 'class' } | { type: 'student'; studentId: string };
  date: string | null; datePhrase: string | null; title: string; reason: string;
};
export type InterpretationIssue = { code: string; message: string; sourceText?: string };
export type InterpretationResult = {
  requestKey: string; status: 'processing' | 'ready' | 'unresolved' | 'failed';
  guidance: GuidanceCandidate[]; unresolved: InterpretationIssue[]; retryable: boolean;
  model: { id: string; region: string; inputTokens: number; outputTokens: number; usageKnown: boolean };
};
export const MODEL_ID = 'meta.llama3-3-70b-instruct-v1:0';
export const MODEL_REGION = 'us-east-2';
export const MAX_PROMPT_BYTES = 16_000;
export const MAX_OUTPUT_TOKENS = 1_024;
export const MAX_ATTEMPTS = 3;
export const BUDGET_END = '2026-11-20T18:30:00.000Z'; // Midnight starting 21 Nov IST; cumulative allowance is unchanged.
export const BUDGET_START = '2026-10-26T18:30:00.000Z';
export const RESERVE_MICRO_USD = 20_000;
export const PROJECT_LIMIT_MICRO_USD = 18_000_000;
export const ACTOR_DAILY_LIMIT = 25;
export function emptyResult(requestKey: string, status: InterpretationResult['status'], code: string, message: string, retryable = false): InterpretationResult {
  return { requestKey, status, guidance: [], unresolved: [{ code, message }], retryable,
    model: { id: MODEL_ID, region: MODEL_REGION, inputTokens: 0, outputTokens: 0, usageKnown: false } };
}
