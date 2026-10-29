import { useEffect, useRef, useState, type FormEvent } from 'react';
import { request } from '../api';
import { TeacherLogGuidance } from '../guidance/TeacherLogGuidance';
import { friendlySchoolDate, friendlySchoolTimestamp } from './dates';
import type { Config, Language } from '../types';
import type { Acknowledgement, LinkedChild, RosterStudent, UpdateAcknowledgement } from './types';
import { ParentNoteDraft, parentNoteActivityHref, type ParentNoteActivity, type ParentNoteResult } from './ParentNoteDraft';
import { ParentEmailStatus } from './ParentEmailStatus';
import { NewActivity, useRenderedRead, useSchoolRead as useRead } from './familyActivity';

type Auth = { config: Config; userId: string };
type Log = { id: string; authorId: string; authorName: string; subject: string; note: string; version: number; localDate: string; timeZone: string; createdAt: string; updatedAt: string; guidance: { status: string; message?: string } };
type Assistance = { draftId: string; draftVersion: number; language: Language; activity: ParentNoteActivity };
type FamilyUpdate = { canEdit?: boolean; id: string; authorName: string; audience: 'class' | 'student'; studentId: string | null; text: string; logId: string | null; version: number; createdAt: string; updatedAt: string; assistance?: Assistance; isUnread?: boolean; observedVersion?: number; acknowledgement?: Acknowledgement | null; acknowledgements?: UpdateAcknowledgement[]; threadId?: string };
type Thread = { id: string; childId: string; childName: string; teacherName: string; parentName: string; update: FamilyUpdate; createdAt: string; latestActivityAt: string; unreadCount: number; observedSequence: number; acknowledgement: Acknowledgement | null; acknowledgements: Acknowledgement[] };
type Reply = { id: string; text: string; authorName: string; authorRole: 'parent' | 'teacher'; createdAt: string; sequence?: number; isUnread?: boolean };
const message = (issue: unknown) => issue instanceof Error ? issue.message : 'Please try again.';
const ErrorText = ({ error }: { error: string }) => error ? <p className="form-error" role="alert">{error}</p> : null;

function PublishedAssistance({ assistance }: { assistance?: Assistance }) {
  if (!assistance) return null;
  const href = parentNoteActivityHref(assistance.activity);
  const hindi = assistance.language === 'hi';
  return <div className="parent-note-assistance" lang={assistance.language}>
    <small>{hindi ? 'Llama की मदद से लिखा गया' : 'Written with Llama’s help'}</small>
    {href && <a href={href}>{hindi ? 'संबंधित गतिविधि खोलें' : 'Open the related activity'} · {assistance.activity.chapterTitle} — {assistance.activity.cardTitle}</a>}
  </div>;
}

async function save<T>(auth: Auth, path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') {
  return request<T>(auth.config, path, { authenticated: true, expectedUserId: auth.userId, method, body });
}
function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await action(); } catch (issue) { setError(message(issue)); } finally { setBusy(false); } }
  return { busy, error, submit };
}

export function ClassCommunication({ config, userId, classPath, subject, admin, timeZone, unreadCount = 0, onActivity }: Auth & { classPath: string; subject: string; admin: boolean; timeZone: string; unreadCount?: number; onActivity: () => void }) {
  const [tab, setTab] = useState<'logs' | 'updates' | 'threads'>('logs'); const [revision, setRevision] = useState(0);
  const refresh = () => { setRevision((value) => value + 1); onActivity(); };
  return <section className="class-communication">
    <div className="school-list-heading"><h3>Classroom & home</h3><button className="text-button" onClick={refresh}>Refresh updates</button></div>
    <nav className="communication-tabs" aria-label="Classroom communication">{(['logs', 'updates', 'threads'] as const).map((item) => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{item === 'logs' ? 'Classroom notes' : item === 'updates' ? 'Family updates' : 'Private replies'}{item === 'threads' && <NewActivity count={unreadCount} />}</button>)}</nav>
    {tab === 'logs' ? <StaffLogs timeZone={timeZone} config={config} userId={userId} classPath={classPath} subject={subject} admin={admin} revision={revision} onChanged={refresh} /> : tab === 'updates' ? <StaffUpdates timeZone={timeZone} config={config} userId={userId} classPath={classPath} revision={revision} onChanged={refresh} onRead={onActivity} /> : <Threads timeZone={timeZone} config={config} userId={userId} path={classPath} revision={revision} onChanged={refresh} onRead={onActivity} />}
  </section>;
}

function StaffLogs({ classPath, subject, admin, revision, onChanged, timeZone, ...auth }: Auth & { classPath: string; subject: string; admin: boolean; timeZone: string; revision: number; onChanged: () => void }) {
  const { data, error } = useRead<{ logs: Log[] }>(auth, `${classPath}/logs`, revision);
  const [selected, setSelected] = useState<string | null>(null); const [editing, setEditing] = useState<Log | null>(null); const [notice, setNotice] = useState('');
  return <>
    <p className="school-help">Write what your class covered, upcoming tests and support needs. These notes and staff comments stay within the assigned school team.</p>
    <LogForm key={editing ? `${editing.id}:${editing.version}` : 'new'} {...auth} classPath={classPath} subject={subject} record={editing || undefined} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice('Classroom note saved for staff.'); onChanged(); }} />
    {notice && <p className="notice" role="status">{notice}</p>}<ErrorText error={error} />
    {!data && !error ? <p role="status" className="school-help">Loading classroom notes…</p> : data?.logs.length === 0 ? <p className="school-help">Your first classroom note starts here.</p> : <div className="communication-feed">{data?.logs.map((log) => <article className="communication-entry" key={log.id}>
      <div className="communication-meta"><strong>{log.subject}</strong><span>{friendlySchoolDate(log.localDate, log.timeZone)} · {log.authorName}</span></div><p className="communication-text">{log.note}</p>
      <p className="guidance-state" role="status">{log.guidance.message || `Learning guidance: ${log.guidance.status}`}</p>
      {log.authorId === auth.userId && <TeacherLogGuidance {...auth} schoolId={classPath.split('/')[3]} classId={classPath.split('/')[5]} logId={log.id} version={log.version} guidance={log.guidance} onChanged={onChanged} />}
      <div className="communication-actions"><button className="text-button" onClick={() => setSelected(selected === log.id ? null : log.id)}>{selected === log.id ? 'Close discussion' : 'Staff discussion & history'}</button>{(admin || log.authorId === auth.userId) && <button className="text-button" onClick={() => setEditing(log)}>Correct note</button>}<small>Revision {log.version}</small></div>
      {selected === log.id && <LogDiscussion timeZone={timeZone} key={log.id} {...auth} path={`${classPath}/logs/${log.id}`} revision={revision} onChanged={onChanged} />}
    </article>)}</div>}
  </>;
}
function LogForm({ classPath, subject: initialSubject, record, onCancel, onSaved, ...auth }: Auth & { classPath: string; subject: string; record?: Log; onCancel: () => void; onSaved: () => void }) {
  const [subject, setSubject] = useState(record?.subject || initialSubject); const [note, setNote] = useState(record?.note || ''); const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const { busy, error, submit } = useSubmit(async () => { await save(auth, `${classPath}/logs${record ? `/${record.id}` : ''}`, { subject, note, ...(record ? { version: record.version } : { clientId }) }, record ? 'PUT' : 'POST'); setNote(''); setClientId(crypto.randomUUID()); onSaved(); });
  return <form className="school-form school-inset" onSubmit={submit}><h3>{record ? 'Correct classroom note' : 'What happened in class?'}</h3><label>Subject<input required maxLength={100} value={subject} onChange={(event) => setSubject(event.target.value)} /></label><label>Classroom note<textarea required rows={4} maxLength={3000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Finished Our Earth today. Test tomorrow on landforms. One learner needs more practice…" /></label><p className="school-help">Only staff can read the original note. Family announcements and individual feedback have their own audience below.</p><ErrorText error={error} /><div className="school-form-actions"><button className="button primary" disabled={busy}>{busy ? 'Saving note…' : record ? 'Save correction' : 'Save classroom note'}</button>{record && <button type="button" className="button secondary" onClick={onCancel}>Cancel correction</button>}</div></form>;
}
function LogDiscussion({ path, revision, onChanged, timeZone, ...auth }: Auth & { path: string; timeZone: string; revision: number; onChanged: () => void }) {
  const comments = useRead<{ comments: Reply[] }>(auth, `${path}/comments`, revision); const history = useRead<{ revisions: Log[] }>(auth, path, revision);
  return <section className="staff-discussion"><h4>Staff-only discussion</h4><p className="school-help">Comments do not change the note or create learning guidance.</p><ErrorText error={comments.error} />{comments.data?.comments.map((comment) => <div className="communication-message" key={comment.id}><small>{comment.authorName} · {friendlySchoolTimestamp(comment.createdAt, timeZone)}</small><p>{comment.text}</p></div>)}<TextReply {...auth} path={`${path}/comments`} label="Staff comment" button="Add staff comment" onSaved={onChanged} /><details className="communication-history"><summary>Correction history</summary><ErrorText error={history.error} />{history.data?.revisions.map((revision) => <div key={revision.version}><small>Revision {revision.version} · {friendlySchoolTimestamp(revision.updatedAt, revision.timeZone)} · {friendlySchoolDate(revision.localDate, revision.timeZone)} ({revision.timeZone})</small><strong>{revision.subject}</strong><p>{revision.note}</p></div>)}</details></section>;
}

function StaffUpdates({ classPath, revision, onChanged, onRead, timeZone, ...auth }: Auth & { classPath: string; timeZone: string; revision: number; onChanged: () => void; onRead: () => void }) {
  const { data, error } = useRead<{ updates: FamilyUpdate[] }>(auth, `${classPath}/updates`, revision, true); const roster = useRead<{ students: RosterStudent[] }>(auth, `${classPath}/roster`, revision);
  const [editing, setEditing] = useState<FamilyUpdate | null>(null); const [notice, setNotice] = useState('');
  const [opened, setOpened] = useState('');
  return <>
    <p className="school-help">Publish an announcement to the class or feedback to one child and their linked parents. Parents can reply privately to the author.</p>
    <UpdateForm key={editing ? `${editing.id}:${editing.version}` : 'new'} {...auth} classPath={classPath} students={roster.data?.students || []} record={editing || undefined} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice('Family update published to its selected audience.'); onChanged(); }} />
    {notice && <p className="notice" role="status">{notice}</p>}<ErrorText error={error || roster.error} />
    {!data && !error ? <p className="school-help" role="status">Loading family updates…</p> : data?.updates.length === 0 ? <p className="school-help">No family updates yet.</p> : <div className="communication-feed">{data?.updates.map((update) => <article className="communication-entry" key={update.id}>
      <span className="school-role">{update.audience === 'class' ? 'Whole class' : roster.data?.students.find((student) => student.id === update.studentId)?.name || 'Individual child'}</span>
      <p className="communication-text" lang={update.assistance?.language}>{update.text}</p><PublishedAssistance assistance={update.assistance} />
      <div className="communication-meta"><span>{update.authorName} · {friendlySchoolTimestamp(update.updatedAt, timeZone)}</span>{update.canEdit && <button className="text-button" onClick={() => setEditing(update)}>Correct update</button>}</div>
      {Boolean(update.acknowledgements?.length) && <div className="family-acknowledgements">
        {update.acknowledgements!.map(ack => <p key={`${ack.threadId}:${ack.updateVersion}`}><strong>{ack.updateVersion === update.version ? 'Acknowledged by' : `Earlier revision ${ack.updateVersion} acknowledged by`} {ack.parentName}</strong> · {friendlySchoolTimestamp(ack.acknowledgedAt, timeZone)}<small>{ack.childName}’s parent</small></p>)}
        {[...new Map(update.acknowledgements!.map(ack => [ack.threadId, ack])).values()].map(ack => <div className="family-ack-thread" key={ack.threadId}>
          <button className="text-button" aria-expanded={opened === ack.threadId} onClick={() => setOpened(opened === ack.threadId ? '' : ack.threadId)}>{opened === ack.threadId ? 'Close conversation' : `Open conversation with ${ack.parentName}`}</button>
          {opened === ack.threadId && <ThreadMessages key={ack.threadId} {...auth} timeZone={timeZone} path={`${classPath}/threads/${ack.threadId}/messages`} revision={revision} onChanged={onChanged} onRead={onRead} role="teacher" showUpdate={false} />}
        </div>)}
      </div>}
      {update.audience === 'student' && <ParentEmailStatus config={auth.config} userId={auth.userId} updatePath={`${classPath}/updates/${encodeURIComponent(update.id)}`} revision={revision} timeZone={timeZone} />}
    </article>)}</div>}
  </>;
}
function UpdateForm({ classPath, students, record, onCancel, onSaved, ...auth }: Auth & { classPath: string; students: RosterStudent[]; record?: FamilyUpdate; onCancel: () => void; onSaved: () => void }) {
  const [audience, setAudience] = useState(record?.audience || 'class'); const [studentId, setStudentId] = useState(record?.studentId || ''); const [text, setText] = useState(record?.text || ''); const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [assistance, setAssistance] = useState<Assistance | null>(null);
  const [draftReset, setDraftReset] = useState(0);
  const [draftBusy, setDraftBusy] = useState(false);
  const editorVersion = useRef(0);
  const publishing = useRef(false);
  const mounted = useRef(true);
  const scope = `${auth.userId}:${classPath}:${audience}:${studentId}:${record?.id || 'new'}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; editorVersion.current += 1; }; }, []);
  function changeAudience(value: 'class' | 'student') { editorVersion.current += 1; setAssistance(null); setAudience(value); }
  function changeStudent(value: string) { editorVersion.current += 1; setAssistance(null); setStudentId(value); }
  function acceptDraft(draft: ParentNoteResult, expectedVersion: number) {
    if (!mounted.current || publishing.current || currentScope.current !== scope || audience !== 'student' || editorVersion.current !== expectedVersion || draft.status !== 'ready' || !draft.text || !draft.activity) return false;
    editorVersion.current += 1;
    setText(draft.text);
    setAssistance({ draftId: draft.id, draftVersion: draft.version, language: draft.language, activity: draft.activity });
    return true;
  }
  const { busy, error, submit } = useSubmit(async () => {
    // Publishing and manual edits both invalidate any still-running draft response.
    editorVersion.current += 1; publishing.current = true;
    try {
      if (draftBusy) return;
      await save(auth, `${classPath}/updates${record ? `/${record.id}` : ''}`, { audience, studentId: audience === 'student' ? studentId : null, text, logId: record?.logId || null, ...(assistance && audience === 'student' ? { draftId: assistance.draftId, draftVersion: assistance.draftVersion } : {}), ...(record ? { version: record.version } : { clientId }) }, record ? 'PUT' : 'POST');
      if (!mounted.current || currentScope.current !== scope) return;
      setText(''); setAssistance(null); setClientId(crypto.randomUUID()); setDraftReset(value => value + 1); onSaved();
    } finally { publishing.current = false; }
  });
  return <form className="school-form school-inset" onSubmit={submit}>
    <h3>{record ? 'Correct family update' : 'Share a family update'}</h3>
    <label>Who can see this?<select disabled={busy} value={audience} onChange={(event) => changeAudience(event.target.value as 'class' | 'student')}><option value="class">Whole class and linked parents</option><option value="student">One child and their linked parents</option></select></label>
    {audience === 'student' && <label>Student<select required disabled={busy} value={studentId} onChange={(event) => changeStudent(event.target.value)}><option value="">Choose a student</option>{students.map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>}
    {audience === 'student' && students.some(student => student.id === studentId) && <ParentNoteDraft key={`${auth.userId}:${classPath}:${studentId}:${draftReset}`} {...auth} classPath={classPath} studentId={studentId} disabled={busy} getEditorVersion={() => editorVersion.current} onInputsChanged={() => { editorVersion.current += 1; setAssistance(null); }} onRejected={draft => { editorVersion.current += 1; setAssistance(null); if (text === draft.text) setText(''); }} onBusyChange={setDraftBusy} onReady={acceptDraft} />}
    {record?.assistance && !assistance && <p className="school-help">The published note was written with Llama’s help. This correction will be marked as written manually unless you use a new draft.</p>}
    <label>{audience === 'class' ? 'Class announcement' : 'Individual feedback'}<textarea required rows={5} maxLength={3000} disabled={busy} lang={assistance?.language} value={text} onChange={(event) => { editorVersion.current += 1; setText(event.target.value); }} /></label>
    {assistance && <div className="parent-note-editor-source"><strong>Drafted with Llama</strong><p className="school-help">Edit the note to reflect your observation. Publish only when you are ready to share it with this child and their linked parents.</p><PublishedAssistance assistance={assistance} /></div>}
    <ErrorText error={error} />
    <div className="school-form-actions"><button className="button primary" disabled={busy || draftBusy}>{busy ? 'Publishing…' : record ? 'Publish correction' : 'Publish update'}</button>{record && <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Cancel correction</button>}</div>
  </form>;
}

function TextReply({ path, label, button, updateId, onSaved, disabled = false, ...auth }: Auth & { path: string; label: string; button: string; updateId?: string; disabled?: boolean; onSaved: (result?: { thread?: Thread }) => void }) {
  const [text, setText] = useState(''); const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const scope = `${auth.userId}:${path}:${updateId || ''}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const { busy, error, submit } = useSubmit(async () => {
    if (disabled) return;
    const result = await save<{ thread?: Thread }>(auth, path, { text, clientId, ...(updateId ? { updateId } : {}) });
    if (!mounted.current || currentScope.current !== scope) return;
    setText(''); setClientId(crypto.randomUUID()); onSaved(result);
  });
  return <form className="school-form communication-reply" onSubmit={submit}><label>{label}<textarea required rows={2} maxLength={2000} value={text} disabled={busy || disabled} onChange={(event) => setText(event.target.value)} /></label><ErrorText error={error} /><button className="button secondary" disabled={busy || disabled || !text.trim()}>{busy ? 'Sending…' : button}</button></form>;
}

function Acknowledgements({ items, version, childName, parentView, timeZone }: { items: Acknowledgement[]; version: number; childName: string; parentView: boolean; timeZone: string }) {
  return items.length ? <div className="family-acknowledgements">{[...items].sort((a, b) => a.sequence - b.sequence).map(ack => <p key={`${ack.sequence}:${ack.updateVersion}`}>
    <strong>{parentView ? 'You acknowledged this' : `Acknowledged by ${ack.parentName}`}</strong> · {friendlySchoolTimestamp(ack.acknowledgedAt, timeZone)}
    <small>{parentView ? '' : `${childName}’s parent`}{ack.updateVersion !== version ? `${parentView ? '' : ' · '}Earlier revision ${ack.updateVersion}` : ''}</small>
  </p>)}</div> : null;
}

function ReadError({ error, retry }: { error: string; retry: () => void }) {
  return error ? <div className="family-read-error"><p className="school-help">Could not mark this as read: {error}</p><button className="text-button" onClick={retry}>Try marking as read again</button></div> : null;
}

function Threads({ path, revision, onChanged, onRead, timeZone, ...auth }: Auth & { path: string; timeZone: string; revision: number; onChanged: () => void; onRead: () => void }) {
  const { data, error } = useRead<{ threads: Thread[] }>(auth, `${path}/threads`, revision, true); const [threadId, setThreadId] = useState('');
  const [readThrough, setReadThrough] = useState<Record<string, number>>({});
  const threads = [...(data?.threads || [])].sort((a, b) => (b.latestActivityAt || b.createdAt).localeCompare(a.latestActivityAt || a.createdAt));
  return <section className="private-threads"><h3>Private teacher–parent conversations</h3><p className="school-help">Each conversation is private to the named parent and the teacher who wrote the update. New replies appear here within about a minute.</p><ErrorText error={error} />
    {!data && !error ? <p className="school-help" role="status">Loading private conversations…</p> : data && !threads.length ? <p className="school-help">No private conversations yet. A parent can acknowledge or reply to a family update.</p> : <div className="communication-feed">{threads.map(thread => <article className="communication-entry private-thread-entry" key={thread.id}>
      <div className="communication-meta"><strong>{thread.parentName} · {thread.childName}’s parent</strong><NewActivity count={thread.observedSequence > (readThrough[thread.id] || 0) ? thread.unreadCount : 0} /></div>
      <p className="communication-text" lang={thread.update.assistance?.language}>{thread.update.text}</p><PublishedAssistance assistance={thread.update.assistance} />
      <small>{thread.teacherName} · {friendlySchoolTimestamp(thread.latestActivityAt || thread.createdAt, timeZone)}</small>
      <button className="text-button family-reply-button" aria-expanded={threadId === thread.id} onClick={() => setThreadId(threadId === thread.id ? '' : thread.id)}>{threadId === thread.id ? 'Close conversation' : 'Open private conversation'}</button>
      {threadId === thread.id && <ThreadMessages key={thread.id} {...auth} path={`${path}/threads/${thread.id}/messages`} revision={revision} onChanged={onChanged} onRead={sequence => { setReadThrough(previous => ({ ...previous, [thread.id]: Math.max(previous[thread.id] || 0, sequence || 0) })); onRead(); }} timeZone={timeZone} role="teacher" showUpdate={false} />}
    </article>)}</div>}
  </section>;
}

function ThreadMessages({ path, revision, onChanged, onRead, timeZone, role, showUpdate = true, composer = true, ...auth }: Auth & { path: string; timeZone: string; revision: number; onChanged: () => void; onRead: (sequence?: number) => void; role: 'parent' | 'teacher'; showUpdate?: boolean; composer?: boolean }) {
  const { data, error } = useRead<{ thread: Thread; messages: Reply[] }>(auth, path, revision, true);
  const read = useRenderedRead(auth, path.replace(/\/messages$/, '/read'), 'observedSequence', data?.thread.observedSequence || 0, Boolean(data), onRead);
  return <div className="thread-messages"><ErrorText error={error} />{!data && !error && <p className="school-help" role="status">Opening private conversation…</p>}{data && <>
    {showUpdate && <><blockquote lang={data.thread.update.assistance?.language}>{data.thread.update.text}</blockquote><PublishedAssistance assistance={data.thread.update.assistance} /></>}
    <Acknowledgements items={data.thread.acknowledgements || []} version={data.thread.update.version} childName={data.thread.childName} parentView={role === 'parent'} timeZone={timeZone} />
    {data.messages.length === 0 && <p className="school-help">No private messages yet.</p>}
    {[...data.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.sequence || 0) - (b.sequence || 0)).map(reply => <div className={`communication-message ${reply.authorRole}`} key={reply.id}>
      <div className="communication-meta"><strong>{reply.authorName}{reply.authorRole === 'parent' ? ` · ${data.thread.childName}’s parent` : ''}</strong>{reply.isUnread && (reply.sequence || 0) > read.read && <NewActivity count={1} />}</div>
      <small>{friendlySchoolTimestamp(reply.createdAt, timeZone)}</small><p>{reply.text}</p>
    </div>)}
    <ReadError error={read.error} retry={read.retry} />
    {composer && <TextReply key={path} {...auth} path={path} label="Private reply" button="Send private reply" onSaved={onChanged} />}
  </>}</div>;
}

function ParentUpdate({ update, child, path, thread, revision, initiallyOpen, onChanged, onRead, canReply, ...auth }: Auth & { update: FamilyUpdate; child: LinkedChild; path: string; thread?: Thread; revision: number; initiallyOpen: boolean; onChanged: () => void; onRead: () => void; canReply: boolean }) {
  const [open, setOpen] = useState(initiallyOpen); const [createdThread, setCreatedThread] = useState<Thread | null>(null);
  const [readThrough, setReadThrough] = useState(0);
  const [acknowledging, setAcknowledging] = useState(false); const [ackError, setAckError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), [auth.userId, path, update.id]);
  const read = useRenderedRead(auth, `${path}/updates/${update.id}/read`, 'observedVersion', update.observedVersion || update.version, open, onRead);
  const activeThread = createdThread && (!thread || createdThread.observedSequence >= thread.observedSequence) ? createdThread : thread;
  const threadId = activeThread?.id || update.threadId;
  const currentAck = [update.acknowledgement, activeThread?.acknowledgement].find(ack => ack?.updateVersion === update.version);
  async function acknowledge() {
    if (pending.current || !canReply || currentAck) return;
    const abort = new AbortController(); pending.current = abort; setAcknowledging(true); setAckError('');
    try {
      const result = await request<{ thread: Thread; acknowledgement: Acknowledgement }>(auth.config, `${path}/updates/${update.id}/acknowledgement`, { authenticated: true, expectedUserId: auth.userId, signal: abort.signal, method: 'POST', body: { observedVersion: update.observedVersion || update.version } });
      if (!abort.signal.aborted) { setCreatedThread(result.thread); onChanged(); }
    } catch (issue) { if (!abort.signal.aborted) setAckError(message(issue)); }
    finally { if (!abort.signal.aborted) setAcknowledging(false); pending.current = null; }
  }
  return <>
    <div className="communication-meta"><span className="school-role">{update.audience === 'class' ? 'Class update' : `Feedback for ${child.name}`}</span><NewActivity count={(update.isUnread && (update.observedVersion || update.version) > read.read ? 1 : 0) + ((thread?.observedSequence || 0) > readThrough ? thread?.unreadCount || 0 : 0)} /></div>
    <p className="communication-text" lang={update.assistance?.language}>{update.text}</p><PublishedAssistance assistance={update.assistance} /><small>{update.authorName} · {friendlySchoolTimestamp(update.updatedAt, child.timeZone)}</small>
    <button className="text-button family-reply-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Close conversation' : 'Open update & private replies'}</button>
    {open && <div className="family-update-conversation">
      <ReadError error={read.error} retry={read.retry} />
      {!canReply && <p className="school-help">Add your name above to acknowledge updates and send private replies.</p>}
      {!currentAck && <button className="button secondary family-ack-button" onClick={acknowledge} disabled={acknowledging || !canReply}>{acknowledging ? 'Acknowledging…' : 'Acknowledge'}</button>}
      <ErrorText error={ackError} />
      {threadId && <ThreadMessages key={threadId} {...auth} path={`${path}/threads/${threadId}/messages`} timeZone={child.timeZone} revision={revision} onChanged={onChanged} onRead={sequence => { setReadThrough(previous => Math.max(previous, sequence || 0)); onRead(); }} role="parent" showUpdate={false} composer={false} />}
      <TextReply key={update.id} {...auth} path={`${path}/threads`} updateId={update.id} label="Your private reply" button="Send to teacher" disabled={!canReply} onSaved={result => { if (result?.thread) setCreatedThread(result.thread); onChanged(); }} />
    </div>}
  </>;
}

export function FamilyCommunication({ child, role, requestedUpdateId, canReply = false, onActivity, ...auth }: Auth & { child: LinkedChild; role: 'parent' | 'student'; requestedUpdateId?: string; canReply?: boolean; onActivity: () => void }) {
  const [revision, setRevision] = useState(0); const refresh = () => { setRevision(value => value + 1); onActivity(); };
  const [showAll, setShowAll] = useState(false); const requestedEntry = useRef<HTMLElement | null>(null); const focusedUpdate = useRef('');
  const path = `/school/family/${role}/${child.schoolId}/${child.classId}/${child.id}`;
  const { data, error } = useRead<{ updates: FamilyUpdate[] }>(auth, `${path}/updates`, revision, true);
  const threads = useRead<{ threads: Thread[] }>(auth, role === 'parent' ? `${path}/threads` : null, revision, true);
  const target = requestedUpdateId && !showAll ? requestedUpdateId : undefined;
  const updates = data?.updates.filter(update => !target || update.id === target);
  useEffect(() => {
    if (!target || !data?.updates.some(update => update.id === target) || focusedUpdate.current === target) return;
    focusedUpdate.current = target; requestedEntry.current?.focus({ preventScroll: true }); requestedEntry.current?.scrollIntoView({ block: 'start' });
  }, [data, target]);
  return <section className="school-card family-communication">
    <div className="school-list-heading"><h3>{child.name} · {target ? 'Teacher update' : 'Classroom updates'}</h3><button className="text-button" onClick={refresh}>Refresh updates</button></div>
    <ErrorText error={error || threads.error} />
    {!data && !error ? <p className="school-help" role="status">Opening classroom updates…</p> : updates?.length === 0 ? <p className={target ? 'school-warning' : 'school-help'} role={target ? 'alert' : undefined}>{target ? 'This update is unavailable for your current family connection.' : 'Your teacher’s class updates and individual feedback will appear here.'}</p> : <div className="communication-feed">{updates?.map(update => <article className={`communication-entry${target ? ' family-requested-update' : ''}`} key={update.id} ref={target ? requestedEntry : undefined} tabIndex={target ? -1 : undefined}>
      {role === 'parent' ? <ParentUpdate {...auth} update={update} child={child} path={path} thread={threads.data?.threads.find(thread => thread.update.id === update.id)} revision={revision} initiallyOpen={Boolean(target)} onChanged={refresh} onRead={onActivity} canReply={canReply} /> : <><span className="school-role">{update.audience === 'class' ? 'Class update' : `Feedback for ${child.name}`}</span><p className="communication-text" lang={update.assistance?.language}>{update.text}</p><PublishedAssistance assistance={update.assistance} /><small>{update.authorName} · {friendlySchoolTimestamp(update.updatedAt, child.timeZone)}</small></>}
    </article>)}</div>}
    {target && <button className="text-button family-show-all" type="button" onClick={() => setShowAll(true)}>Show all classroom updates</button>}
  </section>;
}
