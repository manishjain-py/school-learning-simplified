import { createHash, randomUUID } from 'node:crypto';
import { AdminGetUserCommand, CognitoIdentityProviderClient, type AdminGetUserCommandOutput } from '@aws-sdk/client-cognito-identity-provider';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SchoolError, classPK, fail, get, id, json, normalizeEmail, put, queryPage, requireClassStaff, schoolPK, version, write, type RecordValue, type Student, type VerifiedAccount } from './index.js';

export const EMAIL_CUTOFF = '2026-11-20T18:30:00.000Z'; // Midnight starting 21 Nov IST; retain the historical cumulative ledger below.
export const EMAIL_BUDGET_KEY = { PK: 'PARENT_EMAIL_BUDGET#2026-10-29_2026-11-09', SK: 'PROJECT' };
export const EMAIL_ATTEMPT_LIMIT = 3;
export const EMAIL_PROJECT_LIMIT = 100;
const SITE = 'https://schoollearningsimplified.com';
const SENDER = 'updates@schoollearningsimplified.com';
const REGION = 'us-east-2';
const STALE_SENDING_MS = 30_000;
const DELIVERY_MS = 8_000;
type StaffContext = Awaited<ReturnType<typeof requireClassStaff>>;
type Checks = Parameters<typeof write>[0];
type Status = 'pending' | 'sending' | 'accepted' | 'not_sent' | 'unknown' | 'superseded';
export type ParentEmailUpdate = {
  id: string; schoolId: string; classId: string; authorId: string; authorEmail: string; authorName: string;
  audience: 'class' | 'student'; studentId: string | null; text: string; version: number;
  assistance?: { language: 'en' | 'hi'; activity: { chapterTitle: string } } | null;
};
export type ParentEmailNotification = {
  id: string; schoolId: string; classId: string; updateId: string; revision: number; studentId: string;
  recipient: string; publisher: VerifiedAccount; childFingerprint: string;
  subject: string; html: string; text: string; status: Status; code: string; retryable: boolean;
  version: number; attempts: number; createdAt: string; updatedAt: string;
  claimToken?: string; startedAt?: string; dispatchedAt?: string; recipientAccountId?: string;
  acceptedAt?: string; messageId?: string;
};
type Settings = { enabled: boolean; from: string; poolId: string; siteUrl: string; allowedRecipients: string[] };
export type ParentEmailSendInput = { from: string; to: string; subject: string; html: string; text: string };
export type ParentEmailDependencies = {
  authorize(user: VerifiedAccount, schoolId: string, classId: string): Promise<StaffContext>;
  child(schoolId: string, classId: string, studentId: string): Promise<Student | null>;
  update(schoolId: string, classId: string, updateId: string): Promise<ParentEmailUpdate | null>;
  read(schoolId: string, classId: string, updateId: string, revision: number, notificationId: string): Promise<ParentEmailNotification | null>;
  list(schoolId: string, classId: string, updateId: string, revision?: number): Promise<ParentEmailNotification[]>;
  save(record: ParentEmailNotification, expectedVersion: number, checks?: Checks): Promise<void>;
  claim(record: ParentEmailNotification, expectedVersion: number, checks: Checks): Promise<void>;
  account(email: string, poolId: string): Promise<AdminGetUserCommandOutput>;
  send(input: ParentEmailSendInput): Promise<{ MessageId?: string }>;
  settings(): Settings;
  now(): Date;
  token(): string;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const PK = (school: string, classroom: string, update: string) => `PARENT_EMAIL#${school}#${classroom}#${update}`;
const SK = (revision: number, recipient: string) => `REV#${String(revision).padStart(10, '0')}#TO#${recipient}`;
const childFingerprint = (child: Student) => digest(JSON.stringify([child.id, child.name, child.studentEmail, [...child.parentEmails].sort(), child.version, child.active]));
const table = () => process.env.TABLE_NAME!;
const escaped = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const messages: Record<string, string> = {
  PENDING: 'Email is waiting to be sent.', SENDING: 'Email is being submitted to the email service.',
  ACCEPTED: 'Accepted by the email service for sending. Inbox delivery is not confirmed here.',
  EMAIL_DISABLED: 'Email not sent: parent email is not enabled.',
  EMAIL_CONFIGURATION: 'Email not sent: the sender configuration is unavailable.',
  RECIPIENT_NOT_ENABLED: 'Email not sent: this recipient is not enabled for the controlled demo.',
  EMAIL_WINDOW: 'Email not sent: the approved email sending window has ended.',
  EMAIL_LIMIT: 'Email not sent: the project email allowance is exhausted.',
  EMAIL_ATTEMPT_LIMIT: 'Email not sent: this notification has used its three attempts.',
  PARENT_NOT_VERIFIED: 'Email not sent: the recorded parent account is not currently verified and enabled.',
  PARENT_CHECK_UNAVAILABLE: 'Email not sent: parent account verification was unavailable.',
  CONTEXT_CHANGED: 'Email not sent: the child or publishing staff connection changed.',
  SUPERSEDED: 'Email not sent: a newer update revision replaced this notification.',
  SERVICE_REJECTED: 'Email not sent: the email service rejected this attempt.',
  SEND_UNKNOWN: 'The email outcome is uncertain. Do not retry: it may already have been sent.',
  STORAGE_UNAVAILABLE: 'Email not sent: delivery could not be recorded safely.',
};

/** Canonical conditions also protect manually written feedback, not only drafted notes. */
export function parentEmailPublicationChecks(user: VerifiedAccount, context: StaffContext, child?: Student | null): Checks {
  const schoolId = context.school.id; const classId = context.schoolClass.id;
  const checks: Checks = [
    { ConditionCheck: { TableName: table(), Key: { PK: schoolPK(schoolId), SK: 'META' }, ConditionExpression: 'adminId = :admin', ExpressionAttributeValues: { ':admin': context.school.adminId } } },
    { ConditionCheck: { TableName: table(), Key: { PK: schoolPK(schoolId), SK: `CLASS#${classId}` }, ConditionExpression: '#version = :version AND teacherEmails = :teachers', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': context.schoolClass.version, ':teachers': context.schoolClass.teacherEmails } } },
  ];
  if (context.role === 'teacher') checks.push({ ConditionCheck: { TableName: table(), Key: { PK: schoolPK(schoolId), SK: `TEACHER#${digest(normalizeEmail(user.email))}` }, ConditionExpression: '#active = :yes AND email = :email', ExpressionAttributeNames: { '#active': 'active' }, ExpressionAttributeValues: { ':yes': true, ':email': normalizeEmail(user.email) } } });
  if (child) checks.push({ ConditionCheck: { TableName: table(), Key: { PK: classPK(schoolId, classId), SK: `STUDENT#${child.id}` }, ConditionExpression: '#active = :yes AND #version = :version AND #name = :name AND studentEmail = :email AND parentEmails = :parents', ExpressionAttributeNames: { '#active': 'active', '#version': 'version', '#name': 'name' }, ExpressionAttributeValues: { ':yes': true, ':version': child.version, ':name': child.name, ':email': child.studentEmail, ':parents': child.parentEmails } } });
  return checks;
}

/** A pure renderer: no model, recipient lookup, tracking assets or generated external URL. */
export function renderParentEmail(update: ParentEmailUpdate, child: Student, subjectName: string) {
  const language = update.assistance?.language || (/[\u0900-\u097f]/.test(update.text) ? 'hi' : 'en');
  const topic = update.assistance?.activity.chapterTitle || subjectName;
  const subject = language === 'hi' ? `${child.name} के शिक्षक ने जानकारी साझा की${topic ? `: ${topic}` : ''}` : `${child.name}’s teacher shared an update${topic ? `: ${topic}` : ''}`;
  const params = new URLSearchParams({ view: 'parent', school: update.schoolId, class: update.classId, child: child.id, update: update.id });
  const href = `${SITE}/school?${params.toString()}`;
  const open = language === 'hi' ? 'School Learning Simplified में खोलें' : 'Open in School Learning Simplified';
  const reply = language === 'hi' ? 'ऐप में निजी तौर पर जवाब दें।' : 'Reply privately in the app.';
  const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escaped(subject)}</title></head><body style="margin:0;padding:24px;background:#faf9f4;color:#294c3a;font:16px/1.7 Arial,sans-serif"><main style="max-width:560px;margin:auto;padding:24px;background:#fffefa;border:1px solid #dce6d0;border-radius:12px"><p style="font-size:13px">School Learning Simplified</p><h1 style="font-size:22px;line-height:1.4">${escaped(subject)}</h1><p>${escaped(update.text).replace(/\r?\n/g, '<br>')}</p><p><a href="${escaped(href)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#315d44;color:white;text-decoration:none">${open}</a></p><p>${reply}</p></main></body></html>`;
  return { subject, html, text: `${subject}\n\n${update.text}\n\n${open}: ${href}\n\n${reply}` };
}

/** These private rows join the UPDATE/UPDATEREV transaction. No recipient is added later. */
export function prepareParentEmailRecords(update: ParentEmailUpdate, publisher: VerifiedAccount, child: Student | null, subjectName: string, at: string): Checks {
  if (update.audience !== 'student' || !child) return [];
  const content = renderParentEmail(update, child, subjectName);
  const recipients = [...new Set(child.parentEmails.map(normalizeEmail))];
  if (recipients.length > 4) return fail(400, 'INVALID_PARENTS', 'A family update can notify up to four recorded parents.');
  return recipients.map(recipient => {
    const notification: ParentEmailNotification = { id: digest(recipient), schoolId: update.schoolId, classId: update.classId, updateId: update.id, revision: update.version, studentId: child.id, recipient, publisher: { id: publisher.id, email: normalizeEmail(publisher.email), emailVerified: true }, childFingerprint: childFingerprint(child), ...content, status: 'pending', code: 'PENDING', retryable: true, version: 1, attempts: 0, createdAt: at, updatedAt: at };
    return put(PK(update.schoolId, update.classId, update.id), SK(update.version, notification.id), notification, 'new');
  });
}

function settings(): Settings {
  return { enabled: process.env.PARENT_EMAIL_ENABLED === 'true', from: process.env.PARENT_EMAIL_FROM || '', poolId: process.env.USER_POOL_ID || '', siteUrl: process.env.SITE_URL || '', allowedRecipients: (process.env.PARENT_EMAIL_ALLOWED_RECIPIENTS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean) };
}
export function parentEmailCommand(input: ParentEmailSendInput) {
  return new SendEmailCommand({ FromEmailAddress: input.from, Destination: { ToAddresses: [input.to] }, Content: { Simple: { Subject: { Data: input.subject, Charset: 'UTF-8' }, Body: { Html: { Data: input.html, Charset: 'UTF-8' }, Text: { Data: input.text, Charset: 'UTF-8' } } } }, ConfigurationOverrides: { Tracking: { OpenTrackingEnabled: 'DISABLED', ClickTrackingEnabled: 'DISABLED' } } });
}
const defaults: ParentEmailDependencies = {
  authorize: requireClassStaff,
  child: (school, classroom, child) => get<Student>(classPK(school, classroom), `STUDENT#${child}`),
  update: (school, classroom, update) => get<ParentEmailUpdate>(`COMM#${school}#${classroom}`, `UPDATE#${update}`),
  read: (school, classroom, update, revision, notification) => get<ParentEmailNotification>(PK(school, classroom, update), SK(revision, notification)),
  list: async (school, classroom, update, revision) => {
    const page = await queryPage(PK(school, classroom, update), revision ? `REV#${String(revision).padStart(10, '0')}#TO#` : 'REV#', undefined, { limit: revision ? 4 : 80, descending: true });
    return page.items as ParentEmailNotification[];
  },
  save: (record, expectedVersion, checks = []) => write([put(PK(record.schoolId, record.classId, record.updateId), SK(record.revision, record.id), record, expectedVersion), ...checks]),
  claim: async (record, expectedVersion, checks) => {
    try {
      await write([
        put(PK(record.schoolId, record.classId, record.updateId), SK(record.revision, record.id), record, expectedVersion),
        { Update: { TableName: table(), Key: EMAIL_BUDGET_KEY, UpdateExpression: 'ADD reservations :one', ConditionExpression: 'attribute_not_exists(reservations) OR reservations < :limit', ExpressionAttributeValues: { ':one': 1, ':limit': EMAIL_PROJECT_LIMIT } } },
        ...checks,
      ]);
    } catch (issue) {
      const budget = await get<{ reservations: number }>(EMAIL_BUDGET_KEY.PK, EMAIL_BUDGET_KEY.SK);
      if (budget && budget.reservations >= EMAIL_PROJECT_LIMIT) return fail(409, 'EMAIL_LIMIT', messages.EMAIL_LIMIT);
      throw issue;
    }
  },
  account: (email, poolId) => new CognitoIdentityProviderClient({ region: REGION, maxAttempts: 1 }).send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }), { abortSignal: AbortSignal.timeout(1_800) }),
  send: input => new SESv2Client({ region: REGION, maxAttempts: 1 }).send(parentEmailCommand(input), { abortSignal: AbortSignal.timeout(2_000) }),
  settings, now: () => new Date(), token: randomUUID,
};

// SES documents AccessDeniedException from tracking-override authorization as a
// rejection without sending: https://docs.aws.amazon.com/ses/latest/dg/configuration-overrides.html
const rejectionNames = new Set(['MessageRejected', 'MessageRejectedException', 'MailFromDomainNotVerifiedException', 'NotFoundException', 'BadRequestException', 'AccountSuspendedException', 'SendingPausedException', 'TooManyRequestsException', 'LimitExceededException', 'ForbiddenException', 'AccessDeniedException']);
const definiteSesRejection = (issue: unknown) => rejectionNames.has((issue as Error)?.name);
const diagnosticNames = new Set([...rejectionNames, 'AbortError', 'TimeoutError', 'InternalServerErrorException', 'ServiceUnavailableException', 'CredentialsProviderError', 'Error']);
function sendDenialCategories(name: string, message: unknown, from: string, to: string) {
  const result = { deniedAction: 'unknown', denialReason: 'unknown', resourceKind: 'other_or_unknown' };
  if (name !== 'AccessDeniedException' || typeof message !== 'string') return result;
  const text = message.slice(0, 8_192);
  const action = text.match(/\bis not authorized to perform:?\s*(['"`]?)(ses:(?:SendEmail|SendRawEmail|ApplyTrackingConfigurationOverrides))\1(?=\s|[,.;:)]+(?:\s|$)|$)/)?.[2];
  if (!action) return result;
  result.deniedAction = action;
  if (/\bbecause no permissions boundary allows\b|\bwith an explicit deny in (?:a|the) permissions boundary\b/i.test(text)) result.denialReason = 'permissions_boundary';
  else if (/\bbecause no service control policy allows\b|\bwith an explicit deny in (?:a|the) service control policy\b/i.test(text)) result.denialReason = 'service_control_policy';
  else if (/\bwith an explicit deny\b/i.test(text)) result.denialReason = 'explicit_deny';
  else if (/\bbecause no identity-based policy allows\b/i.test(text)) result.denialReason = 'identity_policy_missing';
  const resource = text.match(/\bon resource:?\s*(['"`]?)arn:aws(?:-[a-z]+)*:ses:[a-z0-9-]+:\d{12}:(identity|configuration-set)\/([^\s"'`]+)\1(?=\s|[,.;:)]+(?:\s|$)|$)/);
  if (resource?.[2] === 'configuration-set') result.resourceKind = 'configuration_set';
  else if (resource?.[2] === 'identity') {
    const value = resource[3].replace(/[.,;:)]+$/, '').toLowerCase(); const sender = from.trim().toLowerCase(); const recipient = to.trim().toLowerCase();
    const domain = (email: string) => email.match(/^[^@\s]+@([^@\s]+)$/)?.[1];
    if (value === sender) result.resourceKind = 'sender_address_identity';
    else if (value === domain(sender)) result.resourceKind = 'sender_domain_identity';
    else if (value === recipient || value === domain(recipient)) result.resourceKind = 'recipient_identity';
  }
  return result;
}
function reportSendFailure(issue: unknown, from: string, to: string) {
  const error = issue as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const name = typeof error?.name === 'string' && diagnosticNames.has(error.name) ? error.name : 'UnknownError';
  const status = error?.$metadata?.httpStatusCode;
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  // Only fixed categories leave the parser, never provider text, ARNs, addresses or IDs.
  console.warn('parent_email_send_failed', { name, httpStatus, ...sendDenialCategories(name, error?.message, from, to) });
}
function notificationId(value: string) { return /^[a-f0-9]{64}$/.test(value) ? value : fail(404, 'EMAIL_NOT_FOUND', 'This email notification could not be found.'); }
function configIssue(config: Settings, recipient: string, at: Date): string | null {
  if (!config.enabled) return 'EMAIL_DISABLED';
  if (!Number.isFinite(at.getTime()) || at >= new Date(EMAIL_CUTOFF)) return 'EMAIL_WINDOW';
  if (config.from !== SENDER || config.siteUrl !== SITE || !/^us-east-2_[A-Za-z0-9]+$/.test(config.poolId)) return 'EMAIL_CONFIGURATION';
  if (!config.allowedRecipients.includes(recipient)) return 'RECIPIENT_NOT_ENABLED';
  return null;
}
function currentStatus(record: ParentEmailNotification, currentRevision: number, at: Date): Status {
  if (record.status === 'sending' && (!record.startedAt || !Number.isFinite(Date.parse(record.startedAt)) || at.getTime() - Date.parse(record.startedAt) > STALE_SENDING_MS)) return 'unknown';
  if ((record.status === 'pending' || record.status === 'not_sent') && record.revision !== currentRevision) return 'superseded';
  return record.status;
}
function dto(record: ParentEmailNotification, currentRevision: number, config: Settings, at: Date) {
  const status = currentStatus(record, currentRevision, at);
  const code = status === 'unknown' ? 'SEND_UNKNOWN' : status === 'superseded' ? 'SUPERSEDED' : record.code;
  const canRetry = ['pending', 'not_sent'].includes(status) && record.retryable && record.attempts < EMAIL_ATTEMPT_LIMIT && !configIssue(config, record.recipient, at);
  return { id: record.id, revision: record.revision, recipient: record.recipient, status, attempts: record.attempts, message: messages[code] || messages.STORAGE_UNAVAILABLE, canRetry, hasPreview: status === 'accepted', ...(record.acceptedAt ? { acceptedAt: record.acceptedAt } : {}) };
}

/** Sends only on post-publication dispatch or explicit staff retry; reads remain read-only. */
export function createParentEmailService(overrides: Partial<ParentEmailDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  async function authorize(user: VerifiedAccount, school: string, classroom: string) {
    if (!user.id || !user.emailVerified) return fail(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before opening delivery information.');
    return deps.authorize(user, id(school), id(classroom));
  }
  async function updateFor(school: string, classroom: string, updateId: string) {
    const update = await deps.update(school, classroom, id(updateId));
    if (!update || update.schoolId !== school || update.classId !== classroom || update.id !== updateId) return fail(404, 'UPDATE_NOT_FOUND', 'This family update could not be found.');
    return update;
  }
  async function recordFor(school: string, classroom: string, updateId: string, revision: number, recipientId: string) {
    const record = await deps.read(school, classroom, updateId, version(revision), notificationId(recipientId));
    if (!record || record.schoolId !== school || record.classId !== classroom || record.updateId !== updateId || record.revision !== revision || record.id !== recipientId) return fail(404, 'EMAIL_NOT_FOUND', 'This email notification could not be found.');
    return record;
  }
  async function contextFor(record: ParentEmailNotification) {
    const current = await updateFor(record.schoolId, record.classId, record.updateId);
    if (current.version !== record.revision || current.audience !== 'student' || current.studentId !== record.studentId) return fail(409, 'SUPERSEDED', messages.SUPERSEDED);
    const context = await authorize(record.publisher, record.schoolId, record.classId);
    const child = await deps.child(record.schoolId, record.classId, record.studentId);
    if (!child?.active || child.id !== record.studentId || !child.parentEmails.includes(record.recipient) || childFingerprint(child) !== record.childFingerprint) return fail(409, 'CONTEXT_CHANGED', messages.CONTEXT_CHANGED);
    const checks = parentEmailPublicationChecks(record.publisher, context, child);
    checks.push({ ConditionCheck: { TableName: table(), Key: { PK: `COMM#${record.schoolId}#${record.classId}`, SK: `UPDATE#${record.updateId}` }, ConditionExpression: '#version = :revision AND audience = :audience AND studentId = :student', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':revision': record.revision, ':audience': 'student', ':student': record.studentId } } });
    return { current, checks };
  }
  async function finish(record: ParentEmailNotification, status: Status, code: string, retryable: boolean, extra: Partial<ParentEmailNotification> = {}) {
    const next = { ...record, ...extra, status, code, retryable, version: record.version + 1, updatedAt: deps.now().toISOString() };
    try { await deps.save(next, record.version); return next; }
    catch {
      // A save may have committed despite a lost response. A confirmed accepted
      // record is usable; any unresolved sending state must never be re-sent.
      try {
        const latest = await recordFor(record.schoolId, record.classId, record.updateId, record.revision, record.id);
        if (latest.status !== 'sending' || !record.dispatchedAt) return latest;
        const uncertain = { ...latest, status: 'unknown' as const, code: 'SEND_UNKNOWN', retryable: false, version: latest.version + 1, updatedAt: deps.now().toISOString() };
        try { await deps.save(uncertain, latest.version); } catch { /* A stale sending record also projects unknown, without retry. */ }
        return uncertain;
      }
      catch { return { ...next, status: record.status === 'sending' ? 'unknown' as const : record.status, code: record.status === 'sending' ? 'SEND_UNKNOWN' : 'STORAGE_UNAVAILABLE', retryable: false }; }
    }
  }
  async function deliver(record: ParentEmailNotification, explicit: boolean, deadline: number): Promise<ParentEmailNotification> {
    if (record.status !== 'pending' && !(explicit && record.status === 'not_sent' && record.retryable)) return record;
    if (record.attempts >= EMAIL_ATTEMPT_LIMIT) return finish(record, 'not_sent', 'EMAIL_ATTEMPT_LIMIT', false);
    const config = deps.settings(); const unavailable = configIssue(config, record.recipient, deps.now());
    if (unavailable) return finish(record, 'not_sent', unavailable, unavailable === 'EMAIL_DISABLED' || unavailable === 'EMAIL_CONFIGURATION' || unavailable === 'RECIPIENT_NOT_ENABLED');
    if (deadline - deps.now().getTime() < 4_000) return record;
    let context: Awaited<ReturnType<typeof contextFor>>;
    try { context = await contextFor(record); }
    catch (issue) { return finish(record, (issue as SchoolError).code === 'SUPERSEDED' ? 'superseded' : 'not_sent', (issue as SchoolError).code === 'SUPERSEDED' ? 'SUPERSEDED' : 'CONTEXT_CHANGED', false); }
    const claimed: ParentEmailNotification = { ...record, status: 'sending', code: 'SENDING', retryable: false, version: record.version + 1, attempts: record.attempts + 1, claimToken: deps.token(), startedAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() };
    try { await deps.claim(claimed, record.version, context.checks); }
    catch (issue) {
      try {
        const latest = await recordFor(record.schoolId, record.classId, record.updateId, record.revision, record.id);
        if (latest.version !== record.version) return latest;
        if ((issue as SchoolError).code === 'EMAIL_LIMIT') return finish(record, 'not_sent', 'EMAIL_LIMIT', false);
      } catch { /* A claim with an uncertain outcome is never followed by SES. */ }
      return { ...record, code: 'STORAGE_UNAVAILABLE', retryable: false };
    }
    let account: AdminGetUserCommandOutput;
    try { account = await deps.account(record.recipient, config.poolId); }
    catch { return finish(claimed, 'not_sent', 'PARENT_CHECK_UNAVAILABLE', true); }
    const attrs = Object.fromEntries((account.UserAttributes || []).map(attribute => [attribute.Name, attribute.Value]));
    if (account.Enabled !== true || account.UserStatus !== 'CONFIRMED' || attrs.email?.trim().toLowerCase() !== record.recipient || attrs.email_verified !== 'true' || typeof attrs.sub !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(attrs.sub)) return finish(claimed, 'not_sent', 'PARENT_NOT_VERIFIED', true);
    if (deadline - deps.now().getTime() < 2_500) return finish(claimed, 'not_sent', 'PENDING', true);
    let dispatch: ParentEmailNotification;
    try {
      const fresh = await contextFor(claimed);
      dispatch = { ...claimed, version: claimed.version + 1, recipientAccountId: attrs.sub, dispatchedAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() };
      await deps.save(dispatch, claimed.version, fresh.checks);
    } catch (issue) { return finish(claimed, (issue as SchoolError).code === 'SUPERSEDED' ? 'superseded' : 'not_sent', (issue as SchoolError).code === 'SUPERSEDED' ? 'SUPERSEDED' : 'CONTEXT_CHANGED', false); }
    try {
      const sent = await deps.send({ from: config.from, to: dispatch.recipient, subject: dispatch.subject, html: dispatch.html, text: dispatch.text });
      if (!sent.MessageId) return finish(dispatch, 'unknown', 'SEND_UNKNOWN', false);
      return finish(dispatch, 'accepted', 'ACCEPTED', false, { messageId: sent.MessageId, acceptedAt: deps.now().toISOString() });
    } catch (issue) {
      reportSendFailure(issue, config.from, dispatch.recipient);
      return definiteSesRejection(issue) ? finish(dispatch, 'not_sent', 'SERVICE_REJECTED', true) : finish(dispatch, 'unknown', 'SEND_UNKNOWN', false);
    }
  }
  async function dispatchPublished(update: ParentEmailUpdate) {
    if (update.audience !== 'student') return;
    try {
      const records = await deps.list(update.schoolId, update.classId, update.id, update.version);
      const deadline = deps.now().getTime() + DELIVERY_MS;
      for (const record of records.slice(0, 4)) {
        if (record.revision !== update.version || record.updateId !== update.id || record.schoolId !== update.schoolId || record.classId !== update.classId) continue;
        await deliver(record, false, deadline);
      }
    } catch { /* Publication is already committed. Delivery failures cannot undo it. */ }
  }
  async function list(user: VerifiedAccount, school: string, classroom: string, updateId: string) {
    await authorize(user, school, classroom); const update = await updateFor(school, classroom, updateId);
    const records = await deps.list(school, classroom, updateId);
    await authorize(user, school, classroom);
    return records.filter(record => record.schoolId === school && record.classId === classroom && record.updateId === updateId).map(record => dto(record, update.version, deps.settings(), deps.now()));
  }
  async function preview(user: VerifiedAccount, school: string, classroom: string, updateId: string, revision: number, recipientId: string) {
    await authorize(user, school, classroom); await updateFor(school, classroom, updateId);
    const record = await recordFor(school, classroom, updateId, revision, recipientId);
    if (record.status !== 'accepted' || !record.acceptedAt || !record.messageId) return fail(409, 'EMAIL_PREVIEW_UNAVAILABLE', 'A sent-email preview is available only after the service accepts the email.');
    await authorize(user, school, classroom);
    return { subject: record.subject, html: record.html, acceptedAt: record.acceptedAt };
  }
  async function retry(user: VerifiedAccount, school: string, classroom: string, updateId: string, revision: number, recipientId: string) {
    await authorize(user, school, classroom); const update = await updateFor(school, classroom, updateId);
    const record = await recordFor(school, classroom, updateId, revision, recipientId);
    if (!dto(record, update.version, deps.settings(), deps.now()).canRetry) return fail(409, 'EMAIL_NOT_RETRYABLE', 'This email cannot be retried. Check its current delivery status.');
    const result = await deliver(record, true, deps.now().getTime() + DELIVERY_MS);
    await authorize(user, school, classroom);
    return dto(result, (await updateFor(school, classroom, updateId)).version, deps.settings(), deps.now());
  }
  return { dispatchPublished, list, preview, retry };
}

const service = createParentEmailService();
export const dispatchPublishedParentEmail = service.dispatchPublished;
export async function handleParentEmail(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount): Promise<APIGatewayProxyResultV2 | null> {
  const match = event.rawPath.replace(/\/$/, '').match(/^\/api\/school\/schools\/([^/]+)\/classes\/([^/]+)\/updates\/([^/]+)\/email(?:\/([1-9]\d*)\/([a-f0-9]{64})\/(preview|retry))?$/);
  if (!match) return null;
  const [, school, classroom, update, revision, notification, action] = match; const method = event.requestContext.http.method;
  if (!action && method === 'GET') return json(200, { notifications: await service.list(user, school, classroom, update) });
  if (action === 'preview' && method === 'GET') return json(200, await service.preview(user, school, classroom, update, Number(revision), notification));
  if (action === 'retry' && method === 'POST') return json(200, { notification: await service.retry(user, school, classroom, update, Number(revision), notification) });
  return fail(404, 'NOT_FOUND', 'This email action could not be found.');
}
