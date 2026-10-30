import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareInput, validateGeneration, interpretTeacherLog } from './interpret.js';
import { resolveDatePhrase, schoolLocalDate } from './dates.js';
import { MAX_OUTPUT_TOKENS, MAX_PROMPT_BYTES, type InterpretationInput, type InterpretationResult } from './types.js';
import type { UsageLedger } from './ledger.js';

const input: InterpretationInput = { schoolId: 'school-fixture', classId: 'class-fixture', logId: 'log-fixture', actorId: 'actor-fixture', version: 1, attempt: 1, subject: 'EVS', note: 'Finished Our Earth today. Test tomorrow. Aarav needs more practice.', localDate: '2026-10-27', timeZone: 'Asia/Kolkata', roster: [{ id: 'student-a', name: 'Aarav Sharma' }], catalog: [{ id: 'earth', title: 'Our Earth', subject: 'EVS', modes: ['learn', 'practice', 'revise'] }, { id: 'animals', title: 'Animal Life', subject: 'EVS', modes: ['learn', 'practice', 'revise'] }] };
const modelItem = (overrides: Record<string, unknown> = {}) => ({ chapterId: 'earth', mode: 'revise', kind: 'test', audience: 'class', sourceText: 'Test tomorrow.', datePhrase: 'tomorrow', ...overrides });
const envelope = (...items: unknown[]) => JSON.stringify({ items, unresolved: [] });

test('school-local calendar handles India midnight, leap validity and ambiguous next weekday', () => {
  assert.equal(schoolLocalDate(new Date('2026-10-27T19:00:00Z'), 'Asia/Kolkata'), '2026-10-28');
  assert.deepEqual(resolveDatePhrase('tomorrow', '2026-12-31'), { date: '2027-01-01', policy: 'school-local relative date' });
  assert.equal('issue' in resolveDatePhrase('2026-02-29', '2026-10-27'), true);
  assert.equal('issue' in resolveDatePhrase('next Friday', '2026-10-27'), true);
  assert.equal((resolveDatePhrase('Friday', '2026-10-27') as { date: string }).date, '2026-10-30');
  assert.equal((resolveDatePhrase('on 2026-10-30', '2026-10-27') as { date: string }).date, '2026-10-30');
});
test('prompt omits account identifiers and replaces only uniquely named students', () => {
  const prepared = prepareInput({ ...input, note: `${input.note} Contact teacher@example.test https://example.test.` });
  assert.equal(prepared.prompt.includes('Aarav'), false);
  assert.equal(prepared.prompt.includes('teacher@example.test'), false);
  assert.equal(prepared.prompt.includes(input.actorId), false);
  assert.equal(prepared.prompt.includes('student_001 needs more practice'), true);
  assert.equal(Buffer.byteLength(prepared.prompt) < MAX_PROMPT_BYTES, true);
  const ambiguous = prepareInput({ ...input, roster: [...input.roster, { id: 'student-b', name: 'Aarav Rao' }] });
  assert.equal(ambiguous.note.includes('Aarav needs'), true);
});
test('valid class and child actions use only catalog templates; duplicate actions collapse', () => {
  const prepared = prepareInput(input);
  const result = validateGeneration(envelope(modelItem(), modelItem(), modelItem({ kind: 'support', mode: 'practice', audience: 'student_001', sourceText: 'student_001 needs more practice.', datePhrase: null })), input, prepared);
  assert.equal(result.status, 'ready'); assert.equal(result.guidance.length, 2);
  assert.equal(result.guidance[0].date, '2026-10-28');
  assert.deepEqual(result.guidance[1].audience, { type: 'student', studentId: 'student-a' });
  assert.equal(JSON.stringify(result.guidance).includes('Aarav'), false);
  assert.equal(JSON.stringify(result.guidance).includes('student_001'), false);
});
test('unknown catalog/child, invented evidence and class-wide child text do not publish', () => {
  const prepared = prepareInput(input);
  const result = validateGeneration(envelope(modelItem({ chapterId: 'fractions' }), modelItem({ audience: 'student_099' }), modelItem({ sourceText: 'Made up' }), modelItem({ kind: 'support', audience: 'class', sourceText: 'student_001 needs more practice.', datePhrase: null })), input, prepared);
  assert.equal(result.guidance.length, 0); assert.equal(result.unresolved.length, 4);
  const unmentioned = validateGeneration(envelope(modelItem({ chapterId: 'animals' })), input, prepared);
  assert.equal(unmentioned.guidance.length, 0);
});
test('a wrong model weekday date and truncated date phrase remain unresolved', () => {
  const changed = { ...input, note: 'Animal Life test next Friday.' };
  const prepared = prepareInput(changed);
  for (const datePhrase of ['2026-11-03', 'Friday', 'next Friday']) {
    const result = validateGeneration(envelope(modelItem({ chapterId: 'animals', sourceText: changed.note, datePhrase })), changed, prepared);
    assert.equal(result.guidance.length, 0); assert.equal(result.status, 'unresolved');
  }
});
test('unknown-child tests cannot become class guidance even when the model crops the name', () => {
  const changed = { ...input, note: 'Riya has an Our Earth test tomorrow.' };
  for (const sourceText of [changed.note, 'Our Earth test tomorrow', 'test tomorrow']) {
    const result = validateGeneration(envelope(modelItem({ sourceText })), changed, prepareInput(changed));
    assert.equal(result.guidance.length, 0); assert.equal(result.unresolved[0].code, 'AMBIGUOUS_AUDIENCE');
  }
});
test('ambiguous-name assignments and mixed personal clauses do not broaden to class', () => {
  const changed = { ...input, note: 'Aarav should revise Animal Life tomorrow.', roster: [...input.roster, { id: 'student-b', name: 'Aarav Rao' }] };
  const result = validateGeneration(envelope(modelItem({ chapterId: 'animals', kind: 'assignment', sourceText: changed.note })), changed, prepareInput(changed));
  assert.equal(result.guidance.length, 0); assert.equal(result.unresolved[0].code, 'AMBIGUOUS_AUDIENCE');
  const mixed = { ...input, note: 'The class has an Our Earth test tomorrow and Riya needs support.' };
  assert.equal(validateGeneration(envelope(modelItem({ sourceText: 'The class has an Our Earth test tomorrow' })), mixed, prepareInput(mixed)).guidance.length, 0);
});
test('plain class lessons/tests and explicit class assignments remain valid', () => {
  const changed = { ...input, note: 'Finished Our Earth today. Test tomorrow. All students should revise Our Earth tomorrow.' };
  const result = validateGeneration(envelope(modelItem({ kind: 'lesson', mode: 'learn', sourceText: 'Finished Our Earth today', datePhrase: null }), modelItem(), modelItem({ kind: 'assignment', sourceText: 'All students should revise Our Earth tomorrow.' })), changed, prepareInput(changed));
  assert.equal(result.status, 'ready'); assert.equal(result.guidance.length, 3);
});
test('a two-sentence all-class quote supports its lesson and later test actions', () => {
  const changed = { ...input, note: 'Finished Animal Life today. Test tomorrow.' };
  for (const sourceText of [changed.note, changed.note.slice(0, -1)]) {
    const result = validateGeneration(envelope(
      modelItem({ chapterId: 'animals', kind: 'lesson', mode: 'learn', sourceText, datePhrase: 'today' }),
      modelItem({ chapterId: 'animals', mode: 'revise', sourceText }),
      modelItem({ chapterId: 'animals', mode: 'practice', sourceText }),
    ), changed, prepareInput(changed));
    assert.equal(result.status, 'ready'); assert.equal(result.guidance.length, 3);
    assert.deepEqual(result.guidance.map((item) => [item.mode, item.date]), [['learn', '2026-10-27'], ['revise', '2026-10-28'], ['practice', '2026-10-28']]);
  }
});
test('a safe class sentence cannot authorize a mixed personal evidence span', () => {
  for (const note of [
    'Finished Animal Life today. Riya has a test tomorrow.',
    'Finished Animal Life today. Aarav should revise Animal Life tomorrow.',
    'Finished Animal Life today. Test tomorrow for Riya.',
  ]) {
    const changed = { ...input, note, roster: [...input.roster, { id: 'student-b', name: 'Aarav Rao' }] };
    const result = validateGeneration(envelope(modelItem({ chapterId: 'animals', sourceText: note })), changed, prepareInput(changed));
    assert.equal(result.guidance.length, 0); assert.equal(result.unresolved[0].code, 'AMBIGUOUS_AUDIENCE');
  }
  const knownChild = { ...input, note: 'Finished Animal Life today. Aarav has a test tomorrow.' };
  const prepared = prepareInput(knownChild);
  assert.equal(validateGeneration(envelope(modelItem({ chapterId: 'animals', sourceText: prepared.note })), knownChild, prepared).guidance.length, 0);
  const cropped = { ...input, note: 'Finished Animal Life today. Test tomorrow for Riya.' };
  assert.equal(validateGeneration(envelope(modelItem({ chapterId: 'animals', sourceText: 'Finished Animal Life today. Test tomorrow' })), cropped, prepareInput(cropped)).guidance.length, 0);
});
test('an all-class evidence span still needs a clause matching the proposed kind', () => {
  const changed = { ...input, note: 'Finished Animal Life today. All students should revise Animal Life tomorrow.' };
  const result = validateGeneration(envelope(modelItem({ chapterId: 'animals', sourceText: changed.note })), changed, prepareInput(changed));
  assert.equal(result.guidance.length, 0); assert.equal(result.unresolved[0].code, 'AMBIGUOUS_AUDIENCE');
});
test('kind/mode mismatches are rejected for individual and class actions', () => {
  const prepared = prepareInput(input);
  for (const item of [modelItem({ mode: 'learn' }), modelItem({ kind: 'lesson', mode: 'practice', sourceText: 'Finished Our Earth today', datePhrase: null }), modelItem({ kind: 'support', mode: 'revise', audience: 'student_001', sourceText: 'student_001 needs more practice', datePhrase: null })]) {
    const result = validateGeneration(envelope(item), input, prepared);
    assert.equal(result.guidance.length, 0); assert.equal(result.unresolved[0].code, 'INVALID_ACTION_MODE');
  }
});
test('bounded envelope rejects executable/prose/additional fields and output flooding', () => {
  const prepared = prepareInput(input);
  assert.throws(() => validateGeneration('Here is your JSON ' + envelope(modelItem()), input, prepared));
  assert.throws(() => validateGeneration(JSON.stringify({ items: Array(9).fill(modelItem()), unresolved: [] }), input, prepared));
  const extra = validateGeneration(envelope(modelItem({ reason: 'Student B has a private issue' })), input, prepared);
  assert.equal(extra.guidance.length, 0);
});
test('an explicit date with a copied preposition validates without another model call', () => {
  const changed = { ...input, note: 'Animal Life test on 2026-10-30.' };
  const result = validateGeneration(envelope(modelItem({ chapterId: 'animals', sourceText: 'Animal Life test on 2026-10-30', datePhrase: 'on 2026-10-30' })), changed, prepareInput(changed));
  assert.equal(result.status, 'ready'); assert.equal(result.guidance[0].date, '2026-10-30');
});
test('reservation precedes inference; duplicate and failed reserve cannot call; timeout keeps charge', async () => {
  let calls = 0; let reserved = false; let saved: InterpretationResult | undefined;
  const ledger: UsageLedger = { claim: async () => { if (saved) return { claimed: false, result: saved }; reserved = true; return { claimed: true }; }, complete: async (_value, result) => { saved = result; } };
  const invoke = async () => { assert.equal(reserved, true); calls++; return { generation: envelope(modelItem()), inputTokens: 500, outputTokens: 100, stopReason: 'stop' }; };
  const options = { enabled: true, now: new Date('2026-10-27T12:00:00Z'), ledger, invoke };
  assert.equal((await interpretTeacherLog(input, options)).status, 'ready');
  assert.equal((await interpretTeacherLog(input, options)).status, 'ready'); assert.equal(calls, 1);
  const unavailable = { ...options, ledger: { ...ledger, claim: async () => { throw new Error('storage down'); } } };
  assert.equal((await interpretTeacherLog(input, unavailable)).unresolved[0].code, 'AI_USAGE_UNAVAILABLE'); assert.equal(calls, 1);
  saved = undefined;
  const timeout = await interpretTeacherLog({ ...input, attempt: 2 }, { ...options, invoke: async () => { throw new Error('timeout'); } });
  assert.equal(reserved, true); assert.equal(timeout.unresolved[0].code, 'MODEL_UNAVAILABLE'); assert.equal(timeout.model.usageKnown, false);
});
test('Funding window accepts both former cutoffs and the final millisecond, then closes before reservation', async () => {
  const events: string[] = [];
  const ledger: UsageLedger = {
    claim: async ({ now }) => { events.push(`reserve:${now.toISOString()}`); return { claimed: true }; },
    complete: async () => { events.push('complete'); },
  };
  const invoke = async () => { events.push('invoke'); return { generation: envelope(modelItem()), inputTokens: 500, outputTokens: 100, stopReason: 'stop' }; };
  for (const timestamp of ['2026-11-09T18:30:00.000Z', '2026-11-11T18:30:00.000Z', '2026-11-20T18:29:59.999Z']) {
    const now = new Date(timestamp);
    const result = await interpretTeacherLog({ ...input, localDate: schoolLocalDate(now, input.timeZone) }, { enabled: true, now, ledger, invoke });
    assert.equal(result.status, 'ready', timestamp);
  }
  assert.deepEqual(events, [
    'reserve:2026-11-09T18:30:00.000Z', 'invoke', 'complete',
    'reserve:2026-11-11T18:30:00.000Z', 'invoke', 'complete',
    'reserve:2026-11-20T18:29:59.999Z', 'invoke', 'complete',
  ]);
  const completedEvents = [...events];
  for (const timestamp of ['2026-11-20T18:30:00.000Z', '2026-11-21T00:00:00.000Z']) {
    const result = await interpretTeacherLog(input, { enabled: true, now: new Date(timestamp), ledger, invoke });
    assert.equal(result.status, 'failed', timestamp);
    assert.equal(result.unresolved[0].code, 'AI_BUDGET_WINDOW', timestamp);
    assert.equal(result.retryable, false, timestamp);
  }
  assert.deepEqual(events, completedEvents, 'Closed-window requests must not reserve usage or invoke the model.');
});
test('disabled, funding-window, attempt, input bounds and truncated response fail closed', async () => {
  let calls = 0;
  const invoke = async () => { calls++; return { generation: '{}', inputTokens: 100, outputTokens: MAX_OUTPUT_TOKENS, stopReason: 'length' }; };
  const ledger: UsageLedger = { claim: async () => ({ claimed: true }), complete: async () => {} };
  const options = { enabled: true, ledger, invoke, now: new Date('2026-10-27T12:00:00Z') };
  assert.equal((await interpretTeacherLog(input, { ...options, enabled: false })).unresolved[0].code, 'AI_NOT_ENABLED');
  assert.equal((await interpretTeacherLog(input, { ...options, now: new Date('2026-11-20T18:30:00Z') })).unresolved[0].code, 'AI_BUDGET_WINDOW');
  assert.equal((await interpretTeacherLog({ ...input, attempt: 4 }, options)).unresolved[0].code, 'INVALID_AI_INPUT');
  assert.equal((await interpretTeacherLog({ ...input, note: 'x'.repeat(3001) }, options)).unresolved[0].code, 'INVALID_AI_INPUT');
  assert.equal(calls, 0);
  assert.equal((await interpretTeacherLog(input, options)).unresolved[0].code, 'MODEL_TRUNCATED'); assert.equal(calls, 1);
});
