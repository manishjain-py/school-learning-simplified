import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGetRequestQueue } from './getRequestQueue';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const unavailable = (status: number) => Object.assign(new Error('Unavailable'), { status });

test('GET queue starts only two attempts at a time and releases slots in FIFO order', async () => {
  const run = createGetRequestQueue(2, 0); const gates = Array.from({ length: 4 }, () => deferred<void>());
  const started: number[] = []; let active = 0; let maximum = 0;
  const results = gates.map((gate, index) => run(async () => {
    started.push(index); active++; maximum = Math.max(maximum, active);
    await gate.promise; active--; return index;
  }));
  await tick(); assert.deepEqual(started, [0, 1]);
  gates[0].resolve(); await tick(); assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve(); await tick(); assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].resolve(); gates[3].resolve();
  assert.deepEqual(await Promise.all(results), [0, 1, 2, 3]); assert.equal(maximum, 2);
});

test('queued and already-aborted GETs never invoke their auth/request work or block later reads', async () => {
  const run = createGetRequestQueue(1, 0); const gate = deferred<void>();
  const first = run(() => gate.promise); let invoked = false;
  const abort = new AbortController();
  const queued = run(async () => { invoked = true; }, abort.signal);
  const rejected = assert.rejects(queued, { name: 'AbortError' }); abort.abort(); await rejected;
  await assert.rejects(run(async () => { invoked = true; }, abort.signal), { name: 'AbortError' });
  const next = run(async () => 'next'); gate.resolve(); await first;
  assert.equal(await next, 'next'); assert.equal(invoked, false);
});

test('only GET 429 and 503 retry once; other failures release the slot without retry', async () => {
  for (const status of [429, 503]) {
    const run = createGetRequestQueue(1, 0); let calls = 0;
    assert.equal(await run(async () => { if (++calls === 1) throw unavailable(status); return 'ready'; }), 'ready');
    assert.equal(calls, 2);
    calls = 0; await assert.rejects(run(async () => { calls++; throw unavailable(status); }), { status }); assert.equal(calls, 2);
  }
  for (const status of [400, 401, 403, 404, 500]) {
    const run = createGetRequestQueue(1, 0); let calls = 0;
    await assert.rejects(run(async () => { calls++; throw unavailable(status); }), { status }); assert.equal(calls, 1);
    assert.equal(await run(async () => 'released'), 'released');
  }
});

test('retry backoff is abortable and does not hold a slot or repeat cancelled work', async () => {
  const run = createGetRequestQueue(1, 1000); const abort = new AbortController(); let calls = 0;
  const pending = run(async () => { calls++; throw unavailable(503); }, abort.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); assert.equal(await run(async () => 'another read'), 'another read');
  abort.abort(); await rejected; assert.equal(calls, 1);
});

test('an active attempt cancelled before completion releases its slot and cannot return stale data', async () => {
  const run = createGetRequestQueue(1, 0); const gate = deferred<string>(); const abort = new AbortController();
  const pending = run(() => gate.promise, abort.signal); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); abort.abort(); gate.resolve('stale'); await rejected;
  assert.equal(await run(async () => 'next'), 'next');
});
