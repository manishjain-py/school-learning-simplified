import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { gradeOptions, validateSelection, type AnswerKey } from '../grading.js';
import { SchoolError, type VerifiedAccount } from '../school/index.js';
import { originCondition, originPractice } from '../recommendations/index.js';
import { selectQuestions, type SetQuestion } from './selection.js';

type Language = 'en' | 'hi';
type Row = Record<string, any>;
type Write = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
type Origin = Awaited<ReturnType<typeof originPractice>>;
export type PracticeSetRecord = {
  PK: string; SK: string; kind: 'practice-set'; schemaVersion: 1; contentRelease: 'm2';
  id: string; chapterId: string; questionIds: string[]; language: Language; createdAt: string; updatedAt: string;
  version: number; currentIndex: number; answers: Record<string, string[]>; status: 'draft' | 'submitted'; total: 10;
  recommendationId?: string; studentId?: string; studentEmailHash?: string;
  submittedAt?: string; submittedLanguage?: Language; answered?: number; score?: number;
  verdicts?: Record<string, 'correct' | 'incorrect' | 'skipped'>;
};
export type PracticeContent = {
  bank: (language: Language) => Promise<{ questions: SetQuestion[] }>;
  keys: (language: Language) => Promise<{ answers: Record<string, AnswerKey> }>;
  legacy: (userId: string, chapterId: string, sessionId: string, language: Language) => Promise<unknown>;
};
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-2' }));
const table = () => process.env.TABLE_NAME!;
const fail = (status: number, code: string, message: string): never => { throw new SchoolError(status, code, message); };
const key = (userId: string, chapterId: string, id: string) => ({ PK: `USER#${userId}`, SK: `PRACTICE_SET#${chapterId}#SET#${id}` });
const pointer = (userId: string, chapterId: string) => ({ PK: `USER#${userId}`, SK: `PRACTICE_SET_STATE#${chapterId}` });
const emailHash = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
const answered = (set: PracticeSetRecord) => set.questionIds.filter(id => set.answers[id]?.length).length;
const uuid = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) return fail(400, 'INVALID_SET', 'Open a valid practice set.');
  return value;
};
function language(value: unknown): Language { if (value !== 'en' && value !== 'hi') return fail(400, 'INVALID_LANGUAGE', 'Choose English or Hindi.'); return value; }
function body(event: APIGatewayProxyEventV2WithJWTAuthorizer, fields: string[]): Row {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
    if (raw.length > 20_000) throw new Error();
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(field => !fields.includes(field))) throw new Error();
    return value;
  } catch { return fail(400, 'INVALID_REQUEST', 'The practice request has invalid fields. Refresh your set and try again.'); }
}
async function get<T>(Key: { PK: string; SK: string }): Promise<T | null> { return (await db.send(new GetCommand({ TableName: table(), Key, ConsistentRead: true }))).Item as T || null; }
async function query(PK: string, prefix: string): Promise<Row[]> {
  const rows: Row[] = []; let cursor: Row | undefined;
  do { const page = await db.send(new QueryCommand({ TableName: table(), KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)', ExpressionAttributeValues: { ':pk': PK, ':prefix': prefix }, ConsistentRead: true, ExclusiveStartKey: cursor })); rows.push(...page.Items || []); cursor = page.LastEvaluatedKey; } while (cursor);
  return rows;
}
async function stored(userId: string, chapterId: string, id: string): Promise<PracticeSetRecord | null> {
  const set = await get<PracticeSetRecord>(key(userId, chapterId, uuid(id)));
  if (set && (set.kind !== 'practice-set' || set.schemaVersion !== 1 || set.contentRelease !== 'm2' || set.chapterId !== chapterId || set.id !== id || set.questionIds.length !== 10 || new Set(set.questionIds).size !== 10)) return fail(409, 'SET_UNAVAILABLE', 'This saved practice set is unavailable.');
  return set;
}
async function required(userId: string, chapterId: string, id: string) { return await stored(userId, chapterId, id) || fail(404, 'SET_NOT_FOUND', 'This practice set could not be found in your account.'); }
async function draftOrigin(user: VerifiedAccount, set: PracticeSetRecord) {
  if (!set.recommendationId) return undefined;
  const origin = await originPractice(user, set.recommendationId, set.chapterId);
  if (origin.activity?.practiceSetId !== set.id || set.studentId !== origin.child.id || set.studentEmailHash !== emailHash(user.email)) return fail(409, 'ORIGIN_SET_MISMATCH', 'Open the practice set linked to this recommendation.');
  return origin;
}
function originChecks(origin: Origin | undefined, set: PracticeSetRecord): Write[] {
  return origin ? [originCondition(origin.record), { ConditionCheck: { TableName: table(), Key: origin.key, ConditionExpression: 'practiceSetId = :set AND accountId = :owner AND studentEmailHash = :email', ExpressionAttributeValues: { ':set': set.id, ':owner': origin.activity!.accountId, ':email': set.studentEmailHash } } }] : [];
}
function version(input: unknown, set: PracticeSetRecord) {
  if (!Number.isSafeInteger(input) || Number(input) < 1) return fail(400, 'INVALID_VERSION', 'Refresh your saved practice set.');
  if (input !== set.version) return fail(409, 'SET_CHANGED', 'This set changed in another tab. Reload it before continuing.');
}
async function dto(set: PracticeSetRecord, content: PracticeContent, displayLanguage = set.language) {
  const common = { id: set.id, chapterId: set.chapterId, questionIds: set.questionIds, language: displayLanguage, createdAt: set.createdAt, updatedAt: set.updatedAt, version: set.version, currentIndex: set.currentIndex, answers: set.answers, status: set.status, total: set.total, ...(set.recommendationId ? { recommendationId: set.recommendationId } : {}) };
  if (set.status === 'draft') return common;
  const keys = await content.keys(displayLanguage);
  return { ...common, submittedAt: set.submittedAt, submittedLanguage: set.submittedLanguage, answered: set.answered, score: set.score, results: set.questionIds.map(questionId => {
    const answer = keys.answers[questionId];
    if (!answer?.correctAnswerText || !answer.reason) return fail(503, 'REVIEW_UNAVAILABLE', 'The prepared review for this question is unavailable.');
    return { questionId, selectedOptionIds: set.answers[questionId] || [], verdict: set.verdicts![questionId], correctAnswerText: answer.correctAnswerText, reason: answer.reason };
  }) };
}
function summary(set: PracticeSetRecord) {
  return { id: set.id, chapterId: set.chapterId, status: set.status, language: set.language, createdAt: set.createdAt, answered: answered(set), total: set.total, ...(set.recommendationId ? { recommendationId: set.recommendationId } : {}), ...(set.status === 'submitted' ? { submittedAt: set.submittedAt, score: set.score } : {}) };
}
async function current(user: VerifiedAccount, chapterId: string, recommendationId?: string) {
  if (recommendationId !== undefined) {
    const origin = await originPractice(user, recommendationId, chapterId);
    if (!origin.activity?.practiceSetId) return { set: null, origin, state: null };
    const set = await required(user.id, chapterId, origin.activity.practiceSetId);
    if (set.recommendationId !== recommendationId || set.studentId !== origin.child.id || set.studentEmailHash !== emailHash(user.email)) return fail(409, 'ORIGIN_SET_MISMATCH', 'Open the practice set linked to this recommendation.');
    return { set, origin, state: null };
  }
  const state = await get<{ setId: string }>(pointer(user.id, chapterId));
  const set = state ? await required(user.id, chapterId, state.setId) : null;
  if (set?.recommendationId) return fail(409, 'ORIGIN_REQUIRED', 'Open this set from your school guidance.');
  return { set, origin: undefined, state };
}
async function create(user: VerifiedAccount, chapterId: string, input: Row, content: PracticeContent) {
  const id = uuid(input.requestId); const selectedLanguage = language(input.language);
  if (input.recommendationId !== undefined && (typeof input.recommendationId !== 'string' || !/^[a-f0-9]{64}$/.test(input.recommendationId))) return fail(400, 'INVALID_ORIGIN', 'Open a valid learning recommendation.');
  const previous = await stored(user.id, chapterId, id);
  if (previous) {
    if (previous.recommendationId !== input.recommendationId) return fail(409, 'REQUEST_CONFLICT', 'This practice request was already used for another activity.');
    if (previous.status === 'draft') await draftOrigin(user, previous);
    return dto(previous, content);
  }
  const { set: existing, state, origin } = await current(user, chapterId, input.recommendationId);
  if (existing && (existing.status === 'draft' || origin)) return dto(existing, content);
  const [bank, priorSets, oldRows] = await Promise.all([content.bank('en'), query(`USER#${user.id}`, `PRACTICE_SET#${chapterId}#SET#`), query(`USER#${user.id}`, `PRACTICE#${chapterId}#SESSION#`)]);
  const seen = new Map<string, number>();
  const mark = (questionId: string) => seen.set(questionId, (seen.get(questionId) || 0) + 1);
  for (const row of priorSets) if (row.kind === 'practice-set' && row.chapterId === chapterId) for (const questionId of row.questionIds || []) mark(questionId);
  for (const row of oldRows) if (row.kind === 'practice-answer' && row.chapterId === chapterId && typeof row.questionId === 'string') mark(row.questionId);
  let questionIds: string[];
  try { questionIds = selectQuestions(bank.questions, seen); } catch { return fail(503, 'QUESTIONS_UNAVAILABLE', 'A complete practice set is temporarily unavailable.'); }
  const timestamp = new Date().toISOString();
  const set: PracticeSetRecord = { ...key(user.id, chapterId, id), kind: 'practice-set', schemaVersion: 1, contentRelease: 'm2', id, chapterId, questionIds, language: selectedLanguage, createdAt: timestamp, updatedAt: timestamp, version: 1, currentIndex: 0, answers: {}, status: 'draft', total: 10,
    ...(origin ? { recommendationId: origin.record.id, studentId: origin.child.id, studentEmailHash: emailHash(user.email) } : {}) };
  const writes: Write[] = [{ Put: { TableName: table(), Item: set, ConditionExpression: 'attribute_not_exists(PK)' } }];
  if (origin) writes.push(originCondition(origin.record), { Update: { TableName: table(), Key: origin.key, ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(practiceSetId) AND accountId = :owner AND studentEmailHash = :email', UpdateExpression: 'SET practiceSetId = :set, #language = :language, updatedAt = :now', ExpressionAttributeNames: { '#language': 'language' }, ExpressionAttributeValues: { ':owner': user.id, ':email': emailHash(user.email), ':set': id, ':language': selectedLanguage, ':now': timestamp } } });
  else writes.push({ Put: { TableName: table(), Item: { ...pointer(user.id, chapterId), kind: 'practice-set-state', chapterId, setId: id }, ConditionExpression: state ? 'setId = :previous' : 'attribute_not_exists(PK)', ...(state ? { ExpressionAttributeValues: { ':previous': state.setId } } : {}) } });
  try { await db.send(new TransactWriteCommand({ TransactItems: writes })); }
  catch (error) {
    if ((error as Error).name !== 'TransactionCanceledException') throw error;
    const replay = await stored(user.id, chapterId, id);
    if (replay && replay.recommendationId === input.recommendationId) return dto(replay, content);
    const winner = await current(user, chapterId, input.recommendationId);
    if (winner.set && (!existing || winner.set.id !== existing.id)) return dto(winner.set, content);
    return fail(409, 'SET_CHANGED', 'Another practice request changed. Refresh and try again.');
  }
  return dto(set, content);
}
async function save(user: VerifiedAccount, set: PracticeSetRecord, input: Row, content: PracticeContent) {
  if (set.status !== 'draft') return fail(409, 'SET_FINAL', 'This submitted set is final. Start another set to practise again.');
  version(input.version, set); const selectedLanguage = language(input.language);
  if (!Number.isSafeInteger(input.currentIndex) || input.currentIndex < 0 || input.currentIndex >= 10) return fail(400, 'INVALID_POSITION', 'Choose a question in this practice set.');
  if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers) || Object.keys(input.answers).some(id => !set.questionIds.includes(id))) return fail(400, 'INVALID_ANSWER', 'Save answers only for this practice set.');
  const bank = await content.bank(selectedLanguage); const answers: Record<string, string[]> = {};
  for (const [id, picks] of Object.entries(input.answers)) {
    const question = bank.questions.find(item => item.id === id);
    if (!question) return fail(503, 'QUESTION_UNAVAILABLE', 'A question in this set is temporarily unavailable.');
    try { answers[id] = validateSelection(question, picks, true); }
    catch (error) { return fail(400, 'INVALID_ANSWER', (error as Error).message); }
  }
  const origin = await draftOrigin(user, set);
  const updated: PracticeSetRecord = { ...set, answers, currentIndex: input.currentIndex, language: selectedLanguage, updatedAt: new Date().toISOString(), version: set.version + 1 };
  await change(user, set, updated, origin);
  return dto(updated, content);
}
async function change(user: VerifiedAccount, before: PracticeSetRecord, after: PracticeSetRecord, origin?: Origin) {
  try { await db.send(new TransactWriteCommand({ TransactItems: [...originChecks(origin, before), { Put: { TableName: table(), Item: after, ConditionExpression: '#status = :draft AND #version = :version', ExpressionAttributeNames: { '#status': 'status', '#version': 'version' }, ExpressionAttributeValues: { ':draft': 'draft', ':version': before.version } } }] })); }
  catch (error) {
    if ((error as Error).name !== 'TransactionCanceledException') throw error;
    if (origin) await draftOrigin(user, before);
    return fail(409, 'SET_CHANGED', 'This set changed in another tab. Reload it before continuing.');
  }
}
async function submit(user: VerifiedAccount, set: PracticeSetRecord, input: Row, content: PracticeContent) {
  if (!Number.isSafeInteger(input.version) || input.version < 1) return fail(400, 'INVALID_VERSION', 'Refresh your saved practice set.');
  if (set.status === 'submitted') return dto(set, content);
  version(input.version, set); const origin = await draftOrigin(user, set);
  const [bank, keys] = await Promise.all([content.bank(set.language), content.keys(set.language)]);
  const verdicts: NonNullable<PracticeSetRecord['verdicts']> = {}; let score = 0;
  for (const id of set.questionIds) {
    const question = bank.questions.find(item => item.id === id); const answer = keys.answers[id];
    if (!question || !answer?.reason || !answer.correctAnswerText || !Array.isArray(answer.correctOptionIds) || !answer.correctOptionIds.length || answer.correctOptionIds.some(option => !question.options.some(item => item.id === option))) return fail(503, 'QUESTION_UNAVAILABLE', 'A prepared answer is unavailable. Your picks remain saved.');
    const picks = set.answers[id] || [];
    if (!picks.length) verdicts[id] = 'skipped';
    else { const correct = gradeOptions(question, answer, picks); verdicts[id] = correct ? 'correct' : 'incorrect'; if (correct) score++; }
  }
  const timestamp = new Date().toISOString();
  const final: PracticeSetRecord = { ...set, status: 'submitted', submittedAt: timestamp, submittedLanguage: set.language, updatedAt: timestamp, version: set.version + 1, answered: answered(set), score, verdicts };
  try { await change(user, set, final, origin); }
  catch (error) {
    if (!(error instanceof SchoolError && error.code === 'SET_CHANGED')) throw error;
    const winner = await required(user.id, set.chapterId, set.id);
    if (winner.status === 'submitted') return dto(winner, content);
    throw error;
  }
  return dto(final, content);
}
async function history(user: VerifiedAccount, chapterId: string, content: PracticeContent) {
  const [sets, oldRows, bank] = await Promise.all([query(`USER#${user.id}`, `PRACTICE_SET#${chapterId}#SET#`), query(`USER#${user.id}`, `PRACTICE#${chapterId}#SESSION#`), content.bank('en')]);
  const questionIds = new Set(bank.questions.map(question => question.id));
  return { sets: sets.filter(row => row.kind === 'practice-set' && row.chapterId === chapterId).map(row => summary(row as PracticeSetRecord)).sort((a, b) => (b.submittedAt || b.createdAt).localeCompare(a.submittedAt || a.createdAt)),
    legacyRounds: oldRows.filter(row => row.kind === 'practice-session' && row.chapterId === chapterId).map(row => {
      const answers = oldRows.filter(answer => answer.kind === 'practice-answer' && answer.sessionId === row.sessionId && questionIds.has(answer.questionId));
      return { id: row.sessionId, chapterId, startedAt: row.startedAt, answered: answers.length, totalQuestions: questionIds.size, correctCount: answers.filter(answer => answer.correct === true).length, completed: answers.length === questionIds.size };
    }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
}

export async function handlePracticeSets(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: VerifiedAccount, chapterId: string, content: PracticeContent) {
  const path = event.rawPath.replace(/\/$/, ''); const method = event.requestContext.http.method;
  const route = path.match(/^\/api\/practice\/[^/]+\/(sets|rounds)(?:\/([^/]+))?(?:\/(submit))?$/);
  if (!route) return fail(404, 'NOT_FOUND', 'This practice page could not be found.');
  const [, section, id, action] = route;
  if (section === 'rounds' && id && !action && method === 'GET') return { session: await content.legacy(user.id, chapterId, uuid(id), language(event.queryStringParameters?.language || 'en')) };
  if (section !== 'sets') return fail(405, 'METHOD_NOT_ALLOWED', 'Earlier practice rounds are read-only.');
  if (!id && method === 'GET') return history(user, chapterId, content);
  if (!id && method === 'POST') return { set: await create(user, chapterId, body(event, ['requestId', 'language', 'recommendationId']), content) };
  if (id === 'current' && !action && method === 'GET') {
    const { set } = await current(user, chapterId, event.queryStringParameters?.recommendation);
    return { set: set ? await dto(set, content) : null };
  }
  const set = await required(user.id, chapterId, uuid(id));
  if (!action && method === 'GET') { if (set.status === 'draft') await draftOrigin(user, set); return { set: await dto(set, content, set.status === 'submitted' && event.queryStringParameters?.language ? language(event.queryStringParameters.language) : set.language) }; }
  if (!action && method === 'PUT') return { set: await save(user, set, body(event, ['version', 'currentIndex', 'language', 'answers']), content) };
  if (action === 'submit' && method === 'POST') return { set: await submit(user, set, body(event, ['version']), content) };
  return fail(405, 'METHOD_NOT_ALLOWED', 'This practice action is not supported.');
}
