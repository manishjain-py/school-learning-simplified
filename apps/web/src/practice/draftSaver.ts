export type DraftSnapshot = { answers: Record<string, string[]>; currentIndex: number; language: 'en' | 'hi' };
export type SavedDraft = DraftSnapshot & { version: number; status: 'draft' | 'submitted'; id: string };
export type DraftSaveState = { saving: boolean; dirty: boolean; error: string };
type Options<T extends SavedDraft> = {
  save: (snapshot: DraftSnapshot, version: number) => Promise<T>;
  read: () => Promise<T>;
  onSaved: (result: T) => void;
  onState: (state: DraftSaveState) => void;
};
type Attempt = { baseVersion: number; base: DraftSnapshot; target: DraftSnapshot };

const snapshot = (value: DraftSnapshot): DraftSnapshot => ({
  answers: Object.fromEntries(Object.entries(value.answers).map(([id, picks]) => [id, [...picks]])),
  currentIndex: value.currentIndex,
  language: value.language,
});
// A missing pick and an empty pick both mean skipped; option order has no meaning.
const fingerprint = (value: DraftSnapshot) => JSON.stringify([
  value.currentIndex, value.language,
  Object.entries(value.answers).filter(([, picks]) => picks.length).sort(([a], [b]) => a.localeCompare(b)).map(([id, picks]) => [id, [...picks].sort()]),
]);
const same = (a: DraftSnapshot, b: DraftSnapshot) => fingerprint(a) === fingerprint(b);
const copy = <T extends SavedDraft>(value: T): T => ({ ...value, ...snapshot(value) });
const issue = (error: unknown) => error instanceof Error ? error : new Error('Your answers could not be saved. Please try again.');
const conflict = () => new Error('This set changed in another tab. Your unsaved choices are still on this page. Reopen the saved set before continuing.');

/** Serial, versioned saves. A failed request never drops later local changes. */
export function createDraftSaver<T extends SavedDraft>(initial: T, options: Options<T>) {
  let saved = copy(initial);
  let latest = snapshot(initial);
  let failed: Attempt | null = null;
  let failure: Error | null = null;
  let running = false;
  let disposed = false;
  let task: Promise<void> | null = null;
  const dirty = () => Boolean(failed) || !same(latest, saved);
  const emit = () => { if (!disposed) options.onState({ saving: running, dirty: dirty(), error: failure?.message || '' }); };
  const available = () => { if (disposed) throw new Error('This practice set is no longer open.'); };
  function accept(value: T) {
    saved = copy(value); failed = null;
    if (!disposed) options.onSaved(copy(saved));
  }
  async function recover() {
    const attempt = failed;
    if (!attempt) return;
    const remote = await options.read();
    if (disposed) return;
    if (remote.id !== saved.id || remote.status !== 'draft') throw conflict();
    if (remote.version === attempt.baseVersion && same(remote, attempt.base)) {
      // The failed request did not reach storage; retry the newest local snapshot.
      saved = copy(remote); failed = null;
    } else if (remote.version === attempt.baseVersion + 1 && same(remote, attempt.target)) {
      // The save committed, but its response was lost. Do not replay the old version.
      accept(remote);
    } else throw conflict();
  }
  async function drain(recoverFirst: boolean) {
    if (recoverFirst) await recover();
    while (!disposed && !same(latest, saved)) {
      if (saved.status !== 'draft') throw conflict();
      const attempt: Attempt = { baseVersion: saved.version, base: snapshot(saved), target: snapshot(latest) };
      // Retain the attempted snapshot until its outcome is known, including if
      // the user changes their mind back to the last acknowledged choices.
      failed = attempt; emit();
      const result = await options.save(snapshot(attempt.target), attempt.baseVersion);
      if (disposed) return;
      if (result.id !== saved.id || result.status !== 'draft' || result.version !== attempt.baseVersion + 1 || !same(result, attempt.target)) throw conflict();
      accept(result);
    }
  }
  function start(recoverFirst = false) {
    if (disposed || running || failure || (!recoverFirst && !dirty())) return;
    running = true; emit();
    task = drain(recoverFirst).catch(error => { if (!disposed) failure = issue(error); }).finally(() => {
      running = false; emit();
    });
  }
  async function flush(): Promise<T> {
    available();
    while (true) {
      if (failure) throw failure;
      start();
      if (task && running) await task;
      available();
      if (failure) throw failure;
      if (!running && !dirty()) return copy(saved);
    }
  }
  emit();
  return {
    update(value: DraftSnapshot) {
      available();
      if (saved.status !== 'draft') throw new Error('This practice set has already been submitted.');
      latest = snapshot(value); emit(); start();
    },
    flush,
    async retry(): Promise<T> {
      available();
      if (running) { await task; available(); }
      if (failure) { failure = null; start(true); }
      return flush();
    },
    getSnapshot: () => snapshot(latest),
    dispose() { disposed = true; },
  };
}
