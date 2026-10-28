import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import type { Catalog, Config, Language, Lesson } from '../types';

export type ParentNoteActivity = { chapterId: string; cardId: string; chapterTitle: string; cardTitle: string; href: string };
export type ParentNoteResult = {
  id: string; version: number; attempt: number; status: 'processing' | 'ready' | 'failed';
  text?: string; language: Language; activity?: ParentNoteActivity; retryable: boolean; message: string; model: { id: string; region: string; inputTokens: number; outputTokens: number; usageKnown: boolean };
};
type Inputs = { chapterId: string; cardId: string; observation: string; language: Language };
type Intent = { clientId: string; inputKey: string; editorVersion: number };
type Props = {
  config: Config; userId: string; classPath: string; studentId: string; disabled: boolean;
  getEditorVersion: () => number; onInputsChanged: () => void;
  onReady: (draft: ParentNoteResult, editorVersion: number) => boolean;
};
const message = (issue: unknown) => issue instanceof Error ? issue.message : 'The draft could not be opened. You can keep writing manually.';

/** Accept only the server's canonical card route, never an external draft link. */
export function parentNoteActivityHref(activity: ParentNoteActivity): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(activity.chapterId) || !/^[a-zA-Z0-9_-]+$/.test(activity.cardId)) return null;
  const expected = `/learn/${activity.chapterId}`;
  try {
    const url = new URL(activity.href, 'https://schoollearningsimplified.com');
    if (!activity.href.startsWith('/learn/') || url.origin !== 'https://schoollearningsimplified.com' || url.pathname !== expected || url.searchParams.get('card') !== activity.cardId || url.hash || [...url.searchParams.keys()].some(key => key !== 'card')) return null;
    return activity.href;
  } catch { return null; }
}

export function ParentNoteDraft({ config, userId, classPath, studentId, disabled, getEditorVersion, onInputsChanged, onReady }: Props) {
  const [inputs, setInputs] = useState<Inputs>({ chapterId: '', cardId: '', observation: '', language: 'en' });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [sourceRetry, setSourceRetry] = useState(0);
  const [draft, setDraft] = useState<ParentNoteResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [applied, setApplied] = useState(false);
  const [keptWriting, setKeptWriting] = useState(false);
  const intent = useRef<Intent | null>(null);
  const sequence = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const scope = `${userId}:${classPath}:${studentId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const inputKey = JSON.stringify({ ...inputs, studentId });
  const currentInputs = useRef(inputKey); currentInputs.current = inputKey;
  const appliedResult = useRef('');
  const base = `${classPath}/parent-note-drafts`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; };
  }, []);
  useEffect(() => {
    const abort = new AbortController(); setCatalog(null); setSourceError('');
    request<Catalog>(config, '/catalog', { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setCatalog(value); })
      .catch(issue => { if (!abort.signal.aborted) setSourceError(message(issue)); });
    return () => abort.abort();
  }, [config, sourceRetry]);
  useEffect(() => {
    const abort = new AbortController(); setLesson(null); setSourceError('');
    if (!inputs.chapterId) return () => abort.abort();
    request<Lesson>(config, `/lessons/${encodeURIComponent(inputs.chapterId)}?language=en`, { signal: abort.signal })
      .then(value => {
        if (abort.signal.aborted) return;
        if (value.id !== inputs.chapterId || value.language !== 'en') throw new Error('This lesson could not be opened. Try loading the lesson again.');
        setLesson(value);
      }).catch(issue => { if (!abort.signal.aborted) setSourceError(message(issue)); });
    return () => abort.abort();
  }, [config, inputs.chapterId, sourceRetry]);

  function change(changes: Partial<Inputs>) {
    const next = { ...inputs, ...changes };
    if (JSON.stringify(next) === JSON.stringify(inputs)) return;
    // Inputs and textarea versions are independent: either can invalidate a result.
    sequence.current += 1; pending.current = false; intent.current = null; appliedResult.current = '';
    currentInputs.current = JSON.stringify({ ...next, studentId });
    setInputs(next); setDraft(null); setError(''); setBusy(false); setStarted(false); setApplied(false); setKeptWriting(false);
    onInputsChanged();
  }
  const chapters = catalog?.chapters.filter(chapter => chapter.languages.includes('en') && (chapter.modes?.includes('learn') ?? true)) || [];
  const cards = lesson?.cards.filter(card => card.kind !== 'check_in' && !card.question && card.lines.length > 0) || [];
  const valid = Boolean(studentId && chapters.some(chapter => chapter.id === inputs.chapterId) && cards.some(card => card.id === inputs.cardId) && inputs.observation.trim() && inputs.observation.length <= 600);

  async function run(action: 'create' | 'refresh' | 'retry') {
    if (disabled || pending.current || (action === 'create' && !valid) || (action !== 'create' && !draft)) return;
    if (action === 'retry' && (!draft?.retryable || draft.attempt >= 3)) return;
    if (!intent.current || intent.current.inputKey !== inputKey) intent.current = { clientId: crypto.randomUUID(), inputKey, editorVersion: getEditorVersion() };
    const original = intent.current;
    const requestNumber = ++sequence.current;
    const expectedScope = scope;
    pending.current = true; setBusy(true); setError(''); setStarted(true);
    const stillCurrent = () => mounted.current && currentScope.current === expectedScope && currentInputs.current === original.inputKey && sequence.current === requestNumber;
    try {
      const response = await request<{ draft: ParentNoteResult }>(config,
        action === 'create' ? base : `${base}/${encodeURIComponent(draft!.id)}${action === 'retry' ? '/retry' : ''}`,
        { authenticated: true, expectedUserId: userId, method: action === 'refresh' ? 'GET' : 'POST',
          ...(action === 'create' ? { body: { clientId: original.clientId, studentId, ...inputs } } : action === 'retry' ? { body: { version: draft!.version } } : {}) });
      if (!stillCurrent()) return;
      const result = response.draft;
      if (!result || result.language !== inputs.language || !['processing', 'ready', 'failed'].includes(result.status)) throw new Error('The draft response did not match your selection. Your feedback has not changed.');
      if (result.status === 'ready' && (!result.text?.trim() || !result.activity || result.activity.chapterId !== inputs.chapterId || result.activity.cardId !== inputs.cardId || !parentNoteActivityHref(result.activity))) throw new Error('This draft did not include its selected learning activity. Your feedback has not changed.');
      setDraft(result);
      const resultKey = `${result.id}:${result.version}`;
      if (result.status === 'ready' && appliedResult.current !== resultKey) {
        const accepted = onReady(result, original.editorVersion);
        if (accepted) appliedResult.current = resultKey;
        setApplied(accepted); setKeptWriting(!accepted);
      }
    } catch (issue) { if (stillCurrent()) setError(message(issue)); }
    finally { if (stillCurrent()) { pending.current = false; setBusy(false); } }
  }

  return <details className="parent-note-draft">
    <summary>Draft with Llama</summary>
    <p className="school-help">Choose an idea from the lesson and add your observation. Llama prepares a note for you to edit. Nothing is sent until you publish the family update.</p>
    <fieldset disabled={disabled}>
      <label>Chapter<select value={inputs.chapterId} onChange={event => change({ chapterId: event.target.value, cardId: '' })}>
        <option value="">{catalog ? 'Choose a chapter' : 'Opening available chapters…'}</option>
        {chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
      </select></label>
      <label>Lesson idea<select value={inputs.cardId} disabled={!inputs.chapterId || !lesson} onChange={event => change({ cardId: event.target.value })}>
        <option value="">{inputs.chapterId && !lesson ? 'Opening lesson ideas…' : 'Choose the relevant idea'}</option>
        {cards.map(card => <option key={card.id} value={card.id}>{card.index ?? lesson!.cards.indexOf(card) + 1}. {card.title}</option>)}
      </select></label>
      {sourceError && <div className="parent-note-status" role="alert"><p>{sourceError}</p><button className="text-button" type="button" onClick={() => setSourceRetry(value => value + 1)}>Try loading the lesson again</button></div>}
      <label>What did you notice?<textarea rows={3} maxLength={600} value={inputs.observation} onChange={event => change({ observation: event.target.value })} placeholder="Mixed up day and night during today's activity." />
        <small>{inputs.observation.length}/600 characters · Focus on this child’s learning; leave out other children’s names and contact details.</small>
      </label>
      <label>Parent’s language<select value={inputs.language} onChange={event => change({ language: event.target.value as Language })}><option value="en">English</option><option value="hi">हिन्दी · Hindi</option></select></label>
      <div className="parent-note-actions">
        {!draft && <button type="button" className="button secondary" disabled={busy || !valid} onClick={() => void run('create')}>{busy ? 'Preparing draft…' : started ? 'Check this draft' : 'Draft with Llama'}</button>}
        {draft && draft.status !== 'ready' && <button type="button" className="button secondary" disabled={busy} onClick={() => void run('refresh')}>{busy ? 'Checking draft…' : 'Check draft status'}</button>}
        {draft?.retryable && draft.attempt < 3 && <button type="button" className="button secondary" disabled={busy} onClick={() => void run('retry')}>{busy ? 'Preparing draft…' : 'Try drafting again'}</button>}
      </div>
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    {draft && <div className="parent-note-status" role="status">
      <p>{draft.status === 'processing' ? 'The draft is being prepared. Check its status in a moment; your feedback is still available below.' : draft.status === 'failed' ? draft.message || 'The draft could not be prepared. You can write the note yourself below.' : applied ? 'The draft is in your feedback box. Read it, make any changes, then publish when it is ready.' : 'The draft is ready.'}</p>
      {draft.status !== 'ready' && <small>Draft attempt {draft.attempt} of 3 · {draft.status === 'failed' && !draft.retryable ? 'You can continue writing manually.' : 'Checking status does not start another attempt.'}</small>}
      {keptWriting && <p>Your feedback changed while this draft was being prepared. Your writing has been kept.</p>}
      {draft.status === 'ready' && !applied && draft.text && <details className="parent-note-preview"><summary>View the prepared draft</summary><p lang={draft.language}>{draft.text}</p><p className="school-help">You can copy any useful wording into your feedback.</p></details>}
    </div>}
  </details>;
}
