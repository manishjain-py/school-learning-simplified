import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, GraduationCap, HeartHandshake, ListChecks, Plus, RefreshCw, School as SchoolIcon, Users, X } from 'lucide-react';
import { ApiError, request } from '../api';
import type { Config, User } from '../types';
import type { LinkedChild, MutationResult, RosterStudent, SchoolClass, SchoolDetail, Teacher, Workspaces } from './types';
import './school.css';
import '../reports/reports.css';
import { ClassCommunication, FamilyCommunication } from './Communication';
import { ParentGuidance, useParentGuidance } from '../guidance/ParentGuidance';
import { linkedUpdateChild, type ParentUpdateLink } from './parentUpdateLink';

type Props = { config: Config; user: User | null; onSignIn: () => void; parentUpdateLink?: ParentUpdateLink };
type Context = 'staff' | 'student' | 'parent';
type Save = (path: string, body: unknown, method?: 'POST' | 'PUT') => Promise<void>;
const base = '/school/schools';
const encoded = encodeURIComponent;
const message = (issue: unknown) => issue instanceof Error ? issue.message : 'This update could not be saved. Please try again.';

function useFormSave(save: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await save(); } catch (issue) { setError(message(issue)); } finally { setBusy(false); }
  }
  return { busy, error, submit };
}

function FormError({ error }: { error: string }) {
  return error ? <p className="form-error" role="alert">{error}</p> : null;
}

export function SchoolWorkspace({ config, user, onSignIn, parentUpdateLink = { kind: 'none' } }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspaces | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [schoolId, setSchoolId] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const userId = user?.id;
  useEffect(() => {
    setWorkspaces(null); setSchoolId(''); setContext(null); setCreating(false); setNotice('');
  }, [userId]);
  useEffect(() => {
    if (!userId) return;
    const abort = new AbortController();
    setError(''); setExpired(false);
    request<Workspaces>(config, '/school/workspaces', { authenticated: true, expectedUserId: userId, signal: abort.signal }).then((data) => {
      if (abort.signal.aborted) return;
      setWorkspaces(data);
      setSchoolId((current) => data.staff.some((item) => item.school.id === current) ? current : data.staff[0]?.school.id || '');
    }).catch((issue) => {
      if (issue.name === 'AbortError') return;
      setWorkspaces(null); setError(message(issue));
      setExpired(issue instanceof ApiError && issue.status === 401);
    });
    return () => abort.abort();
  }, [config, userId, revision]);

  const refresh = () => setRevision((value) => value + 1);
  const activeContext = context || (parentUpdateLink.kind !== 'none' || (workspaces && !workspaces.staff.length && workspaces.family.student.status === 'missing' && workspaces.family.parent.children.length) ? 'parent' : 'staff');
  return <main className="school-workspace page-width">
    <div className="school-heading"><div><p className="eyebrow">SCHOOL & HOME, TOGETHER</p><h1>A place to grow together.</h1><p>Connect your classroom and family with the right school records.</p></div><span className="school-heading-icon"><GraduationCap size={38} strokeWidth={1.4} /></span></div>
    {!user ? <section className="school-welcome">
      <div><span className="school-label">YOUR SCHOOL WORKSPACE</span><h2>Start with a connection.</h2><p>Register a school, manage your classes or see your family’s school links. Use your own email account and verify it to get started.</p><button className="button primary" onClick={onSignIn}>Sign in or create an account<ArrowRight size={17} /></button><a className="school-library-link" href="/">Keep exploring the learning library</a></div>
      <div className="school-welcome-steps"><div><SchoolIcon size={22} /><span><strong>Schools</strong>Register your workspace and add teachers and classes.</span></div><div><Users size={22} /><span><strong>Students</strong>Sign in with the verified email your school records.</span></div><div><HeartHandshake size={22} /><span><strong>Parents</strong>Use your separate, verified parent email to link your children.</span></div></div>
    </section> : <>
      <div className="school-account-bar"><span><Check size={15} />Verified account<span className="school-account-email">{user.email}</span></span><button className="text-button" onClick={refresh} aria-label="Refresh school connections"><RefreshCw size={14} />Refresh</button></div>
      <nav className="school-contexts" aria-label="Choose your school role">{(['staff', 'student', 'parent'] as const).map((item) => <button key={item} type="button" aria-pressed={activeContext === item} onClick={() => { setContext(item); setNotice(''); }}>{item === 'staff' ? <SchoolIcon size={17} /> : item === 'student' ? <BookOpen size={17} /> : <HeartHandshake size={17} />}{item === 'staff' ? 'School staff' : item === 'student' ? 'Student' : 'Parent'}</button>)}</nav>
      {error ? <div className="school-empty"><FormError error={error} /><button className="button secondary" onClick={expired ? onSignIn : refresh}>{expired ? 'Sign in again' : 'Try again'}</button></div> : !workspaces ? <p className="school-empty" role="status">Finding your school connections…</p> : <>
        {notice && <div className="school-status notice" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss saved update" onClick={() => setNotice('')}><X size={16} /></button></div>}
        {activeContext === 'staff' ? <>
          <div className="school-workspace-picker"><label>School workspace<select value={schoolId} onChange={(event) => { setSchoolId(event.target.value); setNotice(''); }} disabled={workspaces.staff.length === 0}><option value="" disabled>{workspaces.staff.length ? 'Choose a school' : 'No staff membership yet'}</option>{workspaces.staff.map(({ school, role }) => <option key={school.id} value={school.id}>{school.name} · {role === 'admin' ? 'Administrator' : 'Teacher'}</option>)}</select></label><button className="button secondary" onClick={() => setCreating((value) => !value)} aria-expanded={creating}>{creating ? <X size={16} /> : <Plus size={16} />}{creating ? 'Close registration' : 'Register a school'}</button></div>
          {creating && <NewSchool config={config} onCancel={() => setCreating(false)} onCreated={(id) => { setSchoolId(id); setCreating(false); setNotice('Your school is ready. You are its administrator.'); refresh(); }} />}
          {schoolId ? <SchoolPanel key={`${user.id}:${schoolId}`} config={config} userId={user.id} schoolId={schoolId} revision={revision} onChanged={(text) => { setNotice(text); refresh(); }} /> : !creating && <section className="school-empty"><SchoolIcon size={29} /><h2>Your school can start here.</h2><p>Register a new school to become its administrator. If you are a teacher, ask your school administrator to add your verified email and assign your classes.</p><button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />Register a school</button></section>}
        </> : <FamilyPanel key={`${user.id}:${activeContext}`} config={config} userId={user.id} kind={activeContext} family={workspaces.family} revision={revision} parentUpdateLink={parentUpdateLink} />}
      </>}
    </>}
    <aside className="school-next"><span>SCHOOL & HOME</span><p>Classroom notes, family updates and private replies connect school and home. Learning guidance publishes automatically when interpretation succeeds.</p></aside>
  </main>;
}

function NewSchool({ config, onCreated, onCancel }: { config: Config; onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata');
  const { busy, error, submit } = useFormSave(async () => {
    const data = await request<{ school: { id: string } }>(config, base, { authenticated: true, method: 'POST', body: { name: name.trim(), timeZone: timeZone.trim() } });
    onCreated(data.school.id);
  });
  return <form className="school-card school-form" onSubmit={submit}><div className="school-card-heading"><div><p className="eyebrow">A NEW BEGINNING</p><h2>Register your school</h2></div><SchoolIcon size={26} /></div><p className="school-help">You will become this school’s administrator and can add teachers, classes and students.</p><div className="school-form-grid"><label>School name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your school’s name" autoComplete="organization" /></label><label>School time zone<input required maxLength={80} value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="Asia/Kolkata" /><small>For example, Asia/Kolkata. Classroom dates use this time zone.</small></label></div><FormError error={error} /><div className="school-form-actions"><button className="button primary" disabled={busy}>{busy ? 'Creating school…' : 'Create school workspace'}<ArrowRight size={16} /></button><button type="button" className="button secondary" onClick={onCancel} disabled={busy}>Cancel</button></div></form>;
}

function SchoolPanel({ config, userId, schoolId, revision, onChanged }: { config: Config; userId: string; schoolId: string; revision: number; onChanged: (message: string) => void }) {
  const [detail, setDetail] = useState<SchoolDetail | null>(null);
  const [error, setError] = useState('');
  const [classId, setClassId] = useState('');
  const [newClass, setNewClass] = useState(false);
  const [editClass, setEditClass] = useState(false);
  const [teacherForm, setTeacherForm] = useState<Teacher | 'new' | null>(null);
  const [retry, setRetry] = useState(0);
  const schoolPath = `${base}/${encoded(schoolId)}`;
  useEffect(() => {
    const abort = new AbortController(); setError('');
    request<SchoolDetail>(config, schoolPath, { authenticated: true, signal: abort.signal }).then((data) => {
      setDetail(data);
      setClassId((current) => data.classes.some((item) => item.id === current) ? current : data.classes[0]?.id || '');
    }).catch((issue) => { if (issue.name !== 'AbortError') { setDetail(null); setError(message(issue)); } });
    return () => abort.abort();
  }, [config, schoolPath, revision, retry]);
  async function save(path: string, body: unknown, method: 'POST' | 'PUT' = 'PUT') {
    const result = await request<MutationResult>(config, path, { authenticated: true, method, body });
    setNewClass(false); setEditClass(false); setTeacherForm(null);
    onChanged(result.warning || 'School records updated. Account links now use the saved records.');
  }
  if (error) return <div className="school-empty"><FormError error={error} /><button className="button secondary" onClick={() => setRetry((value) => value + 1)}>Reload workspace</button></div>;
  if (!detail) return <p className="school-empty" role="status">Opening your school workspace…</p>;
  const admin = detail.role === 'admin';
  const selected = detail.classes.find((item) => item.id === classId);
  return <section className="school-detail">
    <div className="school-detail-heading"><div><h2>{detail.school.name}</h2><p>{detail.school.timeZone}</p></div><span className="school-role">{admin ? 'Administrator workspace' : 'Assigned teacher workspace'}</span></div>
    <div className="school-columns">
      <aside className="school-class-list"><div className="school-list-heading"><h3>{admin ? 'Classes' : 'Your classes'}</h3><span>{detail.classes.length}</span></div>{detail.classes.length === 0 ? <p className="school-help">{admin ? 'Add the first class to start your roster.' : 'Your administrator has not assigned a class yet.'}</p> : <nav aria-label="School classes">{detail.classes.map((item) => <button key={item.id} aria-current={classId === item.id ? 'true' : undefined} onClick={() => { setClassId(item.id); setEditClass(false); setNewClass(false); }}><span>{item.name}<small>{item.subject}</small></span><ArrowRight size={16} /></button>)}</nav>}{admin && <button className="button secondary full" onClick={() => { setNewClass(true); setEditClass(false); }}><Plus size={15} />Add class</button>}</aside>
      <div className="school-class-content">
        {newClass && admin ? <ClassForm teachers={detail.teachers} schoolPath={schoolPath} save={save} onCancel={() => setNewClass(false)} /> : selected ? <>
          <div className="school-class-heading"><div><p className="eyebrow">{selected.subject}</p><h3>{selected.name}</h3></div>{admin && <button className="text-button" onClick={() => setEditClass((value) => !value)}>{editClass ? 'Close class settings' : 'Edit class & teachers'}</button>}</div>
          {editClass && admin && <ClassForm key={selected.id + ':' + selected.version} record={selected} teachers={detail.teachers} schoolPath={schoolPath} save={save} onCancel={() => setEditClass(false)} />}
          <p className="school-help school-assigned">Assigned teachers: {selected.teacherEmails.length ? selected.teacherEmails.map((email) => detail.teachers.find((item) => item.email === email)?.name || email).join(', ') : 'No teacher assigned yet'}</p>
          <ClassCommunication timeZone={detail.school.timeZone} key={`communication:${selected.id}`} config={config} userId={userId} classPath={`${schoolPath}/classes/${encoded(selected.id)}`} subject={selected.subject} admin={admin} />
          <Roster key={selected.id} config={config} classPath={`${schoolPath}/classes/${encoded(selected.id)}`} admin={admin} revision={revision} save={save} />
        </> : <div className="school-empty school-empty-small"><GraduationCap size={31} /><h3>A classroom belongs here.</h3><p>{admin ? 'Add a class, assign its teachers and record each student’s own email.' : 'Your assigned classes will appear here.'}</p></div>}
      </div>
    </div>
    {admin && <section className="school-card school-teachers"><div className="school-card-heading"><div><p className="eyebrow">YOUR SCHOOL TEAM</p><h2>Teachers</h2></div><button className="button secondary" onClick={() => setTeacherForm('new')}><Plus size={16} />Add teacher</button></div><p className="school-help">Add the email each teacher will verify on their own account, then assign them to a class.</p>{teacherForm && <TeacherForm key={teacherForm === 'new' ? 'new' : teacherForm.email} record={teacherForm === 'new' ? undefined : teacherForm} schoolPath={schoolPath} save={save} onCancel={() => setTeacherForm(null)} />}{!detail.teachers.length ? <p className="school-help">No teachers added yet. Administrators can manage every class in this school.</p> : <ul className="school-people">{detail.teachers.map((teacher) => <li key={teacher.email}><span className="school-person-icon"><Users size={18} /></span><div><strong>{teacher.name}</strong><small>{teacher.email}</small></div><button className="text-button" onClick={() => setTeacherForm(teacher)}>Edit teacher</button></li>)}</ul>}</section>}
  </section>;
}

function TeacherForm({ record, schoolPath, save, onCancel }: { record?: Teacher; schoolPath: string; save: Save; onCancel: () => void }) {
  const [name, setName] = useState(record?.name || '');
  const [email, setEmail] = useState(record?.email || '');
  const [removing, setRemoving] = useState(false);
  const { busy, error, submit } = useFormSave(() => save(`${schoolPath}/teachers/${encoded(email.trim().toLowerCase())}`, { name: name.trim(), active: !removing, ...(record ? { version: record.version } : {}) }));
  return <form className="school-form school-inset" onSubmit={submit}><h3>{record ? 'Edit teacher' : 'Add a teacher'}</h3><div className="school-form-grid"><label>Teacher name<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} disabled={removing} autoComplete="off" /></label><label>Teacher email<input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} readOnly={Boolean(record)} autoComplete="off" /><small>{record ? 'To change an email, remove this membership and add the new email.' : 'The teacher must sign in with this verified email.'}</small></label></div>{removing && <p className="school-warning">This teacher will lose access to this school and its classes.</p>}<FormError error={error} /><div className="school-form-actions"><button className={`button ${removing ? 'school-danger' : 'primary'}`} disabled={busy}>{busy ? 'Saving…' : removing ? 'Confirm removal' : 'Save teacher'}</button><button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>{record && !removing && <button className="text-button school-remove" type="button" onClick={() => setRemoving(true)} disabled={busy}>Remove teacher</button>}</div></form>;
}

function ClassForm({ record, teachers, schoolPath, save, onCancel }: { record?: SchoolClass; teachers: Teacher[]; schoolPath: string; save: Save; onCancel: () => void }) {
  const [name, setName] = useState(record?.name || '');
  const [subject, setSubject] = useState(record?.subject || '');
  const [teacherEmails, setTeacherEmails] = useState((record?.teacherEmails || []).filter((email) => teachers.some((teacher) => teacher.email === email)));
  const { busy, error, submit } = useFormSave(() => save(`${schoolPath}/classes${record ? `/${encoded(record.id)}` : ''}`, { name: name.trim(), subject: subject.trim(), teacherEmails, ...(record ? { version: record.version } : {}) }, record ? 'PUT' : 'POST'));
  return <form className="school-card school-form" onSubmit={submit}><h3>{record ? 'Class settings' : 'Add a class'}</h3><div className="school-form-grid"><label>Class name<input required maxLength={100} placeholder="For example, Class 4 A" value={name} onChange={(event) => setName(event.target.value)} /></label><label>Subject<input required maxLength={100} placeholder="For example, Environmental Studies" value={subject} onChange={(event) => setSubject(event.target.value)} /></label></div><fieldset className="school-checks"><legend>Assigned teachers</legend>{teachers.length ? teachers.map((teacher) => <label key={teacher.email}><input type="checkbox" checked={teacherEmails.includes(teacher.email)} onChange={(event) => setTeacherEmails((current) => event.target.checked ? [...current, teacher.email] : current.filter((email) => email !== teacher.email))} /><span>{teacher.name}<small>{teacher.email}</small></span></label>) : <p className="school-help">You can create this class now and add teachers below.</p>}</fieldset><FormError error={error} /><div className="school-form-actions"><button className="button primary" disabled={busy}>{busy ? 'Saving class…' : record ? 'Save class settings' : 'Create class'}</button><button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button></div></form>;
}

function Roster({ config, classPath, admin, revision, save }: { config: Config; classPath: string; admin: boolean; revision: number; save: Save }) {
  const [students, setStudents] = useState<RosterStudent[] | null>(null);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<RosterStudent | 'new' | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setError('');
    request<{ students: RosterStudent[] }>(config, `${classPath}/roster`, { authenticated: true, signal: abort.signal }).then((data) => setStudents(data.students)).catch((issue) => { if (issue.name !== 'AbortError') { setStudents(null); setError(message(issue)); } });
    return () => abort.abort();
  }, [config, classPath, revision, retry]);
  const saveRoster: Save = async (path, body, method) => { await save(path, body, method); setEditor(null); };
  return <section className="school-roster"><div className="school-list-heading"><h3>Student roster{students && <span>{students.length}</span>}</h3>{admin && <button className="button secondary" onClick={() => setEditor('new')}><Plus size={15} />Add student</button>}</div><p className="school-help">Each student uses their own verified school email. Parents use separate verified accounts with the emails recorded here.</p>{editor && admin && <StudentForm key={editor === 'new' ? 'new' : editor.id} record={editor === 'new' ? undefined : editor} classPath={classPath} save={saveRoster} onCancel={() => setEditor(null)} />}{error ? <><FormError error={error} /><button className="text-button" onClick={() => setRetry((value) => value + 1)}>Reload roster</button></> : !students ? <p className="school-help" role="status">Loading this class’s students…</p> : !students.length ? <div className="school-roster-empty"><Users size={25} /><p>No students recorded yet.</p></div> : <ul className="school-roster-list">{students.map((student) => <li key={student.id}><div className="school-roster-name"><strong>{student.name}</strong>{admin && <button className="text-button" onClick={() => setEditor(student)}>Edit student</button>}</div><dl><div><dt>Student account</dt><dd>{student.studentEmail}</dd></div><div><dt>Parent {student.parentEmails.length === 1 ? 'account' : 'accounts'}</dt><dd>{student.parentEmails.length ? student.parentEmails.join(', ') : 'No parent email recorded'}</dd></div></dl></li>)}</ul>}</section>;
}

function StudentForm({ record, classPath, save, onCancel }: { record?: RosterStudent; classPath: string; save: Save; onCancel: () => void }) {
  const [name, setName] = useState(record?.name || '');
  const [studentEmail, setStudentEmail] = useState(record?.studentEmail || '');
  const [parentEmails, setParentEmails] = useState(record?.parentEmails.join('\n') || '');
  const [removing, setRemoving] = useState(false);
  const { busy, error, submit } = useFormSave(async () => {
    const parents = [...new Set(parentEmails.split(/[\n,;]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
    if (!removing && (parents.length < 1 || parents.length > 4)) throw new Error('Record between one and four parent email addresses.');
    if (!removing && parents.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Check each parent email address.');
    if (!removing && parents.includes(studentEmail.trim().toLowerCase())) throw new Error('The student and parent must use separate email accounts.');
    await save(`${classPath}/roster${record ? `/${encoded(record.id)}` : ''}`, removing ? { active: false, version: record!.version } : { name: name.trim(), studentEmail: studentEmail.trim().toLowerCase(), parentEmails: parents, ...(record ? { version: record.version } : {}) }, record ? 'PUT' : 'POST');
  });
  return <form className="school-form school-inset" onSubmit={submit}><h3>{record ? 'Correct student records' : 'Add a student'}</h3><div className="school-form-grid"><label>Student name<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} disabled={removing} autoComplete="off" /></label><label>Student school email<input required type="email" maxLength={254} value={studentEmail} onChange={(event) => setStudentEmail(event.target.value)} disabled={removing} autoComplete="off" /></label></div><label>Parent emails<textarea rows={2} value={parentEmails} onChange={(event) => setParentEmails(event.target.value)} disabled={removing} placeholder="One parent email per line" /><small>Record one to four separate parent emails, using a new line or comma between them. A parent can be linked to more than one child.</small></label><p className="school-help">{removing ? 'Removing this record ends its student and parent links.' : record ? 'Saving corrected emails removes the old account links. Check each address carefully.' : 'If a student email matches more than one roster record, student access pauses until the school corrects the duplicate.'}</p><FormError error={error} /><div className="school-form-actions"><button className={`button ${removing ? 'school-danger' : 'primary'}`} disabled={busy}>{busy ? 'Saving…' : removing ? 'Confirm removal' : record ? 'Save corrections' : 'Add student'}</button><button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>{record && !removing && <button className="text-button school-remove" type="button" onClick={() => setRemoving(true)} disabled={busy}>Remove from roster</button>}</div></form>;
}

function FamilyPanel({ config, userId, kind, family, revision, parentUpdateLink }: { config: Config; userId: string; kind: 'student' | 'parent'; family: Workspaces['family']; revision: number; parentUpdateLink: ParentUpdateLink }) {
  const target = kind === 'parent' && parentUpdateLink.kind === 'target' ? parentUpdateLink.target : null;
  const [selectedId, setSelectedId] = useState(() => target ? `${target.schoolId}:${target.classId}:${target.childId}` : '');
  const links = family[kind];
  const guidance = useParentGuidance(config, userId, links.children, kind === 'parent', revision);
  const ambiguous = kind === 'student' && family.student.status === 'ambiguous';
  const requestedChild = target ? linkedUpdateChild(target, links.children) : undefined;
  const unavailable = kind === 'parent' && (parentUpdateLink.kind === 'invalid' || (Boolean(target) && !requestedChild));
  const selectedChild = links.children.find(child => `${child.schoolId}:${child.classId}:${child.id}` === selectedId);
  const requestedUpdateId = target && selectedChild === requestedChild ? target.updateId : undefined;
  return <section className="school-family">
    <div className="school-detail-heading"><div><p className="eyebrow">{kind === 'student' ? 'YOUR SCHOOL CONNECTION' : 'YOUR FAMILY CONNECTIONS'}</p><h2>{kind === 'student' ? 'Learning with your school.' : 'Here for their next step.'}</h2></div><span className="school-role">{kind === 'student' ? 'Student workspace' : 'Parent workspace'}</span></div>
    {unavailable && <div className="school-empty school-warning" role="alert"><h3>This family update is unavailable.</h3><p>Sign in with the verified parent account recorded by the school. This link does not provide access to another child’s records.</p></div>}
    {ambiguous ? <div className="school-empty school-warning" role="alert"><h3>Your student email needs a correction.</h3><p>Your verified email matches more than one student record. Ask your school administrator to correct the duplicate before you can access a student workspace.</p><p>You can keep using the learning library while your school resolves the records.</p></div> : links.children.length ? <>
      {selectedChild && requestedUpdateId && <FamilyCommunication key={`${kind}:${selectedId}:${requestedUpdateId}`} config={config} userId={userId} child={selectedChild} role={kind} requestedUpdateId={requestedUpdateId} />}
      <div className={`school-family-grid${kind === 'parent' ? ' parent-family-grid' : ''}`}>{links.children.map((child: LinkedChild) => <article className="school-card school-child" key={`${child.schoolId}:${child.classId}:${child.id}`}>
        <span className="school-child-icon">{kind === 'student' ? <BookOpen size={23} /> : <HeartHandshake size={23} />}</span><span className="school-link-status"><Check size={13} />Connected</span><h3>{child.name}</h3><p>{child.className}<br />{child.schoolName}</p><span className="school-help">{kind === 'student' ? 'Your verified student email matches this school record.' : 'Your verified parent email is recorded for this child.'}</span>
        <button className="button secondary family-open-updates" onClick={() => setSelectedId(`${child.schoolId}:${child.classId}:${child.id}`)}>Open classroom updates</button>
        {kind === 'parent' && <><a className="button secondary family-report-link" href={`/school/report/${encoded(child.schoolId)}/${encoded(child.classId)}/${encoded(child.id)}`}><ListChecks size={16} />View report card<ArrowRight size={16} /></a><ParentGuidance child={child} state={guidance} /></>}
      </article>)}</div>
      {selectedChild && !requestedUpdateId && <FamilyCommunication key={`${kind}:${selectedId}`} config={config} userId={userId} child={selectedChild} role={kind} />}
    </> : !unavailable && <div className="school-empty"><HeartHandshake size={30} /><h3>{kind === 'student' ? 'Your school connection starts with your email.' : 'Your family links will appear here.'}</h3><p>{kind === 'student' ? 'Ask your school to record this account’s email as your student school email. Once it is recorded, refresh this page.' : 'Ask your school to record this account’s email as the parent email for each child. Each student needs a separate account. Once the records are saved, refresh this page.'}</p></div>}
    <a className="button secondary" href={kind === 'parent' ? '/?learn=1' : '/'}>{kind === 'parent' ? 'Learn for myself' : 'Explore the learning library'}<ArrowRight size={16} /></a>
  </section>;
}
