import { useEffect, useRef, useState, type FormEvent } from 'react';
import { request } from '../api';
import { TeacherLogGuidance } from '../guidance/TeacherLogGuidance';
import { friendlySchoolDate, friendlySchoolTimestamp } from './dates';
import type { Config, Language } from '../types';
import type { LinkedChild, RosterStudent } from './types';
import { ParentNoteDraft, parentNoteActivityHref, type ParentNoteActivity, type ParentNoteResult } from './ParentNoteDraft';

type Auth = { config: Config; userId: string };
type Log = { id: string; authorId: string; authorName: string; subject: string; note: string; version: number; localDate: string; timeZone: string; createdAt: string; updatedAt: string; guidance: { status: string; message?: string } };
type Assistance = { draftId: string; draftVersion: number; language: Language; activity: ParentNoteActivity };
type FamilyUpdate = { canEdit?: boolean; id: string; authorName: string; audience: 'class' | 'student'; studentId: string | null; text: string; logId: string | null; version: number; createdAt: string; updatedAt: string; assistance?: Assistance };
type Thread = { id: string; childId: string; childName: string; teacherName: string; update: FamilyUpdate; createdAt: string };
type Reply = { id: string; text: string; authorName: string; authorRole: 'parent' | 'teacher'; createdAt: string };
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

function useRead<T>(auth: Auth, path: string, revision: number) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController(); setData(null); setError('');
    request<T>(auth.config, path, { authenticated: true, expectedUserId: auth.userId, signal: abort.signal }).then(setData).catch((issue) => { if (issue.name !== 'AbortError') setError(message(issue)); });
    return () => abort.abort();
  }, [auth.config, auth.userId, path, revision]);
  return { data, error };
}
async function save<T>(auth: Auth, path: string, body: unknown, method: 'POST' | 'PUT' = 'POST') {
  return request<T>(auth.config, path, { authenticated: true, expectedUserId: auth.userId, method, body });
}
function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await action(); } catch (issue) { setError(message(issue)); } finally { setBusy(false); } }
  return { busy, error, submit };
}

export function ClassCommunication({ config, userId, classPath, subject, admin, timeZone }: Auth & { classPath: string; subject: string; admin: boolean; timeZone: string }) {
  const [tab, setTab] = useState<'logs' | 'updates' | 'threads'>('logs'); const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  return <section className="class-communication">
    <div className="school-list-heading"><h3>Classroom & home</h3><button className="text-button" onClick={refresh}>Refresh updates</button></div>
    <nav className="communication-tabs" aria-label="Classroom communication">{(['logs', 'updates', 'threads'] as const).map((item) => <button key={item} aria-pressed={tab === item} onClick={() => setTab(item)}>{item === 'logs' ? 'Classroom notes' : item === 'updates' ? 'Family updates' : 'Private replies'}</button>)}</nav>
    {tab === 'logs' ? <StaffLogs timeZone={timeZone} config={config} userId={userId} classPath={classPath} subject={subject} admin={admin} revision={revision} onChanged={refresh} /> : tab === 'updates' ? <StaffUpdates timeZone={timeZone} config={config} userId={userId} classPath={classPath} revision={revision} onChanged={refresh} /> : <Threads timeZone={timeZone} config={config} userId={userId} path={classPath} revision={revision} onChanged={refresh} />}
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

function StaffUpdates({ classPath, revision, onChanged, timeZone, ...auth }: Auth & { classPath: string; timeZone: string; revision: number; onChanged: () => void }) {
  const { data, error } = useRead<{ updates: FamilyUpdate[] }>(auth, `${classPath}/updates`, revision); const roster = useRead<{ students: RosterStudent[] }>(auth, `${classPath}/roster`, revision);
  const [editing, setEditing] = useState<FamilyUpdate | null>(null); const [notice, setNotice] = useState('');
  return <>
    <p className="school-help">Publish an announcement to the class or feedback to one child and their linked parents. Parents can reply privately to the author.</p>
    <UpdateForm key={editing ? `${editing.id}:${editing.version}` : 'new'} {...auth} classPath={classPath} students={roster.data?.students || []} record={editing || undefined} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice('Family update published to its selected audience.'); onChanged(); }} />
    {notice && <p className="notice" role="status">{notice}</p>}<ErrorText error={error || roster.error} />
    {!data && !error ? <p className="school-help" role="status">Loading family updates…</p> : data?.updates.length === 0 ? <p className="school-help">No family updates yet.</p> : <div className="communication-feed">{data?.updates.map((update) => <article className="communication-entry" key={update.id}><span className="school-role">{update.audience === 'class' ? 'Whole class' : roster.data?.students.find((student) => student.id === update.studentId)?.name || 'Individual child'}</span><p className="communication-text" lang={update.assistance?.language}>{update.text}</p><PublishedAssistance assistance={update.assistance} /><div className="communication-meta"><span>{update.authorName} · {friendlySchoolTimestamp(update.updatedAt, timeZone)}</span>{update.canEdit && <button className="text-button" onClick={() => setEditing(update)}>Correct update</button>}</div></article>)}</div>}
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

function TextReply({ path, label, button, updateId, onSaved, ...auth }: Auth & { path: string; label: string; button: string; updateId?: string; onSaved: () => void }) {
  const [text, setText] = useState(''); const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const { busy, error, submit } = useSubmit(async () => { await save(auth, path, { text, clientId, ...(updateId ? { updateId } : {}) }); setText(''); setClientId(crypto.randomUUID()); onSaved(); });
  return <form className="school-form communication-reply" onSubmit={submit}><label>{label}<textarea required rows={2} maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} /></label><ErrorText error={error} /><button className="button secondary" disabled={busy}>{busy ? 'Sending…' : button}</button></form>;
}
function Threads({ path, revision, onChanged, timeZone, ...auth }: Auth & { path: string; timeZone: string; revision: number; onChanged: () => void }) {
  const { data, error } = useRead<{ threads: Thread[] }>(auth, `${path}/threads`, revision); const [threadId, setThreadId] = useState('');
  const selected = data?.threads.find((item) => item.id === threadId);
  return <section className="private-threads"><h3>Private teacher–parent conversations</h3><p className="school-help">Only the linked parent account and the relevant teacher can read these replies. Other families and staff cannot open them.</p><ErrorText error={error} />{!data && !error ? <p className="school-help" role="status">Loading private conversations…</p> : !data?.threads.length ? <p className="school-help">No private conversations yet. A parent can start a reply from a family update.</p> : <><nav className="thread-picker" aria-label="Private conversations">{data.threads.map((thread) => <button key={thread.id} className={selected?.id === thread.id ? 'selected' : ''} onClick={() => setThreadId(thread.id)}><strong>{thread.childName} · {thread.teacherName}</strong><span>{thread.update.text.slice(0, 90)}</span></button>)}</nav>{selected && <ThreadMessages timeZone={timeZone} key={selected.id} {...auth} path={`${path}/threads/${selected.id}/messages`} revision={revision} onChanged={onChanged} />}</>}</section>;
}
function ThreadMessages({ path, revision, onChanged, timeZone, ...auth }: Auth & { path: string; timeZone: string; revision: number; onChanged: () => void }) {
  const { data, error } = useRead<{ thread: Thread; messages: Reply[] }>(auth, path, revision);
  return <div className="thread-messages"><ErrorText error={error} />{!data && !error && <p className="school-help" role="status">Opening private conversation…</p>}{data && <><blockquote lang={data.thread.update.assistance?.language}>{data.thread.update.text}</blockquote><PublishedAssistance assistance={data.thread.update.assistance} />{data.messages.map((reply) => <div className={`communication-message ${reply.authorRole}`} key={reply.id}><small>{reply.authorName} · {friendlySchoolTimestamp(reply.createdAt, timeZone)}</small><p>{reply.text}</p></div>)}<TextReply {...auth} path={path} label="Private reply" button="Send private reply" onSaved={onChanged} /></>}</div>;
}

export function FamilyCommunication({ child, role, ...auth }: Auth & { child: LinkedChild; role: 'parent' | 'student' }) {
  const [revision, setRevision] = useState(0); const [replyId, setReplyId] = useState(''); const refresh = () => setRevision((value) => value + 1);
  const path = `/school/family/${role}/${child.schoolId}/${child.classId}/${child.id}`;
  const timeZone = child.timeZone;
  const { data, error } = useRead<{ updates: FamilyUpdate[] }>(auth, `${path}/updates`, revision);
  return <section className="school-card family-communication"><div className="school-list-heading"><h3>{child.name} · Classroom updates</h3><button className="text-button" onClick={refresh}>Refresh updates</button></div><ErrorText error={error} />{!data && !error ? <p className="school-help" role="status">Opening classroom updates…</p> : data?.updates.length === 0 ? <p className="school-help">Your teacher’s class updates and individual feedback will appear here.</p> : <div className="communication-feed">{data?.updates.map((update) => <article className="communication-entry" key={update.id}><span className="school-role">{update.audience === 'class' ? 'Class update' : `Feedback for ${child.name}`}</span><p className="communication-text" lang={update.assistance?.language}>{update.text}</p><PublishedAssistance assistance={update.assistance} /><small>{update.authorName} · {friendlySchoolTimestamp(update.updatedAt, timeZone)}</small>{role === 'parent' && <><button className="text-button family-reply-button" onClick={() => setReplyId(replyId === update.id ? '' : update.id)}>{replyId === update.id ? 'Close reply' : 'Reply privately to teacher'}</button>{replyId === update.id && <TextReply key={update.id} {...auth} path={`${path}/threads`} updateId={update.id} label="Your private reply" button="Send to teacher" onSaved={() => { setReplyId(''); refresh(); }} />}</>}</article>)}</div>}{role === 'parent' && <Threads timeZone={timeZone} {...auth} path={path} revision={revision} onChanged={refresh} />}</section>;
}
