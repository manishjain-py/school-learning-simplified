import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { ParentNoteInput, ParentNoteResult } from '../ai/parent-note.js';
import { createParentNotesService, type ParentNoteDependencies, type ParentNoteDraft } from './parent-notes.js';
import { SchoolError, put, queryPage, write, type Student, type VerifiedAccount } from './index.js';

const schoolId = '11111111-1111-4111-8111-111111111111';
const classId = '22222222-2222-4222-8222-222222222222';
const studentId = '33333333-3333-4333-8333-333333333333';
const draftId = '44444444-4444-4444-8444-444444444444';
const chapterId = '55555555-5555-4555-8555-555555555555';
const cardId = '66666666-6666-4666-8666-666666666666';
const teacher: VerifiedAccount = { id: 'teacher-owner', email: 'teacher@example.test', emailVerified: true };
const colleague: VerifiedAccount = { id: 'other-teacher', email: 'other@example.test', emailVerified: true };
const body = { clientId: draftId, studentId, chapterId, cardId, observation: 'Anika mixed up day and night.', language: 'en' };
const rejects = (code: string) => (issue: unknown) => issue instanceof SchoolError && issue.code === code;
const result = (patch: Partial<ParentNoteResult> = {}): ParentNoteResult => ({ requestKey: 'reserved-key', status: 'ready', code: 'READY', message: 'Draft ready.', retryable: false, language: 'en', text: 'Your child can revisit the day and night activity with you.', activity: { chapterId, cardId, chapterTitle: 'Wrong model title', cardTitle: 'Wrong model title' }, model: { id: 'model', region: 'us-east-2', inputTokens: 25, outputTokens: 10, usageKnown: true }, ...patch });

function fixture() {
  const rows = new Map<string, ParentNoteDraft>();
  const key = (school: string, classroom: string, draft: string) => `${school}:${classroom}:${draft}`;
  const state = {
    now: new Date('2026-10-29T02:00:00Z'), allowed: new Set([teacher.id, colleague.id]),
    child: { id: studentId, name: 'Anika Rao', studentEmail: 'anika@example.test', parentEmails: ['parent@example.test'], version: 1, active: true } as Student,
    roster: [{ id: studentId, name: 'Anika Rao' }],
    chapter: { id: chapterId, title: 'Our Earth', description: 'Earth rotates.', subject: 'EVS', languages: ['en', 'hi'], modes: ['learn'] },
    lesson: { id: chapterId, language: 'en', cards: [{ id: cardId, title: 'Day and Night on the Orange', kind: 'concept', partId: 'rotation', lines: [{ display: 'Ask an adult to help with a lamp and orange.' }] }] },
    calls: [] as ParentNoteInput[],
    next: result(),
    generate: undefined as ((input: ParentNoteInput) => Promise<ParentNoteResult>) | undefined,
    beforeSave: undefined as (() => void) | undefined,
    pageSize: 100,
    pages: 0,
    page: undefined as ParentNoteDependencies['page'] | undefined,
  };
  const staff = { school: { id: schoolId, name: 'School', timeZone: 'Asia/Kolkata', createdAt: '2026-10-29', adminId: 'admin' }, schoolClass: { id: classId, name: 'Class 4', subject: 'EVS', teacherEmails: [teacher.email, colleague.email], version: 1 }, role: 'teacher' as const };
  const deps: ParentNoteDependencies = {
    authorize: async (user, school, classroom) => { if (!state.allowed.has(user.id) || school !== schoolId || classroom !== classId) throw new SchoolError(403, 'CLASS_ACCESS_DENIED', 'Denied'); return structuredClone(staff); },
    child: async (school, classroom, student) => school === schoolId && classroom === classId && student === studentId ? structuredClone(state.child) : null,
    roster: async () => structuredClone(state.roster),
    catalog: async () => ({ chapters: [structuredClone(state.chapter)] }),
    lesson: async () => structuredClone(state.lesson),
    read: async (school, classroom, draft) => structuredClone(rows.get(key(school, classroom, draft)) || null),
    page: async (school, classroom, cursor) => {
      state.pages++;
      if (state.page) return state.page(school, classroom, cursor);
      const items = [...rows.values()].filter(row => row.schoolId === school && row.classId === classroom);
      const offset = Number(cursor?.offset || 0);
      return { drafts: structuredClone(items.slice(offset, offset + state.pageSize)), ...(offset + state.pageSize < items.length ? { cursor: { offset: offset + state.pageSize } } : {}) };
    },
    save: async (draft, expected, guard) => {
      state.beforeSave?.();
      const old = rows.get(key(draft.schoolId, draft.classId, draft.id));
      if ((expected === 'new' ? Boolean(old) : old?.version !== expected) || !isDeepStrictEqual(guard.child, state.child) || !state.allowed.has(guard.actor.id)) throw new SchoolError(409, 'RECORD_CHANGED', 'Changed');
      rows.set(key(draft.schoolId, draft.classId, draft.id), structuredClone(draft));
    },
    generate: async input => { state.calls.push(structuredClone(input)); return state.generate ? state.generate(input) : structuredClone(state.next); },
    now: () => state.now,
  };
  const service = createParentNotesService(deps);
  const stored = () => rows.get(key(schoolId, classId, draftId))!;
  const create = (changes: Record<string, unknown> = {}, actor = teacher) => service.create(actor, schoolId, classId, { ...body, ...changes });
  const read = (actor = teacher) => service.read(actor, schoolId, classId, draftId);
  const retry = (version: number, actor = teacher) => service.retry(actor, schoolId, classId, draftId, { version });
  const publish = (child = studentId, actor = teacher, draftVersion = stored().version) => service.published(actor, schoolId, classId, child, draftId, draftVersion);
  const reject = (version: number, reason = 'unsupported_claim', actor = teacher) => service.reject(actor, schoolId, classId, draftId, { version, reason });
  const list = (child = studentId, actor = teacher) => service.list(actor, schoolId, classId, child);
  return { state, staff, service, rows, stored, create, read, retry, reject, list, publish };
}

test('creates once; duplicate POST and author recovery GET never regenerate or reveal history', async () => {
  const f = fixture(); const first = await f.create();
  assert.equal(first.status, 'ready'); assert.equal(first.version, 2); assert.equal(first.attempt, 1);
  assert.deepEqual(first.activity, { chapterId, cardId, chapterTitle: 'Our Earth', cardTitle: 'Day and Night on the Orange', href: `/learn/${chapterId}?card=${cardId}` });
  assert.equal(f.state.calls.length, 1); assert.deepEqual(f.state.calls[0].chapter, { id: chapterId, title: 'Our Earth', description: 'Earth rotates.', subject: 'EVS' });
  assert.deepEqual(f.state.calls[0].student, { id: studentId, name: 'Anika Rao' });
  assert.equal(JSON.stringify(f.state.calls).includes('parent@example.test'), false);
  assert.deepEqual(await f.create(), first); assert.deepEqual(await f.read(), { ...first, inputs: f.stored().fields }); assert.equal(f.state.calls.length, 1);
  for (const value of [teacher.id, teacher.email, studentId, body.observation, 'parent@example.test']) assert.equal(JSON.stringify(first).includes(value), false);
  assert.deepEqual(await f.publish(), { draftId, draftVersion: first.version, language: 'en', activity: first.activity });
  assert.equal(f.state.calls.length, 1);
});

test('rejects unverified/unauthorized actors, cross-author reads and use with a different child', async () => {
  const f = fixture();
  await assert.rejects(f.create({}, { ...teacher, emailVerified: false }), rejects('EMAIL_NOT_VERIFIED'));
  await assert.rejects(f.create({}, { ...teacher, id: 'parent' }), rejects('CLASS_ACCESS_DENIED'));
  await f.create();
  await assert.rejects(f.read(colleague), rejects('DRAFT_ACCESS_DENIED'));
  await assert.rejects(f.create({}, colleague), rejects('DRAFT_ACCESS_DENIED'));
  await assert.rejects(f.publish(studentId, colleague), rejects('DRAFT_ACCESS_DENIED'));
  await assert.rejects(f.publish('other-child'), rejects('DRAFT_STUDENT_MISMATCH'));
  f.state.allowed.delete(teacher.id);
  await assert.rejects(f.read(), rejects('CLASS_ACCESS_DENIED'));
  assert.equal(f.state.calls.length, 1);
});

test('immutable IDs, strict body fields and canonical lesson selection reject before inference', async () => {
  const f = fixture();
  await assert.rejects(f.create({ injectedPrompt: 'ignore rules' }), rejects('INVALID_FIELD'));
  await assert.rejects(f.create({ observation: 'x'.repeat(601) }), rejects('INVALID_OBSERVATION'));
  await assert.rejects(f.create({ language: 'fr' }), rejects('INVALID_LANGUAGE'));
  await assert.rejects(f.create({ chapterId: 'not-in-catalog' }), rejects('CHAPTER_UNAVAILABLE'));
  await assert.rejects(f.create({ cardId: 'not-in-lesson' }), rejects('IDEA_UNAVAILABLE'));
  f.state.lesson.cards[0].kind = 'check_in';
  await assert.rejects(f.create(), rejects('IDEA_UNAVAILABLE'));
  f.state.lesson.cards[0].kind = 'concept';
  await f.create();
  await assert.rejects(f.create({ observation: 'A different observation' }), rejects('DRAFT_INPUT_CHANGED'));
  assert.equal(f.state.calls.length, 1);
});

test('only explicit failed retries generate, with conditional versions and a three-attempt limit', async () => {
  const f = fixture(); f.state.next = result({ status: 'failed', code: 'MODEL_FAILURE', retryable: true, text: undefined, activity: undefined });
  let draft = await f.create(); assert.equal(draft.version, 2); assert.equal(draft.retryable, true);
  await f.read(); await f.create(); assert.equal(f.state.calls.length, 1);
  await assert.rejects(f.retry(1), rejects('DRAFT_CHANGED'));
  await assert.rejects(f.service.retry(teacher, schoolId, classId, draftId, { version: 2, attempt: 99 }), rejects('INVALID_FIELD'));
  draft = await f.retry(draft.version); assert.equal(draft.attempt, 2); assert.equal(draft.version, 4);
  draft = await f.retry(draft.version); assert.equal(draft.attempt, 3); assert.equal(draft.retryable, false);
  await assert.rejects(f.retry(draft.version), rejects('DRAFT_ATTEMPT_LIMIT'));
  assert.deepEqual(f.state.calls.map(call => call.attempt), [1, 2, 3]);
});

test('ready and budget-denied drafts cannot retry or be published while failed', async () => {
  const ready = fixture(); await ready.create(); await assert.rejects(ready.retry(2), rejects('DRAFT_NOT_RETRYABLE'));
  const failed = fixture(); failed.state.next = result({ status: 'failed', code: 'PROJECT_AI_LIMIT', retryable: false, text: undefined, activity: undefined });
  const draft = await failed.create(); await assert.rejects(failed.retry(draft.version), rejects('DRAFT_NOT_RETRYABLE'));
  await assert.rejects(failed.publish(), rejects('DRAFT_NOT_READY'));
});

test('an author rejection preserves the ready attempt privately and retries the same inputs within three attempts', async () => {
  const f = fixture();
  f.state.next = result({ status: 'failed', retryable: true, text: undefined, activity: undefined });
  const first = await f.create();
  f.state.next = result({ text: 'An unsupported claim that the teacher rejects.' });
  const second = await f.retry(first.version); const original = structuredClone(f.stored());
  const rejected = await f.reject(second.version, 'unsafe_activity');
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.code, 'TEACHER_REJECTED'); assert.equal(rejected.retryable, true);
  assert.equal(rejected.version, second.version + 1); assert.equal(rejected.attempt, 2);
  assert.equal(rejected.text, undefined); assert.deepEqual(rejected.model, second.model);
  assert.deepEqual(f.stored().rejections, [{ version: second.version, attempt: 2, reason: 'unsafe_activity', rejectedAt: f.state.now.toISOString(), result: original.result }]);
  assert.equal(f.state.calls.length, 2, 'Rejection performs no inference.');
  assert.deepEqual(await f.reject(second.version, 'unsafe_activity'), rejected);
  assert.equal(f.stored().rejections?.length, 1);
  await assert.rejects(f.publish(), rejects('DRAFT_NOT_READY'));
  const recovered = await f.read();
  assert.deepEqual(recovered.inputs, original.fields);
  assert.equal(JSON.stringify(recovered).includes('unsupported claim'), false);
  assert.equal('rejections' in recovered, false);
  f.state.next = result({ text: 'Corrected grounded note.' });
  const third = await f.retry(rejected.version);
  assert.equal(third.attempt, 3); assert.equal(third.id, second.id);
  const { attempt: firstAttempt, ...originalInput } = f.state.calls[0];
  assert.equal(firstAttempt, 1);
  for (const { attempt, ...input } of f.state.calls) assert.deepEqual(input, originalInput);
  assert.deepEqual(f.stored().fields, original.fields); assert.equal(f.stored().fingerprint, original.fingerprint);
  assert.deepEqual(f.stored().rejections?.[0].result, original.result);
  assert.equal((await f.reject(second.version, 'unsafe_activity')).version, third.version, 'A replay after retry returns current status without rejecting the new generation.');
  const exhausted = await f.reject(third.version, 'unsupported_claim');
  assert.equal(exhausted.retryable, false); assert.equal(exhausted.attempt, 3);
  await assert.rejects(f.retry(exhausted.version), rejects('DRAFT_ATTEMPT_LIMIT'));
  assert.equal(f.state.calls.length, 3);
});

test('rejection validates actor, expected version and fixed reason without changing usage', async () => {
  const f = fixture(); const draft = await f.create();
  await assert.rejects(f.reject(draft.version, 'unsafe_activity', colleague), rejects('DRAFT_ACCESS_DENIED'));
  await assert.rejects(f.reject(draft.version, 'unsafe_activity', { ...teacher, emailVerified: false }), rejects('EMAIL_NOT_VERIFIED'));
  await assert.rejects(f.reject(draft.version - 1), rejects('DRAFT_CHANGED'));
  await assert.rejects(f.reject(draft.version, 'free-form-private-observation'), rejects('REJECTION_REASON_REQUIRED'));
  await assert.rejects(f.service.reject(teacher, schoolId, classId, draftId, { version: draft.version, reason: ['other'] }), rejects('REJECTION_REASON_REQUIRED'));
  await assert.rejects(f.service.reject(teacher, schoolId, classId, draftId, { version: draft.version, reason: 'other', attempt: 0 }), rejects('INVALID_FIELD'));
  await f.reject(draft.version);
  await assert.rejects(f.reject(draft.version, 'other'), rejects('DRAFT_CHANGED'));
  await assert.rejects(f.reject(f.stored().version), rejects('DRAFT_NOT_READY'));
  assert.equal(f.state.calls.length, 1);
});

test('simultaneous rejection and retry preserve one rejected generation and one next attempt', async () => {
  const f = fixture(); const ready = await f.create();
  const rejections = await Promise.all([f.reject(ready.version), f.reject(ready.version)]);
  assert.deepEqual(rejections[0], rejections[1]); assert.equal(f.stored().rejections?.length, 1); assert.equal(f.state.calls.length, 1);
  const outcomes = await Promise.allSettled([f.retry(rejections[0].version), f.retry(rejections[0].version), f.reject(ready.version)]);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  assert.deepEqual(f.state.calls.map(item => item.attempt), [1, 2]); assert.equal(f.stored().rejections?.length, 1);
});

test('reject rechecks canonical authorization at commit and publication binds the reviewed generation', async () => {
  const revoked = fixture(); const first = await revoked.create();
  revoked.state.beforeSave = () => { revoked.state.beforeSave = undefined; revoked.state.child.version++; };
  await assert.rejects(revoked.reject(first.version), rejects('DRAFT_CHILD_CHANGED'));
  assert.equal(revoked.stored().result.status, 'ready'); assert.equal(revoked.stored().rejections, undefined);
  const f = fixture(); const original = await f.create();
  const preparedBeforeReject = await f.service.preparePublished(teacher, schoolId, classId, studentId, draftId, original.version);
  const rejected = await f.reject(original.version); const next = await f.retry(rejected.version);
  await assert.rejects(f.publish(studentId, teacher, original.version), rejects('DRAFT_CHANGED'));
  await assert.rejects(f.service.published(teacher, schoolId, classId, studentId, draftId, undefined as unknown as number), rejects('VERSION_REQUIRED'));
  assert.deepEqual(await f.publish(studentId, teacher, next.version), { draftId, draftVersion: next.version, language: 'en', activity: next.activity });
  const draftCondition = preparedBeforeReject.checks.find(item => item.ConditionCheck?.Key?.SK === `DRAFT#${draftId}`)!.ConditionCheck!;
  assert.equal(draftCondition.ExpressionAttributeValues?.[':version'], original.version);
  assert.notEqual(f.stored().version, original.version, 'The old prepared publication fails its same-transaction version condition after rejection.');
});

test('saved draft recovery paginates, filters private scope and returns only the latest twenty summaries', async () => {
  const f = fixture(); await f.create(); const base = structuredClone(f.stored()); f.state.pageSize = 3;
  for (let index = 0; index < 25; index++) {
    const id = `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`;
    f.rows.set(`${schoolId}:${classId}:${id}`, { ...structuredClone(base), id, updatedAt: new Date(f.state.now.getTime() + index * 1000).toISOString() });
  }
  for (const [suffix, change] of Object.entries({ peer: { authorId: colleague.id }, child: { fields: { ...base.fields, studentId: 'other-child' } }, stale: { childFingerprint: 'stale-snapshot' } })) {
    f.rows.set(suffix, { ...structuredClone(base), ...change, id: suffix, updatedAt: '2099-01-01' });
  }
  const summaries = await f.list();
  assert.equal(summaries.length, 20); assert.ok(f.state.pages > 1);
  assert.equal(summaries[0].id, '77777777-7777-4777-8777-000000000024');
  assert.equal(summaries.some(item => ['peer', 'child', 'stale'].includes(item.id)), false);
  assert.deepEqual(Object.keys(summaries[0]).sort(), ['id', 'version', 'status', 'language', 'chapterId', 'cardId', 'updatedAt', 'attempt'].sort());
  assert.equal(JSON.stringify(summaries).includes(body.observation), false);
  assert.equal(f.state.calls.length, 1);
  await assert.rejects(f.list(studentId, { ...teacher, id: 'parent' }), rejects('CLASS_ACCESS_DENIED'));
  const otherAuthor = await f.list(studentId, colleague); assert.equal(otherAuthor.length, 1); assert.equal(otherAuthor[0].id, 'peer');
  f.state.child.version++;
  assert.deepEqual(await f.list(), []);
  await assert.rejects(f.read(), rejects('DRAFT_CHILD_CHANGED'));
});

test('saved draft recovery never claims completeness after its bound and rechecks current access', async () => {
  const bounded = fixture(); bounded.state.page = async () => ({ drafts: [], cursor: { next: true } });
  await assert.rejects(bounded.list(), rejects('DRAFT_LIST_TOO_LARGE')); assert.equal(bounded.state.pages, 20);
  const changed = fixture(); await changed.create(); changed.state.page = async () => { changed.state.child.version++; return { drafts: [structuredClone(changed.stored())] }; };
  await assert.rejects(changed.list(), rejects('DRAFT_CHILD_CHANGED'));
  const revoked = fixture(); await revoked.create(); revoked.state.page = async () => { revoked.state.allowed.delete(teacher.id); return { drafts: [structuredClone(revoked.stored())] }; };
  await assert.rejects(revoked.list(), rejects('CLASS_ACCESS_DENIED'));
});

test('private recovery uses bounded consistent Query pages and returns the cursor for continuation', async t => {
  const cursor = { PK: 'private-drafts', SK: 'DRAFT#previous' }; const next = { ...cursor, SK: 'DRAFT#next' };
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    assert.ok(command instanceof QueryCommand); assert.equal(command.input.Limit, 100); assert.equal(command.input.ConsistentRead, true);
    assert.deepEqual(command.input.ExclusiveStartKey, cursor);
    assert.equal(command.input.KeyConditionExpression, 'PK = :pk AND begins_with(SK, :prefix)');
    assert.deepEqual(command.input.ExpressionAttributeValues, { ':pk': 'private-drafts', ':prefix': 'DRAFT#' });
    return { Items: [{ id: 'one' }], LastEvaluatedKey: next };
  });
  assert.deepEqual(await queryPage('private-drafts', 'DRAFT#', cursor), { items: [{ id: 'one' }], cursor: next });
});

test('an in-flight duplicate returns processing; timeout reads never invoke; retry supersedes late completion', async () => {
  const f = fixture(); let release!: (value: ParentNoteResult) => void;
  f.state.generate = async input => input.attempt === 1 ? new Promise(resolve => { release = resolve; }) : result({ text: 'Second attempt text.' });
  const running = f.create();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const duplicate = await f.create(); assert.equal(duplicate.status, 'processing'); assert.equal(duplicate.version, 1);
  assert.equal(f.state.calls.length, 1);
  f.state.now = new Date(f.state.now.getTime() + 60_001);
  const timeout = await f.read(); assert.equal(timeout.status, 'failed'); assert.equal(timeout.code, 'ATTEMPT_INTERRUPTED'); assert.equal(timeout.retryable, true);
  assert.equal(f.stored().result.status, 'processing', 'Read-only timeout projection does not mutate the record.');
  const retried = await f.retry(timeout.version); assert.equal(retried.attempt, 2); assert.equal(retried.text, 'Second attempt text.');
  release(result({ text: 'Late first attempt.' }));
  const oldResponse = await running;
  assert.equal(oldResponse.text, 'Second attempt text.'); assert.equal(f.stored().result.text, 'Second attempt text.'); assert.equal(f.state.calls.length, 2);
});

test('roster changes and revoked staff after inference never return or store model text', async t => {
  for (const change of ['child', 'staff', 'roster', 'content']) await t.test(change, async () => {
    const f = fixture();
    f.state.generate = async () => {
      if (change === 'child') f.state.child.version++;
      if (change === 'staff') f.state.allowed.delete(teacher.id);
      if (change === 'roster') f.state.roster.push({ id: 'peer', name: 'Another Child' });
      if (change === 'content') f.state.lesson.cards[0].lines[0].display = 'Changed source';
      return result({ text: 'Never disclose this stale output.' });
    };
    await assert.rejects(f.create(), rejects(change === 'child' ? 'DRAFT_CHILD_CHANGED' : change === 'staff' ? 'CLASS_ACCESS_DENIED' : 'DRAFT_CONTEXT_CHANGED'));
    assert.equal(f.stored().result.text, undefined); assert.equal(f.state.calls.length, 1);
  });
});

test('conditional completion guard prevents a change between reread and save', async () => {
  const f = fixture();
  f.state.generate = async () => { f.state.beforeSave = () => { f.state.beforeSave = undefined; f.state.child.active = false; }; return result(); };
  await assert.rejects(f.create(), rejects('STUDENT_NOT_FOUND'));
  assert.equal(f.stored().result.text, undefined);
});

test('existing ready drafts reject child changes, deactivation and changed source at publication', async t => {
  for (const change of ['email', 'deactivate', 'content']) await t.test(change, async () => {
    const f = fixture(); await f.create();
    if (change === 'email') { f.state.child.studentEmail = 'replacement@example.test'; f.state.child.version++; }
    if (change === 'deactivate') f.state.child.active = false;
    if (change === 'content') f.state.chapter.description = 'Changed grounding';
    await assert.rejects(f.publish(), rejects(change === 'email' ? 'DRAFT_CHILD_CHANGED' : change === 'deactivate' ? 'STUDENT_NOT_FOUND' : 'DRAFT_CONTEXT_CHANGED'));
    assert.equal(f.state.calls.length, 1);
  });
});

test('transport failure stays private and manually recoverable; mismatched ready activity is rejected', async () => {
  const f = fixture(); f.state.generate = async () => { throw new Error('sensitive transport detail'); };
  const failed = await f.create(); assert.equal(failed.status, 'failed'); assert.equal(failed.retryable, true); assert.equal(JSON.stringify(failed).includes('sensitive transport detail'), false);
  f.state.generate = async () => result({ activity: { chapterId, cardId: 'wrong-card', chapterTitle: 'x', cardTitle: 'x' } });
  const mismatch = await f.retry(failed.version); assert.equal(mismatch.status, 'failed'); assert.equal(mismatch.code, 'INVALID_DRAFT'); assert.equal(mismatch.text, undefined); assert.equal(mismatch.model.inputTokens, 25); assert.equal(mismatch.model.usageKnown, true);
});


test('a canonical identity change at the initial conditional claim makes no model call', async () => {
  const f = fixture(); f.state.beforeSave = () => { f.state.beforeSave = undefined; f.state.child.version++; };
  await assert.rejects(f.create(), rejects('RECORD_CHANGED'));
  assert.equal(f.state.calls.length, 0); assert.equal(f.rows.size, 0);
});

test('two simultaneous retries of one failed version cannot spend two attempts', async () => {
  const f = fixture(); f.state.next = result({ status: 'failed', retryable: true, text: undefined, activity: undefined });
  const first = await f.create();
  const outcomes = await Promise.allSettled([f.retry(first.version), f.retry(first.version)]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  assert.deepEqual(f.state.calls.map(item => item.attempt), [1, 2]);
  assert.equal(f.stored().attempt, 2);
});


test('publication checks reject identity or draft changes immediately before the update transaction', async t => {
  for (const change of ['none', 'parent-link', 'deactivate', 'staff-revoked', 'class-unassigned', 'draft-version', 'draft-not-ready', 'draft-author', 'draft-child', 'author-rejection']) await t.test(change, async testCase => {
    const priorTable = process.env.TABLE_NAME; process.env.TABLE_NAME = 'test-parent-note-races';
    testCase.after(() => { if (priorTable === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = priorTable; });
    const f = fixture(); await f.create();
    const prepared = await f.service.preparePublished(teacher, schoolId, classId, studentId, draftId, f.stored().version);
    assert.deepEqual(prepared.assistance, await f.publish());
    assert.equal(JSON.stringify(prepared.assistance).includes(body.observation), false);
    assert.equal(JSON.stringify(prepared.assistance).includes(teacher.email), false);
    type Row = Record<string, any>;
    const dbRows = new Map<string, Row>(); const key = (record: Row) => JSON.stringify([record.PK, record.SK]);
    const store = (PK: string, SK: string, value: Row) => { const row: Row = { ...structuredClone(value), PK, SK }; dbRows.set(key(row), row); return row; };
    const child = store(`CLASS#${schoolId}#${classId}`, `STUDENT#${studentId}`, f.state.child);
    store(`SCHOOL#${schoolId}`, 'META', f.staff.school);
    const classroom = store(`SCHOOL#${schoolId}`, `CLASS#${classId}`, f.staff.schoolClass);
    const member = store(`SCHOOL#${schoolId}`, `TEACHER#${createHash('sha256').update(teacher.email).digest('hex')}`, { active: true, email: teacher.email });
    const draft = store(`PARENT_DRAFT#${schoolId}#${classId}`, `DRAFT#${draftId}`, f.stored());
    let publications = 0;
    testCase.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
      assert.ok(command instanceof TransactWriteCommand);
      // All these changes happen after preparePublished has read and authorized.
      if (change === 'parent-link') child.parentEmails = ['new-parent@example.test'];
      if (change === 'deactivate') child.active = false;
      if (change === 'staff-revoked') member.active = false;
      if (change === 'class-unassigned') classroom.teacherEmails = [colleague.email];
      if (change === 'draft-version') draft.version++;
      if (change === 'draft-not-ready') draft.result.status = 'failed';
      if (change === 'draft-author') draft.authorId = colleague.id;
      if (change === 'draft-child') draft.fields.studentId = 'other-child';
      if (change === 'author-rejection') { await f.reject(f.stored().version); Object.assign(draft, structuredClone(f.stored())); }
      const items = command.input.TransactItems as Row[];
      const conditions = items.map(item => {
        const operation = item.ConditionCheck || item.Put;
        const row = dbRows.get(key(operation.Key || operation.Item));
        const names = operation.ExpressionAttributeNames || {}; const values = operation.ExpressionAttributeValues || {};
        return operation.ConditionExpression.split(' AND ').every((clause: string) => {
          const missing = clause.match(/^attribute_not_exists\(([^)]+)\)$/);
          if (missing) return row?.[names[missing[1]] || missing[1]] === undefined;
          const equality = clause.match(/^([#\w.]+) = (:\w+)$/); assert.ok(equality, `Unsupported condition: ${clause}`);
          const actual = equality[1].split('.').reduce((value: any, part: string) => value?.[names[part] || part], row);
          return isDeepStrictEqual(actual, values[equality[2]]);
        });
      });
      if (!conditions.every(Boolean)) throw Object.assign(new Error('Publication guard changed'), { name: 'TransactionCanceledException', CancellationReasons: conditions.map(matched => ({ Code: matched ? 'None' : 'ConditionalCheckFailed' })) });
      for (const item of items) if (item.Put) { dbRows.set(key(item.Put.Item), structuredClone(item.Put.Item)); publications++; }
      return {};
    });
    const update = { id: 'published-note', text: 'Teacher-edited text.', assistance: prepared.assistance, version: 1 };
    const transaction = [put('TEST_PUBLICATION', 'UPDATE#note', update, 'new'), put('TEST_PUBLICATION', 'UPDATEREV#note#000001', update, 'new'), ...prepared.checks];
    if (change === 'none') { await write(transaction); assert.equal(publications, 2); }
    else { await assert.rejects(write(transaction), rejects('RECORD_CHANGED')); assert.equal(publications, 0); assert.equal(dbRows.has(JSON.stringify(['TEST_PUBLICATION', 'UPDATE#note'])), false); }
  });
});
