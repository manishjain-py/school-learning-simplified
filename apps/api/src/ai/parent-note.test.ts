import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoUsageLedger, type Reservation, type UsageLedger } from './ledger.js';
import { draftParentNote, prepareParentNote, validateParentNote, parentNoteValidationMessages, type ParentNoteInput, type ParentNoteResult, type ParentNoteValidationCode } from './parent-note.js';
import { BUDGET_END, BUDGET_START, MAX_PROMPT_BYTES, MODEL_ID, MODEL_REGION, PROJECT_LIMIT_MICRO_USD } from './types.js';

const root = resolve(import.meta.dirname, '../../../..');
const chapterId = '7818d587-2954-43fc-95f0-5f0576b12f66';
const cardId = '4c0f6523-dc0f-458d-948e-58ea678f79ec';
const now = new Date('2026-10-29T08:00:00.000Z');
const catalog = JSON.parse(readFileSync(resolve(root, 'content/releases/m2/catalog.json'), 'utf8'));
const lesson = (language: 'en' | 'hi') => JSON.parse(readFileSync(resolve(root, `content/releases/m2/lessons/${chapterId}/${language}.json`), 'utf8'));
const input: ParentNoteInput = {
  schoolId: 'school-fixture', classId: 'class-fixture', draftId: 'draft-fixture', actorId: 'actor-fixture', attempt: 1,
  student: { id: 'child-a', name: 'Anika Rao' }, roster: [{ id: 'child-a', name: 'Anika Rao' }, { id: 'child-b', name: 'Kabir Joshi' }],
  observation: 'Anika mixed up day and night.', language: 'en', chapter: catalog.chapters.find((chapter: { id: string }) => chapter.id === chapterId), cards: lesson('en').cards, cardId,
};
const english = 'Your child mixed up day and night, so a little practice with the orange model may help. Together, hold an orange near a lamp and notice the bright side facing the light and the dark side facing away. Turn it gently to see how the sides change. If you use a needle for the model, an adult should help. Open the linked lesson activity and talk through what you notice together.';
const hindi = 'आपके बच्चे को दिन और रात में थोड़ा भ्रम हुआ है। साथ बैठकर संतरे और लैम्प वाला अभ्यास करें। संतरे को रोशनी के सामने रखें और देखें कि कौन-सा हिस्सा उजला है और कौन-सा अँधेरा। उसे धीरे से घुमाकर बदलाव देखें। अगर मॉडल में सलाई का इस्तेमाल करें, तो किसी बड़े की मदद लें। फिर साथ में जुड़ी हुई सीखने की गतिविधि खोलें और बच्चे से अपनी देखी हुई बात बताने को कहें।';
// Reproduces the two observed failure forms without private observation/account data.
const ungroundedHindi = 'आपका बच्चा दिन और रात के बारे में जानने के लिए उत्साहित है। घर पर संतरे का model बनाकर rotation देखें। एक संतरे में सलाई घुसाकर और उसे धीरे-धीरे घुमाकर दिन और रात का अनुभव कराएं। कृपया दिए गए लिंक पर क्लिक करके इस गतिविधि को देखें।';
const generation = (text = english, sourceCards = ['source_001', 'source_003', 'source_004']) => JSON.stringify({ text, sourceCards });
const model = (text = english) => async () => ({ generation: generation(text), inputTokens: 500, outputTokens: 120, stopReason: 'stop' });
const empty = (requestKey: string, status: 'processing' | 'failed', code: string, message: string, retryable = false): ParentNoteResult => ({ requestKey, status, code, message, retryable, language: 'en', model: { id: MODEL_ID, region: MODEL_REGION, inputTokens: 0, outputTokens: 0, usageKnown: false } });
function memoryLedger() {
  const results = new Map<string, ParentNoteResult>(); const claimed = new Set<string>(); const steps: string[] = [];
  const ledger: UsageLedger<ParentNoteResult> = {
    async claim(value) { steps.push('claim'); if (results.has(value.requestKey)) return { claimed: false, result: results.get(value.requestKey)! }; if (claimed.has(value.requestKey)) return { claimed: false, result: empty(value.requestKey, 'processing', 'IN_PROGRESS', 'Processing') }; claimed.add(value.requestKey); return { claimed: true }; },
    async complete(value, result) { steps.push('complete'); results.set(value.requestKey, result); },
  };
  return { ledger, results, claimed, steps };
}

test('canonical lamp/orange grounding includes adult help in both languages and no private IDs/names', () => {
  for (const language of ['en', 'hi'] as const) {
    const prepared = prepareParentNote({ ...input, language, cards: lesson(language).cards });
    assert.equal(prepared.sourceAliases.length, 5); assert.equal(prepared.selectedAlias, 'source_003');
    assert(prepared.prompt.includes(language === 'en' ? "With an adult's help" : 'किसी बड़े की मदद से'));
    assert(prepared.prompt.includes(language === 'en' ? 'The lamp is our Sun.' : 'यह lamp हमारा Sun है।'));
    assert.equal(prepared.sourceUsesNeedle, true); assert.equal(prepared.adultHelpSources.length, 1);
    assert.equal(prepared.adultHelpSources[0].alias, 'source_001');
    assert(prepared.adultHelpSources[0].instruction.includes(language === 'en' ? "With an adult's help" : 'किसी बड़े की मदद से'));
    assert(prepared.prompt.includes('do not replace it with praise'));
    for (const privateValue of [input.schoolId, input.classId, input.actorId, input.draftId, input.student.id, input.chapter.id, cardId, 'Anika', 'Rao', 'Kabir', 'Joshi']) assert(!prepared.prompt.includes(privateValue), privateValue);
    assert.equal(prepared.activity.cardId, cardId); assert.equal(prepared.activity.chapterId, chapterId);
    assert(Buffer.byteLength(prepared.prompt, 'utf8') < MAX_PROMPT_BYTES);
    assert(!prepared.prompt.includes('grading')); assert(!prepared.prompt.includes('audioUrl'));
  }
});
test('target names are aliased once; contacts, forged aliases and identifier-shaped values are removed', () => {
  const prepared = prepareParentNote({ ...input, observation: `Anika Rao and Anika mixed up day and night. Email parent@example.test; https://school.example.test; call +91 9876543210. ${input.actorId} ${cardId} student_999` });
  assert.equal(prepared.observation.match(/student_001/g)?.length, 2);
  for (const value of ['Anika', 'parent@example.test', 'https://', '9876543210', input.actorId, cardId, 'student_999']) assert(!prepared.prompt.includes(value), value);
  const devanagari = { ...input, student: { id: 'child-a', name: 'अनिका राव' }, roster: [{ id: 'child-a', name: 'अनिका राव' }], observation: 'अनिका को दिन और रात में भ्रम हुआ।' };
  assert(prepareParentNote(devanagari).observation.startsWith('student_001'));
  const initial = { ...input, student: { id: 'child-a', name: 'A Rao' }, roster: [{ id: 'child-a', name: 'A Rao' }], observation: 'A mixed up day and night.' };
  assert(prepareParentNote(initial).observation.startsWith('student_001'));
  assert(prepareParentNote({ ...input, observation: 'A\u200bnika mixed up day and night.' }).observation.startsWith('student_001'));
});
test('other roster children and ambiguous first names are rejected before any reservation', async () => {
  for (const observation of ['Kabir needs help too.', 'Kabir Joshi mixed up day and night.']) assert.throws(() => prepareParentNote({ ...input, observation }), /only the selected child/);
  const ambiguous = { ...input, roster: [...input.roster, { id: 'child-c', name: 'Anika Shah' }] };
  assert.throws(() => prepareParentNote(ambiguous), /only the selected child/);
  assert(prepareParentNote({ ...ambiguous, observation: 'Anika Rao mixed up day and night.' }).observation.startsWith('student_001'));
  const memory = memoryLedger(); let calls = 0;
  const result = await draftParentNote({ ...input, observation: 'Kabir needs help.' }, { ledger: memory.ledger, enabled: true, now, invoke: async () => { calls++; return model()(); } });
  assert.equal(result.code, 'INVALID_DRAFT_INPUT'); assert.equal(calls, 0); assert.equal(memory.claimed.size, 0);
});
test('grounding rejects quick checks/unknown cards and never crosses topic or trims oversized source', () => {
  assert.throws(() => prepareParentNote({ ...input, cardId: 'missing' }), /narrated lesson idea/);
  assert.throws(() => prepareParentNote({ ...input, cardId: input.cards.find(card => card.kind === 'check_in')!.id }), /narrated lesson idea/);
  const custom: ParentNoteInput['cards'] = [
    { id: 'other-topic', title: 'Outside topic', kind: 'concept', partId: 'other', lines: [{ display: 'Do not include this other topic.' }] },
    { id: 'check-card', title: 'Question', kind: 'check_in', partId: 'topic', lines: [{ display: 'Do not include this check.' }] },
    { id: 'target-card', title: 'Target', kind: 'concept', partId: 'topic', lines: [{ display: 'A safe source statement.' }] },
  ];
  const prepared = prepareParentNote({ ...input, cards: custom, cardId: 'target-card' });
  assert.equal(prepared.sourceAliases.length, 1); assert(!prepared.prompt.includes('Do not include'));
  assert.throws(() => prepareParentNote({ ...input, cards: [{ ...custom[2], lines: Array.from({ length: 20 }, () => ({ display: 'आ'.repeat(800) })) }], cardId: 'target-card' }), /too long for a bounded draft/);
});
test('structured English/Hindi draft validates only allowlisted references and returns canonical activity', async () => {
  for (const language of ['en', 'hi'] as const) {
    const value = { ...input, language, cards: lesson(language).cards }; const memory = memoryLedger();
    const result = await draftParentNote(value, { ledger: memory.ledger, enabled: true, now, invoke: async () => { memory.steps.push('invoke'); return model(language === 'hi' ? hindi : english)(); } });
    assert.equal(result.status, 'ready'); assert.equal(result.language, language); assert.equal(result.activity?.cardId, cardId); assert.equal(result.retryable, false);
    assert.deepEqual(memory.steps, ['claim', 'invoke', 'complete']); assert.equal(result.model.inputTokens, 500);
    assert.equal(validateParentNote('```json\n' + generation(language === 'hi' ? hindi : english) + '\n```', prepareParentNote(value)), language === 'hi' ? hindi : english);
  }
});
test('unknown fields/sources, names, aliases, links and diagnostic framing never return an editable draft', () => {
  const prepared = prepareParentNote(input);
  for (const text of [english.replace('Your child', 'Anika'), english.replace('Your child', 'Kabir'), `${english} https://example.test`, `${english} ftp://example.test`, `${english} lessons.example.xyz`, `${english} /learn/${chapterId}`, `${english} student_001`, `${english} source_003`, `${english} parent@example.test`, `${english} Your child has ADHD.`, `${english} Your child is better than classmates.`, `${english} ${input.actorId}`]) assert.throws(() => validateParentNote(generation(text), prepared));
  assert.throws(() => validateParentNote(generation(english, ['source_999']), prepared));
  assert.throws(() => validateParentNote(generation(english, ['source_001']), prepared));
  assert.throws(() => validateParentNote(JSON.stringify({ text: english, sourceCards: ['source_003'], href: '/learn/x' }), prepared));
  assert.throws(() => validateParentNote(generation(english), prepareParentNote({ ...input, language: 'hi' })), /Devanagari/);
  assert.throws(() => validateParentNote(generation('Too short.'), prepared), /bounded note length/);
});
test('observed Hindi failure and its independent praise/supervision defects are rejected', () => {
  const prepared = prepareParentNote({ ...input, language: 'hi', cards: lesson('hi').cards });
  assert.throws(() => validateParentNote(generation(ungroundedHindi), prepared), { code: 'MODEL_OBSERVATION' });
  const correctedObservation = ungroundedHindi.replace('आपका बच्चा दिन और रात के बारे में जानने के लिए उत्साहित है।', 'आपके बच्चे को दिन और रात में भ्रम हुआ है।');
  assert.throws(() => validateParentNote(generation(correctedObservation), prepared), { code: 'MODEL_SAFETY' });
  const correctedSafety = `${ungroundedHindi} सलाई का उपयोग किसी बड़े की मदद से करें।`;
  assert.throws(() => validateParentNote(generation(correctedSafety), prepared), { code: 'MODEL_OBSERVATION' });
  const corrected = `${correctedObservation} सलाई का उपयोग किसी बड़े की मदद से करें।`;
  assert.equal(validateParentNote(generation(corrected), prepared), corrected);
});
test('needle instructions retain affirmative canonical adult help and its source in both languages', () => {
  for (const language of ['en', 'hi'] as const) {
    const prepared = prepareParentNote({ ...input, language, cards: lesson(language).cards });
    const original = language === 'en' ? english : hindi;
    const positive = language === 'en' ? 'an adult should help' : 'किसी बड़े की मदद लें';
    const replacements = language === 'en'
      ? ['no adult help is needed', 'adult help is optional', 'you can do it alone', 'you can work without an adult’s help']
      : ['किसी बड़े की मदद नहीं लें', 'किसी बड़े की मदद वैकल्पिक है', 'इसे अपने आप करें', 'किसी बड़े की मदद के बिना करें'];
    for (const replacement of replacements) assert.throws(() => validateParentNote(generation(original.replace(positive, replacement)), prepared), { code: 'MODEL_SAFETY' });
    const contradiction = `${original} ${language === 'en' ? 'Adult help is not needed.' : 'किसी बड़े की मदद की जरूरत नहीं है।'}`;
    assert.throws(() => validateParentNote(generation(contradiction), prepared), { code: 'MODEL_SAFETY' });
    assert.throws(() => validateParentNote(generation(original, ['source_003', 'source_004']), prepared), { code: 'MODEL_SOURCE' });
    assert.equal(validateParentNote(generation(original), prepared), original);
  }
});
test('enthusiasm must be honestly observed; warm invitations are not child-trait claims', () => {
  const enthusiasticEnglish = english.replace('Your child mixed up day and night, so a little practice with the orange model may help.', 'Your child was enthusiastic about the day and night activity.');
  const enthusiasticHindi = hindi.replace('आपके बच्चे को दिन और रात में थोड़ा भ्रम हुआ है।', 'आपका बच्चा दिन और रात की गतिविधि के लिए उत्साहित है।');
  for (const language of ['en', 'hi'] as const) {
    const text = language === 'en' ? enthusiasticEnglish : enthusiasticHindi;
    for (const observation of ['Anika was enthusiastic about day and night.', 'Anika दिन और रात की गतिविधि के लिए उत्साहित थी।']) {
      const prepared = prepareParentNote({ ...input, language, observation, cards: lesson(language).cards });
      assert.equal(validateParentNote(generation(text), prepared), text);
    }
    for (const observation of ['Anika mixed up day and night.', 'Anika was not enthusiastic about day and night.', 'Anika उत्साहित नहीं थी।']) {
      const prepared = prepareParentNote({ ...input, language, observation, cards: lesson(language).cards });
      assert.throws(() => validateParentNote(generation(text), prepared), { code: 'MODEL_OBSERVATION' });
    }
  }
  const invitation = english.replace('Your child mixed up day and night, so a little practice with the orange model may help.', 'Help your child feel excited about exploring day and night together.');
  assert.equal(validateParentNote(generation(invitation), prepareParentNote(input)), invitation);
});
test('needle requirements come from sources and do not require equipment in a simpler supported activity', () => {
  const prepared = prepareParentNote(input);
  const simpler = english.replace('If you use a needle for the model, an adult should help. ', '');
  assert.equal(validateParentNote(generation(simpler, ['source_003', 'source_004']), prepared), simpler);
  const cards = [{ id: 'safe-card', title: 'Light and shadow', kind: 'concept', lines: [{ display: 'Hold an orange near a lamp and notice its bright and dark sides.' }] }];
  const noNeedle = prepareParentNote({ ...input, cards, cardId: 'safe-card' });
  assert.equal(noNeedle.sourceUsesNeedle, false); assert.deepEqual(noNeedle.adultHelpSources, []);
  assert.throws(() => validateParentNote(generation(english, ['source_001']), noNeedle), { code: 'MODEL_SOURCE' });
  const mentionOnly = prepareParentNote({ ...input, cards: [{ ...cards[0], lines: [{ display: 'Earth does not have a needle through its middle.' }] }], cardId: 'safe-card' });
  assert.equal(mentionOnly.sourceUsesNeedle, true); assert.deepEqual(mentionOnly.adultHelpSources, []);
  assert.throws(() => validateParentNote(generation(english, ['source_001']), mentionOnly), { code: 'MODEL_SOURCE' });
});
test('grounding failures retain measured usage and final-attempt limits without a second model call', async () => {
  for (const [text, code] of [[ungroundedHindi, 'MODEL_OBSERVATION'], [hindi.replace('किसी बड़े की मदद लें', 'किसी बड़े की मदद नहीं लें'), 'MODEL_SAFETY']] as const) {
    const memory = memoryLedger(); let calls = 0;
    const result = await draftParentNote({ ...input, language: 'hi', cards: lesson('hi').cards, attempt: 3 }, { enabled: true, now, ledger: memory.ledger, invoke: async () => { calls++; return model(text)(); } });
    assert.equal(result.status, 'failed'); assert.equal(result.code, code); assert.equal(result.retryable, false);
    assert.equal(calls, 1); assert.equal(memory.claimed.size, 1); assert.equal(memory.results.size, 1);
    assert.equal(result.model.usageKnown, true); assert.equal(result.model.inputTokens, 500); assert.equal(result.model.outputTokens, 120);
    assert.equal(result.text, undefined); assert.equal(result.activity, undefined); assert(!JSON.stringify([...memory.results.values()]).includes(text));
  }
});
test('failed generations expose only fixed validation categories, never rejected text or parser diagnostics', async () => {
  const cases: { code: ParentNoteValidationCode; output: string; language?: 'hi' }[] = [
    { code: 'MODEL_RESPONSE_SIZE', output: 'private-oversize-value '.repeat(1800) },
    { code: 'MODEL_JSON', output: '{"private-parser-value": not JSON}' },
    { code: 'MODEL_SCHEMA', output: JSON.stringify({ text: english, sourceCards: ['source_003'], extra: 'private-extra-value' }) },
    { code: 'MODEL_SOURCE', output: generation(english, ['private-source-value']) },
    { code: 'MODEL_LENGTH', output: generation('private-short-value') },
    { code: 'MODEL_LANGUAGE', output: generation(english), language: 'hi' },
    { code: 'MODEL_CONTACT', output: generation(`${english} private-contact@example.test`) },
    { code: 'MODEL_IDENTITY', output: generation(english.replace('Your child', 'Anika')) },
    { code: 'MODEL_LABELS', output: generation(`${english} Your child has ADHD.`) },
  ];
  for (const item of cases) {
    const memory = memoryLedger();
    const result = await draftParentNote({ ...input, language: item.language || 'en' }, { enabled: true, now, ledger: memory.ledger, invoke: async () => ({ generation: item.output, inputTokens: 500, outputTokens: 120, stopReason: 'stop' }) });
    assert.equal(result.code, item.code); assert.equal(result.status, 'failed'); assert.equal(result.retryable, true);
    assert.equal(result.message, `${parentNoteValidationMessages[item.code]} Retry or write manually.`);
    assert.equal(result.text, undefined); assert.equal(result.activity, undefined);
    assert.equal(result.model.usageKnown, true); assert.equal(result.model.outputTokens, 120);
    const saved = JSON.stringify([...memory.results.values()]);
    assert(!/private-(?:oversize|parser|extra|source|short|contact)-value|private-contact@example\.test|Anika|ADHD/.test(saved));
    assert(!saved.includes(item.output));
  }
});
test('diagnostic categories preserve exact existing word and character bounds', () => {
  const prepared = prepareParentNote(input);
  for (const words of [39, 121]) assert.throws(() => validateParentNote(generation(Array(words).fill('idea').join(' '), ['source_003']), prepared), { code: 'MODEL_LENGTH' });
  for (const words of [40, 120]) assert.equal(validateParentNote(generation(Array(words).fill('idea').join(' '), ['source_003']), prepared).split(' ').length, words);
  assert.throws(() => validateParentNote(generation(Array(40).fill('a'.repeat(46)).join(' '), ['source_003']), prepared), { code: 'MODEL_LENGTH' });
});
test('disabled, invalid attempt and funding-window requests fail before reserve/invoke', async () => {
  const memory = memoryLedger(); let calls = 0; const invoke = async () => { calls++; return model()(); };
  for (const time of [new Date(new Date(BUDGET_START).getTime() - 1), new Date(BUDGET_END), new Date('invalid')]) assert.equal((await draftParentNote(input, { enabled: true, now: time, ledger: memory.ledger, invoke })).code, 'AI_BUDGET_WINDOW');
  assert.equal((await draftParentNote(input, { enabled: false, now, ledger: memory.ledger, invoke })).code, 'AI_NOT_ENABLED');
  for (const attempt of [0, 4, 1.5]) assert.equal((await draftParentNote({ ...input, attempt }, { enabled: true, now, ledger: memory.ledger, invoke })).code, 'INVALID_DRAFT_INPUT');
  assert.equal(calls, 0); assert.equal(memory.claimed.size, 0);
  for (const time of [new Date(BUDGET_START), new Date(new Date(BUDGET_END).getTime() - 1)]) assert.equal((await draftParentNote(input, { enabled: true, now: time, ledger: memoryLedger().ledger, invoke })).status, 'ready');
});
test('model timeout/truncation/format failure consumes reservation and final attempt cannot retry', async () => {
  for (const kind of ['timeout', 'truncated', 'format', 'tokens']) {
    const memory = memoryLedger();
    const result = await draftParentNote({ ...input, attempt: 3 }, { enabled: true, now, ledger: memory.ledger, invoke: async () => {
      if (kind === 'timeout') throw new Error('private raw provider diagnostics');
      return { generation: kind === 'format' ? 'invalid json' : generation(), inputTokens: kind === 'tokens' ? MAX_PROMPT_BYTES + 1 : 500, outputTokens: 120, stopReason: kind === 'truncated' ? 'length' : 'stop' };
    } });
    assert.equal(result.status, 'failed'); assert.equal(result.retryable, false); assert.equal(result.text, undefined); assert.equal(result.activity, undefined);
    assert.equal(memory.claimed.size, 1); assert.equal(memory.results.size, 1); assert(!JSON.stringify(result).includes('private raw'));
    assert.equal(result.model.usageKnown, kind === 'truncated' || kind === 'format');
  }
});
test('usage unavailable prevents inference and save failure does not return generated text', async () => {
  const memory = memoryLedger(); let calls = 0; const invoke = async () => { calls++; return model()(); };
  const unavailable = await draftParentNote(input, { enabled: true, now, invoke, ledger: { ...memory.ledger, claim: async () => { throw new Error('unavailable'); } } });
  assert.equal(unavailable.code, 'AI_USAGE_UNAVAILABLE'); assert.equal(calls, 0);
  const finalUnavailable = await draftParentNote({ ...input, attempt: 3 }, { enabled: true, now, invoke, ledger: { ...memory.ledger, claim: async () => { throw new Error('unavailable'); } } });
  assert.equal(finalUnavailable.retryable, false);
  const unsaved = await draftParentNote(input, { enabled: true, now, invoke, ledger: { ...memory.ledger, complete: async () => { throw new Error('unavailable'); } } });
  assert.equal(unsaved.code, 'AI_RESULT_NOT_SAVED'); assert.equal(unsaved.text, undefined); assert.equal(calls, 1); assert.equal(memory.claimed.size, 1);
});

/** Small Dynamo transaction emulator: checks every condition before applying any change. */
function dynamoFixture() {
  const records = new Map<string, any>();
  const key = (value: { PK: string; SK: string }) => `${value.PK}|${value.SK}`;
  const projectKey = 'AI_BUDGET#2026-10-27_2026-11-09|PROJECT';
  records.set(projectKey, { reservedMicroUsd: 420_000, requests: 21 });
  const send = async (command: { input: any }) => {
    const value = command.input;
    if (value.Key) return { Item: records.get(key(value.Key)) };
    const items = value.TransactItems;
    if (items.length === 3 && items[2].Put) {
      const project = records.get(key(items[0].Update.Key)) || {}; const actor = records.get(key(items[1].Update.Key)) || {};
      const reasons = ['None', 'None', 'None'];
      if ((project.reservedMicroUsd || 0) > items[0].Update.ExpressionAttributeValues[':remaining']) reasons[0] = 'ConditionalCheckFailed';
      if ((actor.requests || 0) >= items[1].Update.ExpressionAttributeValues[':limit']) reasons[1] = 'ConditionalCheckFailed';
      if (records.has(key(items[2].Put.Item))) reasons[2] = 'ConditionalCheckFailed';
      if (reasons.some(reason => reason !== 'None')) throw Object.assign(new Error('Transaction cancelled'), { CancellationReasons: reasons.map(Code => ({ Code })) });
      records.set(key(items[0].Update.Key), { ...project, reservedMicroUsd: (project.reservedMicroUsd || 0) + items[0].Update.ExpressionAttributeValues[':reserve'], requests: (project.requests || 0) + 1 });
      records.set(key(items[1].Update.Key), { requests: (actor.requests || 0) + 1 });
      records.set(key(items[2].Put.Item), { ...items[2].Put.Item });
      return {};
    }
    const request = items[0].Update; const prior = records.get(key(request.Key)); const values = request.ExpressionAttributeValues;
    if (!prior || prior.state !== 'running' || prior.fingerprint !== values[':fingerprint']) throw new Error('Completion condition failed');
    records.set(key(request.Key), { ...prior, state: 'complete', result: values[':result'] });
    const project = records.get(projectKey); const costs = items[1].Update.ExpressionAttributeValues;
    for (const [field, token] of [['inputTokens', ':input'], ['outputTokens', ':output'], ['estimatedMicroUsd', ':cost'], ['knownUsageRequests', ':known']]) project[field] = (project[field] || 0) + costs[token];
    return {};
  };
  const db = { send } as unknown as DynamoDBDocumentClient;
  return { records, projectKey, db, ledger: new DynamoUsageLedger<ParentNoteResult>('sls-hackathon-2026-data', db, empty) };
}
test('shared atomic ledger deduplicates concurrent drafts and preserves consumed project allowance', async () => {
  const fixture = dynamoFixture(); let calls = 0;
  const invoke = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 2)); return model()(); };
  const results = await Promise.all(Array.from({ length: 6 }, () => draftParentNote(input, { ledger: fixture.ledger, invoke, now, enabled: true })));
  assert.equal(calls, 1); assert.equal(results.filter(result => result.status === 'ready').length, 1);
  const reread = await draftParentNote(input, { ledger: fixture.ledger, invoke, now, enabled: true }); assert.equal(reread.status, 'ready'); assert.equal(calls, 1);
  assert.equal(fixture.records.get(fixture.projectKey).reservedMicroUsd, 440_000); assert.equal(fixture.records.get(fixture.projectKey).requests, 22);
  assert.equal(fixture.records.get(fixture.projectKey).estimatedMicroUsd, Math.ceil(620 * .72));
  assert.equal([...fixture.records.keys()].filter(key => key.startsWith('AI_BUDGET#')).length, 1);
  const changed = await draftParentNote({ ...input, observation: 'Anika asked about rotation.' }, { ledger: fixture.ledger, invoke, now, enabled: true });
  assert.equal(changed.code, 'REQUEST_CHANGED'); assert.equal(calls, 1);
});
test('Draft window consumes the existing allowance through 20 Nov IST and closes without a reservation', async () => {
  for (const timestamp of ['2026-11-09T18:30:00.000Z', '2026-11-11T18:30:00.000Z', '2026-11-20T18:29:59.999Z']) {
    const fixture = dynamoFixture(); let calls = 0;
    fixture.records.set(fixture.projectKey, { reservedMicroUsd: 520_000, requests: 26 });
    const result = await draftParentNote(input, { enabled: true, now: new Date(timestamp), ledger: fixture.ledger, invoke: async () => { calls++; return model()(); } });
    assert.equal(result.status, 'ready', timestamp); assert.equal(calls, 1);
    assert.equal(fixture.records.get(fixture.projectKey).reservedMicroUsd, 540_000);
    assert.equal(fixture.records.get(fixture.projectKey).requests, 27);
    assert.deepEqual([...fixture.records.keys()].filter(key => key.startsWith('AI_BUDGET#')), ['AI_BUDGET#2026-10-27_2026-11-09|PROJECT']);
  }
  for (const timestamp of ['2026-11-20T18:30:00.000Z', '2026-11-21T00:00:00.000Z']) {
    const fixture = dynamoFixture(); let calls = 0;
    fixture.records.set(fixture.projectKey, { reservedMicroUsd: 520_000, requests: 26 });
    const before = JSON.stringify([...fixture.records]);
    const result = await draftParentNote(input, { enabled: true, now: new Date(timestamp), ledger: fixture.ledger, invoke: async () => { calls++; return model()(); } });
    assert.equal(result.code, 'AI_BUDGET_WINDOW', timestamp); assert.equal(result.retryable, false);
    assert.equal(calls, 0); assert.equal(JSON.stringify([...fixture.records]), before);
  }
});
test('project and actor caps reject draft reservation atomically and default interpreter result stays unchanged', async () => {
  for (const cap of ['project', 'actor']) {
    const fixture = dynamoFixture(); let calls = 0;
    if (cap === 'project') fixture.records.set(fixture.projectKey, { reservedMicroUsd: PROJECT_LIMIT_MICRO_USD, requests: 900 });
    else {
      // An interpreter reservation creates the same actor/day bucket used by the new draft path.
      const legacy = new DynamoUsageLedger('sls-hackathon-2026-data', fixture.db);
      const reservation: Reservation = { requestKey: 'legacy-request', fingerprint: 'same', actorId: input.actorId, now };
      assert.deepEqual(await legacy.claim(reservation), { claimed: true });
      const actor = [...fixture.records.keys()].find(key => key.startsWith('AI_ACTOR#'))!; fixture.records.get(actor).requests = 25;
      const changed = await legacy.claim({ ...reservation, fingerprint: 'different' });
      assert.equal(changed.claimed, false); if (!changed.claimed) { assert.equal(changed.result.unresolved[0].code, 'REQUEST_CHANGED'); assert.deepEqual(changed.result.guidance, []); }
    }
    const before = JSON.stringify([...fixture.records]);
    const result = await draftParentNote(input, { enabled: true, now, ledger: fixture.ledger, invoke: async () => { calls++; return model()(); } });
    assert.equal(result.code, cap === 'project' ? 'PROJECT_AI_LIMIT' : 'TEACHER_AI_LIMIT'); assert.equal(calls, 0); assert.equal(JSON.stringify([...fixture.records]), before);
  }
});
test('interrupted attempts retain reservations; explicit retry uses a new namespaced request', async () => {
  const fixture = dynamoFixture(); const prepared = prepareParentNote(input);
  await fixture.ledger.claim({ requestKey: prepared.requestKey, fingerprint: prepared.fingerprint, actorId: input.actorId, now: new Date(now.getTime() - 61_000) });
  let calls = 0; const invoke = async () => { calls++; return model()(); };
  const interrupted = await draftParentNote(input, { enabled: true, now, ledger: fixture.ledger, invoke });
  assert.equal(interrupted.code, 'ATTEMPT_INTERRUPTED'); assert.equal(interrupted.retryable, true); assert.equal(calls, 0);
  const retried = await draftParentNote({ ...input, attempt: 2 }, { enabled: true, now, ledger: fixture.ledger, invoke });
  assert.equal(retried.status, 'ready'); assert.equal(calls, 1); assert.notEqual(retried.requestKey, interrupted.requestKey);
  assert.equal(fixture.records.get(fixture.projectKey).reservedMicroUsd, 460_000);
});
