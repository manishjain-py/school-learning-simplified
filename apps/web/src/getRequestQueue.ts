const cancelled = () => new DOMException('The request was cancelled.', 'AbortError');
export function checkRequestSignal(signal?: AbortSignal) { if (signal?.aborted) throw cancelled(); }

function waitBeforeRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkRequestSignal(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Shared by API GETs only. Each attempt acquires a slot before invoking its auth/request work. */
export function createGetRequestQueue(limit = 2, retryDelayMs = 500) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('A positive GET concurrency limit is required.');
  let active = 0;
  const queued: { start: () => void }[] = [];
  const drain = () => { while (active < limit && queued.length) queued.shift()!.start(); };
  const acquire = (signal?: AbortSignal): Promise<() => void> => {
    checkRequestSignal(signal);
    return new Promise((resolve, reject) => {
      const entry = { start: () => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { reject(cancelled()); return; }
        active += 1; let released = false;
        resolve(() => { if (!released) { released = true; active -= 1; drain(); } });
      } };
      const abort = () => {
        const index = queued.indexOf(entry); if (index >= 0) queued.splice(index, 1);
        reject(cancelled());
      };
      signal?.addEventListener('abort', abort, { once: true });
      queued.push(entry); drain();
    });
  };
  return async function run<T>(attempt: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let retry = 0; ; retry += 1) {
      const release = await acquire(signal);
      try { checkRequestSignal(signal); const result = await attempt(); checkRequestSignal(signal); return result; }
      catch (issue) {
        checkRequestSignal(signal);
        const status = (issue as { status?: number })?.status;
        if (retry > 0 || (status !== 429 && status !== 503)) throw issue;
      } finally { release(); }
      // Yield the slot during backoff; a retry rejoins the same bounded queue.
      await waitBeforeRetry(retryDelayMs, signal);
    }
  };
}
