import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import type { AdminGetUserCommandOutput } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createParentEmailService, EMAIL_ATTEMPT_LIMIT, EMAIL_BUDGET_KEY, EMAIL_CUTOFF, EMAIL_PROJECT_LIMIT, parentEmailCommand, parentEmailPublicationChecks, prepareParentEmailRecords, renderParentEmail, type ParentEmailDependencies, type ParentEmailNotification, type ParentEmailSendInput, type ParentEmailUpdate } from './parent-email.js';
import { SchoolError, type Student, type VerifiedAccount } from './index.js';

const schoolId = '11111111-1111-4111-8111-111111111111';
const classId = '22222222-2222-4222-8222-222222222222';
const studentId = '33333333-3333-4333-8333-333333333333';
const updateId = '44444444-4444-4444-8444-444444444444';
const parentId = '55555555-5555-4555-8555-555555555555';
const actor: VerifiedAccount = { id: 'teacher-account', email: 'teacher@example.test', emailVerified: true };
const child: Student = { id: studentId, name: 'Anika Rao', studentEmail: 'anika@example.test', parentEmails: ['parent@example.test'], version: 1, active: true };
const context = { school: { id: schoolId, name: 'Fictional school', adminId: 'admin', timeZone: 'Asia/Kolkata', createdAt: '2026-10-29' }, schoolClass: { id: classId, name: '4B', subject: 'EVS', teacherEmails: [actor.email], version: 1 }, role: 'teacher' as const };
const update: ParentEmailUpdate = { id: updateId, schoolId, classId, authorId: actor.id, authorEmail: actor.email, authorName: 'Teacher', audience: 'student', studentId, text: 'Please explore the day and night activity together.', version: 1, assistance: { language: 'en', activity: { chapterTitle: 'Our Earth' } } };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const notificationId = digest(child.parentEmails[0]);
const rejects = (code: string) => (issue: unknown) => issue instanceof SchoolError && issue.code === code;
const account = (email = child.parentEmails[0]): AdminGetUserCommandOutput => ({ $metadata: {}, Enabled: true, UserStatus: 'CONFIRMED', Username: parentId, UserAttributes: [{ Name: 'sub', Value: parentId }, { Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }] });

function fixture(parentEmails = child.parentEmails) {
  const state = {
    now: new Date('2026-10-29T09:00:00.000Z'), child: structuredClone({ ...child, parentEmails }), context: structuredClone(context), update: structuredClone(update), allowed: true,
    settings: { enabled: true, from: 'updates@schoollearningsimplified.com', poolId: 'us-east-2_fixture', siteUrl: 'https://schoollearningsimplified.com', allowedRecipients: [...parentEmails] },
    budget: 0, accountCalls: [] as { email: string; pool: string }[], sends: [] as ParentEmailSendInput[],
    resolve: async (email: string) => account(email), send: async (_input: ParentEmailSendInput): Promise<{ MessageId?: string }> => ({ MessageId: 'ses-message' }),
    beforeClaim: undefined as (() => void) | undefined, beforeDispatch: undefined as (() => void) | undefined,
    beforeSave: undefined as ((record: ParentEmailNotification) => void) | undefined,
    failureAfterAcceptedCommit: false,
  };
  const records = new Map<string, ParentEmailNotification>();
  const key = (revision: number, id: string) => `${revision}:${id}`;
  for (const operation of prepareParentEmailRecords(state.update, actor, state.child, 'EVS', state.now.toISOString())) {
    const record = operation.Put!.Item as ParentEmailNotification;
    records.set(key(record.revision, record.id), structuredClone(record));
  }
  const stored = (id = notificationId, revision = 1) => records.get(key(revision, id))!;
  function guard(checks: Parameters<ParentEmailDependencies['claim']>[2]) {
    if (!checks.length) return;
    assert(checks.some(item => item.ConditionCheck?.Key?.SK === `UPDATE#${updateId}`));
    if (!state.allowed || !state.child.active || state.child.version !== child.version || state.context.schoolClass.version !== context.schoolClass.version || state.update.version !== update.version) throw new SchoolError(409, 'RECORD_CHANGED', 'Changed');
  }
  const deps: ParentEmailDependencies = {
    authorize: async (user, school, classroom) => { if (!state.allowed || user.id !== actor.id || school !== schoolId || classroom !== classId) throw new SchoolError(403, 'CLASS_ACCESS_DENIED', 'Denied'); return structuredClone(state.context); },
    child: async () => structuredClone(state.child), update: async () => structuredClone(state.update),
    read: async (_school, _classroom, _update, revision, id) => structuredClone(records.get(key(revision, id)) || null),
    list: async (_school, _classroom, _update, revision) => [...records.values()].filter(record => !revision || record.revision === revision).map(record => structuredClone(record)),
    save: async (record, expected, checks = []) => {
      state.beforeSave?.(record);
      if (record.dispatchedAt && record.status === 'sending') state.beforeDispatch?.();
      if (stored(record.id, record.revision)?.version !== expected) throw new SchoolError(409, 'RECORD_CHANGED', 'Changed');
      guard(checks); records.set(key(record.revision, record.id), structuredClone(record));
      if (record.status === 'accepted' && state.failureAfterAcceptedCommit) throw new Error('Lost database acknowledgement');
    },
    claim: async (record, expected, checks) => {
      state.beforeClaim?.();
      if (stored(record.id, record.revision)?.version !== expected) throw new SchoolError(409, 'RECORD_CHANGED', 'Changed');
      guard(checks);
      if (state.budget >= EMAIL_PROJECT_LIMIT) throw new SchoolError(409, 'EMAIL_LIMIT', 'Limit');
      state.budget++; records.set(key(record.revision, record.id), structuredClone(record));
    },
    account: async (email, pool) => { state.accountCalls.push({ email, pool }); return state.resolve(email); },
    send: async input => { state.sends.push(structuredClone(input)); return state.send(input); },
    settings: () => structuredClone(state.settings), now: () => state.now, token: () => 'claim-token',
  };
  const service = createParentEmailService(deps);
  const dispatch = () => service.dispatchPublished(state.update);
  const list = (user = actor) => service.list(user, schoolId, classId, updateId);
  const retry = (id = notificationId, revision = 1, user = actor) => service.retry(user, schoolId, classId, updateId, revision, id);
  const preview = (id = notificationId, revision = 1, user = actor) => service.preview(user, schoolId, classId, updateId, revision, id);
  return { state, records, deps, service, stored, dispatch, list, retry, preview };
}

test('private notification rows are fixed to each revision/recipient and whole-class feedback has none', () => {
  assert.equal(prepareParentEmailRecords({ ...update, audience: 'class', studentId: null }, actor, null, 'EVS', 'now').length, 0);
  const rows = prepareParentEmailRecords(update, actor, { ...child, parentEmails: [' Parent@Example.Test ', 'parent@example.test', 'second@example.test'] }, 'EVS', 'now');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Put!.Item!.id, notificationId); assert.equal(rows[0].Put!.ConditionExpression, 'attribute_not_exists(PK)');
  assert.equal(rows[0].Put!.Item!.attempts, 0);
  const next = prepareParentEmailRecords({ ...update, version: 2 }, actor, child, 'EVS', 'later');
  assert.notEqual(rows[0].Put!.Item!.SK, next[0].Put!.Item!.SK);
  assert.throws(() => prepareParentEmailRecords(update, actor, { ...child, parentEmails: Array.from({ length: 5 }, (_, index) => `parent${index}@example.test`) }, 'EVS', 'now'), rejects('INVALID_PARENTS'));
});

test('rendering escapes all text and preserves Hindi/plain text with the exact canonical family link', () => {
  const rendered = renderParentEmail({ ...update, text: '<script>alert("hi")</script>\nयह शिक्षक का मूल संदेश है।', assistance: { language: 'hi', activity: { chapterTitle: 'Earth <b>' } } }, { ...child, name: 'Anika <img src=x>' }, 'EVS');
  assert(rendered.html.includes('lang="hi"')); assert(rendered.html.includes('&lt;script&gt;')); assert(rendered.html.includes('&lt;img src=x&gt;'));
  assert(!/<script|<img|<iframe|<link/i.test(rendered.html)); assert(!rendered.html.includes('teacher@example.test')); assert(!rendered.html.includes('parent@example.test'));
  assert(rendered.html.includes(`https://schoollearningsimplified.com/school?view=parent&amp;school=${schoolId}&amp;class=${classId}&amp;child=${studentId}&amp;update=${updateId}`));
  assert(rendered.text.includes('<script>alert("hi")</script>\nयह शिक्षक का मूल संदेश है।'));
  assert(rendered.html.includes("default-src 'none'")); assert(rendered.html.includes('ऐप में निजी तौर पर जवाब दें।'));
  assert(renderParentEmail({ ...update, assistance: null }, child, 'EVS').subject.endsWith(': EVS'));
});

test('installed SDK serializes disabled click/open tracking, exact UTF-8 content and one recipient', async () => {
  let body: Record<string, any> | undefined;
  const client = new SESv2Client({ region: 'us-east-2', maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, requestHandler: { handle: async (request: { body: string | Uint8Array }) => {
    body = JSON.parse(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
    return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode('{"MessageId":"fixture"}') } };
  } } });
  const input = { from: 'updates@schoollearningsimplified.com', to: 'parent@example.test', ...renderParentEmail(update, child, 'EVS') };
  await client.send(parentEmailCommand(input)); client.destroy();
  assert.deepEqual(body!.ConfigurationOverrides, { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } });
  assert.deepEqual(body!.Destination, { ToAddresses: [input.to] }); assert.equal(body!.Content.Simple.Body.Html.Data, input.html);
  assert.equal(body!.Content.Simple.Body.Text.Charset, 'UTF-8'); assert.equal(body!.ReplyToAddresses, undefined);
});

test('disabled, empty-allowlist, invalid-sender and closed-window paths make no account or SES call', async () => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => { f.state.settings.enabled = false; },
    (f: ReturnType<typeof fixture>) => { f.state.settings.allowedRecipients = []; },
    (f: ReturnType<typeof fixture>) => { f.state.settings.from = 'different@example.test'; },
    (f: ReturnType<typeof fixture>) => { f.state.settings.poolId = 'us-west-2_wrong'; },
    (f: ReturnType<typeof fixture>) => { f.state.settings.siteUrl = 'https://example.test'; },
    (f: ReturnType<typeof fixture>) => { f.state.now = new Date(EMAIL_CUTOFF); },
  ]) {
    const f = fixture(); alter(f); await f.dispatch();
    assert.equal(f.state.accountCalls.length, 0); assert.equal(f.state.sends.length, 0); assert.equal(f.state.budget, 0);
    assert.equal(f.stored().status, 'not_sent'); assert.equal((await f.list())[0].canRetry, false);
    await assert.rejects(f.retry(), rejects('EMAIL_NOT_RETRYABLE'));
  }
});

test('accepted sends use current verified exact-address account and return only scoped delivery DTO', async () => {
  const f = fixture(); await f.dispatch();
  assert.deepEqual(f.state.accountCalls, [{ email: 'parent@example.test', pool: 'us-east-2_fixture' }]);
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.budget, 1); assert.equal(f.stored().attempts, 1);
  assert.equal(f.stored().recipientAccountId, parentId); assert.equal(f.stored().status, 'accepted');
  const [summary] = await f.list(); assert.equal(summary.status, 'accepted'); assert.equal(summary.canRetry, false); assert.equal(summary.hasPreview, true);
  for (const privateKey of ['html', 'text', 'subject', 'publisher', 'recipientAccountId', 'messageId', 'childFingerprint']) assert.equal(privateKey in summary, false);
  const preview = await f.preview(); assert.equal(preview.html, f.state.sends[0].html); assert.equal(preview.subject, f.state.sends[0].subject);
  assert(summary.message.includes('Inbox delivery is not confirmed')); await assert.rejects(f.retry(), rejects('EMAIL_NOT_RETRYABLE'));
  await f.dispatch(); await f.list(); await f.preview(); assert.equal(f.state.sends.length, 1);
});

test('missing/unverified/disabled/renamed/unfinished/malformed accounts do not send or guess another alias', async () => {
  const cases = [
    (value: AdminGetUserCommandOutput) => { value.Enabled = false; },
    (value: AdminGetUserCommandOutput) => { value.UserStatus = 'UNCONFIRMED'; },
    (value: AdminGetUserCommandOutput) => { value.UserStatus = 'FORCE_CHANGE_PASSWORD'; },
    (value: AdminGetUserCommandOutput) => { value.UserAttributes!.find(a => a.Name === 'email_verified')!.Value = 'false'; },
    (value: AdminGetUserCommandOutput) => { value.UserAttributes!.find(a => a.Name === 'email')!.Value = 'other@example.test'; },
    (value: AdminGetUserCommandOutput) => { value.UserAttributes!.find(a => a.Name === 'sub')!.Value = 'not-a-sub'; },
    (value: AdminGetUserCommandOutput) => { value.UserAttributes = []; },
  ];
  for (const mutate of cases) {
    const f = fixture(); const value = account(); mutate(value); f.state.resolve = async () => value;
    await f.dispatch(); assert.equal(f.state.accountCalls.length, 1); assert.equal(f.state.sends.length, 0); assert.equal(f.stored().code, 'PARENT_NOT_VERIFIED'); assert.equal(f.state.budget, 1);
  }
  const missing = fixture(); missing.state.resolve = async () => { throw Object.assign(new Error(), { name: 'UserNotFoundException' }); };
  await missing.dispatch(); assert.equal(missing.state.accountCalls.length, 1); assert.equal(missing.state.sends.length, 0); assert.equal(missing.stored().code, 'PARENT_CHECK_UNAVAILABLE');
});

test('case-normalized exact verified address succeeds without relying on Cognito Username matching the email', async () => {
  const f = fixture(); f.state.resolve = async () => account('Parent@Example.Test'); await f.dispatch();
  assert.equal(f.state.sends.length, 1); assert.equal(f.stored().status, 'accepted');
});

test('current child, parent, school assignment and revision changes prevent dispatch', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.child.active = false; },
    (f: ReturnType<typeof fixture>) => { f.state.child.parentEmails = ['new@example.test']; },
    (f: ReturnType<typeof fixture>) => { f.state.child.name = 'Changed name'; },
    (f: ReturnType<typeof fixture>) => { f.state.allowed = false; },
    (f: ReturnType<typeof fixture>) => { f.state.update.version = 2; },
  ]) {
    const f = fixture(); change(f); await f.service.dispatchPublished(update);
    assert.equal(f.state.sends.length, 0); assert.equal(f.state.budget, 0);
    assert(['not_sent', 'superseded'].includes(f.stored().status));
  }
});

test('canonical races at claim or final dispatch marker leave no SES call', async () => {
  for (const stage of ['claim', 'resolve', 'dispatch'] as const) {
    const f = fixture();
    if (stage === 'claim') f.state.beforeClaim = () => { f.state.child.version++; };
    if (stage === 'resolve') f.state.resolve = async () => { f.state.child.parentEmails = ['new@example.test']; return account(); };
    if (stage === 'dispatch') f.state.beforeDispatch = () => { f.state.allowed = false; };
    await f.dispatch(); assert.equal(f.state.sends.length, 0); assert.equal(f.state.budget, stage === 'claim' ? 0 : 1);
  }
});

test('concurrent duplicate dispatch claims one attempt and sends one exact stored email', async () => {
  const f = fixture(); await Promise.all([f.dispatch(), f.dispatch(), f.dispatch()]);
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.budget, 1); assert.equal(f.stored().attempts, 1);
  assert.equal(f.state.sends[0].html, f.stored().html);
});

test('definite SES rejection requires explicit retry and never exceeds three attempts', async () => {
  const f = fixture(); f.state.send = async () => { throw Object.assign(new Error('private provider diagnostic'), { name: 'MessageRejected' }); };
  await f.dispatch(); assert.equal(f.stored().status, 'not_sent'); assert.equal((await f.list())[0].canRetry, true);
  await f.dispatch(); assert.equal(f.state.sends.length, 1, 'A duplicate publication does not silently retry a definitely failed send.');
  await f.retry(); await f.retry(); assert.equal(f.state.sends.length, EMAIL_ATTEMPT_LIMIT); assert.equal(f.state.budget, EMAIL_ATTEMPT_LIMIT);
  assert.equal((await f.list())[0].canRetry, false); assert(!JSON.stringify(await f.list()).includes('private provider diagnostic'));
  await assert.rejects(f.retry(), rejects('EMAIL_NOT_RETRYABLE'));
});

test('cumulative reservation cap is separate from AI and blocks the hundred-and-first attempt', async () => {
  const f = fixture(); f.state.budget = EMAIL_PROJECT_LIMIT; await f.dispatch();
  assert.equal(f.state.sends.length, 0); assert.equal(f.state.accountCalls.length, 0); assert.equal(f.stored().code, 'EMAIL_LIMIT');
  assert.equal(f.state.budget, EMAIL_PROJECT_LIMIT); assert(!EMAIL_BUDGET_KEY.PK.includes('AI_BUDGET'));
});

test('ambiguous timeout, service 5xx, missing MessageId and stale sending never resend', async () => {
  for (const outcome of ['timeout', 'server', 'missing', 'stale'] as const) {
    const f = fixture();
    if (outcome === 'stale') { Object.assign(f.stored(), { status: 'sending', startedAt: '2026-10-29T08:00:00Z', attempts: 1 }); }
    else f.state.send = async () => { if (outcome === 'missing') return {}; throw Object.assign(new Error('private unknown result'), { name: outcome === 'timeout' ? 'TimeoutError' : 'InternalServerErrorException' }); };
    await f.dispatch(); const [summary] = await f.list(); assert.equal(summary.status, 'unknown'); assert.equal(summary.canRetry, false); assert.equal(summary.hasPreview, false);
    await assert.rejects(f.retry(), rejects('EMAIL_NOT_RETRYABLE')); await assert.rejects(f.preview(), rejects('EMAIL_PREVIEW_UNAVAILABLE'));
    await f.dispatch(); assert.equal(f.state.sends.length, outcome === 'stale' ? 0 : 1);
  }
});

test('lost acceptance-save response re-reads accepted proof; absent saved proof becomes unknown', async () => {
  const committed = fixture(); committed.state.failureAfterAcceptedCommit = true; await committed.dispatch();
  assert.equal(committed.stored().status, 'accepted'); assert.equal((await committed.list())[0].hasPreview, true); assert.equal(committed.state.sends.length, 1);
  const unsaved = fixture(); unsaved.state.beforeSave = record => { if (record.status === 'accepted') throw new Error('Storage unavailable'); };
  await unsaved.dispatch(); assert.equal(unsaved.stored().status, 'unknown'); assert.equal((await unsaved.list())[0].canRetry, false);
  await unsaved.dispatch(); assert.equal(unsaved.state.sends.length, 1);
});

test('partial recipient success remains independent and retries only the known failed recipient', async () => {
  const emails = ['first@example.test', 'second@example.test']; const f = fixture(emails);
  f.state.send = async input => { if (input.to === emails[1]) throw Object.assign(new Error(), { name: 'TooManyRequestsException' }); return { MessageId: 'accepted-first' }; };
  await f.dispatch(); assert.equal(f.state.sends.length, 2); assert.deepEqual((await f.list()).map(item => item.status), ['accepted', 'not_sent']);
  f.state.send = async () => ({ MessageId: 'accepted-second' }); await f.retry(digest(emails[1]));
  assert.equal(f.state.sends.filter(item => item.to === emails[0]).length, 1); assert.equal(f.state.sends.filter(item => item.to === emails[1]).length, 2);
});

test('deadline leaves unstarted recipients pending, with no reservation or verification work for them', async () => {
  const emails = ['one@example.test', 'two@example.test', 'three@example.test', 'four@example.test']; const f = fixture(emails);
  f.state.send = async () => { f.state.now = new Date(f.state.now.getTime() + 5_000); return { MessageId: 'first' }; };
  await f.dispatch(); assert.equal(f.state.sends.length, 1); assert.equal(f.state.accountCalls.length, 1); assert.equal(f.state.budget, 1);
  assert.deepEqual((await f.list()).map(item => item.status), ['accepted', 'pending', 'pending', 'pending']);
});

test('newer corrections supersede old pending mail, preserve old accepted preview and never add recipients', async () => {
  const f = fixture(); await f.dispatch(); const oldHtml = f.stored().html;
  f.state.update.version = 2; f.state.update.text = 'Corrected feedback'; f.state.child.parentEmails = ['new@example.test'];
  assert.equal((await f.list())[0].status, 'accepted'); assert.equal((await f.preview()).html, oldHtml);
  await f.dispatch(); assert.equal(f.state.sends.length, 1);
  const pending = fixture(); pending.state.update.version = 2;
  assert.equal((await pending.list())[0].status, 'superseded'); assert.equal((await pending.list())[0].canRetry, false);
  await assert.rejects(pending.retry(), rejects('EMAIL_NOT_RETRYABLE'));
});

test('parent, unrelated and revoked staff cannot read delivery recipients or exact HTML', async () => {
  const f = fixture(); await f.dispatch();
  for (const user of [{ ...actor, id: 'parent' }, { ...actor, id: 'unrelated' }, { ...actor, emailVerified: false }]) {
    await assert.rejects(f.list(user)); await assert.rejects(f.preview(notificationId, 1, user)); await assert.rejects(f.retry(notificationId, 1, user));
  }
  f.state.allowed = false; await assert.rejects(f.list(), rejects('CLASS_ACCESS_DENIED')); await assert.rejects(f.preview(), rejects('CLASS_ACCESS_DENIED'));
  assert.equal(f.state.sends.length, 1);
});

test('notification state/history reads never dispatch and pending exact HTML is unavailable', async () => {
  const f = fixture(); await f.list(); await assert.rejects(f.preview(), rejects('EMAIL_PREVIEW_UNAVAILABLE'));
  assert.equal(f.state.sends.length, 0); assert.equal(f.state.accountCalls.length, 0); assert.equal(f.state.budget, 0);
});

test('canonical publication conditions cover staff assignment and exact active child fields', () => {
  const checks = parentEmailPublicationChecks(actor, context, child);
  assert.equal(checks.length, 4); const roster = checks.find(item => item.ConditionCheck?.Key?.SK === `STUDENT#${studentId}`)!.ConditionCheck!;
  assert(roster.ConditionExpression!.includes('parentEmails = :parents')); assert.deepEqual(roster.ExpressionAttributeValues![':parents'], child.parentEmails);
  assert.equal(roster.ExpressionAttributeValues![':yes'], true); assert.equal(roster.ExpressionAttributeValues![':version'], child.version);
  assert.equal(parentEmailPublicationChecks({ ...actor, id: 'admin' }, { ...context, role: 'admin' }, child).length, 3);
});

test('default storage uses bounded descending Query and atomic fixed-budget reservation with no Scan', async t => {
  const f = fixture(); const record = structuredClone(f.stored()); const calls: unknown[] = [];
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
    calls.push(command);
    if (command instanceof QueryCommand) { assert.equal(command.input.ScanIndexForward, false); assert(command.input.Limit! <= 80); return { Items: [record] }; }
    if (command instanceof GetCommand) return { Item: record };
    if (command instanceof TransactWriteCommand) {
      const reserve = command.input.TransactItems?.find(item => item.Update?.Key?.PK === EMAIL_BUDGET_KEY.PK)?.Update;
      if (reserve) { assert.equal(reserve.ExpressionAttributeValues![':limit'], 100); assert.equal(reserve.ExpressionAttributeValues![':one'], 1); assert(reserve.ConditionExpression!.includes('reservations < :limit')); }
      return {};
    }
    throw new Error('Unexpected storage command');
  });
  const { list: _list, claim: _claim, ...overrides } = f.deps;
  const defaultsService = createParentEmailService(overrides);
  await defaultsService.list(actor, schoolId, classId, updateId); await defaultsService.dispatchPublished(update);
  assert(calls.some(call => call instanceof QueryCommand)); assert(calls.some(call => call instanceof TransactWriteCommand));
});

test('default atomic claim loses budget/notification CAS races without reserving or sending twice', async t => {
  const priorTable = process.env.TABLE_NAME; process.env.TABLE_NAME = 'email-claim-fixture';
  t.after(() => { if (priorTable === undefined) delete process.env.TABLE_NAME; else process.env.TABLE_NAME = priorTable; });
  for (const race of ['budget', 'notification'] as const) {
    const f = fixture(); let stored = structuredClone(f.stored()); let reservations = race === 'budget' ? 100 : 0;
    let transactionCalls = 0;
    const mocked = t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command: unknown) => {
      if (command instanceof GetCommand) return { Item: command.input.Key!.PK === EMAIL_BUDGET_KEY.PK ? { reservations } : structuredClone(stored) };
      assert(command instanceof TransactWriteCommand); transactionCalls++;
      const operations = command.input.TransactItems!;
      const budget = operations.find(operation => operation.Update?.Key?.PK === EMAIL_BUDGET_KEY.PK)?.Update;
      const notification = operations.find(operation => operation.Put)?.Put!;
      if (budget) {
        assert.equal(operations.filter(operation => operation.Put).length, 1);
        assert(operations.some(operation => operation.ConditionCheck?.Key?.SK === `STUDENT#${studentId}`));
        assert(operations.some(operation => operation.ConditionCheck?.Key?.SK === `UPDATE#${updateId}`));
        assert.equal(notification.ConditionExpression, '#version = :version');
        if (race === 'notification') stored = { ...stored, version: stored.version + 1, status: 'sending', attempts: 1, claimToken: 'other-worker', startedAt: f.state.now.toISOString() };
        const conflict = stored.version !== notification.ExpressionAttributeValues![':version'];
        const capped = reservations >= Number(budget.ExpressionAttributeValues![':limit']);
        if (conflict || capped) throw Object.assign(new Error('Atomic claim rejected'), { name: 'TransactionCanceledException', CancellationReasons: operations.map((operation, index) => ({ Code: index === (conflict ? 0 : 1) ? 'ConditionalCheckFailed' : 'None' })) });
        reservations++;
      }
      if (stored.version !== notification.ExpressionAttributeValues![':version']) throw new SchoolError(409, 'RECORD_CHANGED', 'Changed');
      stored = structuredClone(notification.Item as ParentEmailNotification); return {};
    });
    const { claim: _claim, read: _read, save: _save, ...overrides } = f.deps;
    const service = createParentEmailService(overrides);
    await service.dispatchPublished(update);
    assert.equal(f.state.sends.length, 0); assert.equal(f.state.accountCalls.length, 0);
    assert.equal(reservations, race === 'budget' ? 100 : 0);
    assert.equal(stored.status, race === 'budget' ? 'not_sent' : 'sending');
    if (race === 'notification') assert.equal(stored.claimToken, 'other-worker');
    assert(transactionCalls > 0); mocked.mock.restore();
  }
});
