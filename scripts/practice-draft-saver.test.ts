import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createDraftSaver, type DraftSnapshot, type DraftSaveState, type SavedDraft } from '../apps/web/src/practice/draftSaver.js';

const initial = (): SavedDraft & { marker: string } => ({ id: 'set-one', version: 1, status: 'draft', currentIndex: 0, language: 'en', answers: {}, marker: 'metadata' });
const draft = (answers: Record<string, string[]>, currentIndex = 0, language: 'en' | 'hi' = 'en'): DraftSnapshot => ({ answers, currentIndex, language });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  let remote = initial();
  const calls: { draft: DraftSnapshot; version: number; response: ReturnType<typeof deferred<typeof remote>> }[] = [];
  const saved: typeof remote[] = []; const states: DraftSaveState[] = [];
  const saver = createDraftSaver(remote, {
    save: (value, version) => { const response = deferred<typeof remote>(); calls.push({ draft: value, version, response }); return response.promise; },
    read: async () => ({ ...remote }),
    onSaved: value => saved.push(value), onState: state => states.push(state),
  });
  const commit = (index: number, respond = true) => {
    const call = calls[index]; remote = { ...remote, ...call.draft, version: call.version + 1 };
    if (respond) call.response.resolve(remote);
  };
  return { saver, calls, saved, states, commit, setRemote: (value: typeof remote) => { remote = value; } };
}

test('rapid picks, position and language changes serialize and flush the newest snapshot', async () => {
  const h = harness();
  h.saver.update(draft({ q1: ['a'] }));
  h.saver.update(draft({ q1: ['b'] }, 1));
  h.saver.update(draft({ q1: ['b'], q2: ['c'] }, 2, 'hi'));
  let finished = false; const flush = h.saver.flush().then(value => { finished = true; return value; });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].version, 1);
  h.commit(0); await nextTurn();
  assert.equal(finished, false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].version, 2);
  assert.deepEqual(h.calls[1].draft, draft({ q1: ['b'], q2: ['c'] }, 2, 'hi'));
  h.commit(1);
  const result = await flush;
  assert.equal(result.version, 3); assert.equal(result.marker, 'metadata');
  assert.deepEqual(h.states.at(-1), { saving: false, dirty: false, error: '' });
});

test('a failed save retains all later edits and prevents retry storms', async () => {
  const h = harness();
  h.saver.update(draft({ q1: ['a'] }));
  h.saver.update(draft({ q1: ['a'], q2: ['c'] }, 1));
  h.calls[0].response.reject(new Error('Offline')); await nextTurn();
  await assert.rejects(h.saver.flush(), /Offline/);
  h.saver.update(draft({ q1: ['b'], q2: ['c'] }, 2, 'hi'));
  assert.equal(h.calls.length, 1); assert.equal(h.states.at(-1)?.dirty, true);
  const retry = h.saver.retry(); await nextTurn();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].version, 1);
  assert.deepEqual(h.calls[1].draft, draft({ q1: ['b'], q2: ['c'] }, 2, 'hi'));
  h.commit(1); await retry;
  assert.equal(h.states.at(-1)?.dirty, false);
});

test('retry recognizes a committed save whose response was lost before saving newer choices', async () => {
  const h = harness();
  h.saver.update(draft({ q1: ['a'] }));
  h.commit(0, false);
  h.saver.update(draft({ q1: ['b'] }, 1));
  h.calls[0].response.reject(new Error('Response lost')); await nextTurn();
  const retry = h.saver.retry(); await nextTurn();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].version, 2);
  assert.deepEqual(h.saved[0].answers, { q1: ['a'] });
  h.commit(1);
  assert.deepEqual((await retry).answers, { q1: ['b'] });
});

test('retry never overwrites a different tab’s conflicting saved work', async () => {
  const h = harness();
  h.saver.update(draft({ q1: ['a'] }));
  h.calls[0].response.reject(new Error('Conflict')); await nextTurn();
  h.setRemote({ ...initial(), version: 2, answers: { q1: ['other'] } });
  await assert.rejects(h.saver.retry(), /changed in another tab/);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.saver.getSnapshot().answers, { q1: ['a'] });
  assert.equal(h.states.at(-1)?.dirty, true);
});

test('reverting a pick while its save is in flight still saves the reversion', async () => {
  const h = harness();
  h.saver.update(draft({ q1: ['a'] })); h.saver.update(draft({}));
  assert.equal(h.states.at(-1)?.dirty, true);
  const flushed = h.saver.flush(); h.commit(0); await nextTurn();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1].draft.answers, {});
  h.commit(1); assert.deepEqual((await flushed).answers, {});
});

test('dispose suppresses callbacks and later queued writes after an in-flight save', async () => {
  const h = harness();
  h.saver.update(draft({ q1: ['a'] })); h.saver.update(draft({ q1: ['b'] }));
  const pending = h.saver.flush(); const rejected = assert.rejects(pending, /no longer open/);
  const count = h.states.length; h.saver.dispose(); h.commit(0); await rejected;
  assert.equal(h.calls.length, 1); assert.equal(h.saved.length, 0); assert.equal(h.states.length, count);
  assert.throws(() => h.saver.update(draft({})), /no longer open/);
});

test('local objects cannot mutate queued choices and equivalent multi-select order does not resave', async () => {
  const h = harness(); const value = draft({ q1: ['b', 'a'] });
  h.saver.update(value); value.answers.q1.push('c');
  assert.deepEqual(h.calls[0].draft.answers, { q1: ['b', 'a'] });
  h.commit(0); await h.saver.flush();
  h.saver.update(draft({ q1: ['a', 'b'], q2: [] })); await h.saver.flush();
  assert.equal(h.calls.length, 1);
});
