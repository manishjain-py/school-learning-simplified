import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gradeOptions, type AnswerKey, type OptionQuestion } from './grading.js';
import { handleSchool } from './school/index.js';

type Chapter = { id: string; title: string; languages: string[]; cardCount: number };
type Catalog = { schemaVersion: number; chapters: Chapter[] };
type Lesson = { id: string; language: string; cards: { id: string }[] };
type PracticeBank = { id: string; language: string; questions: OptionQuestion[] };
type PrivateAnswers = { answers: Record<string, AnswerKey> };
type Mode = 'learn' | 'practice' | 'revise';
const release = process.env.CONTENT_RELEASE === 'm2' ? 'm2' : '';
const publicPrefix = release ? `content/releases/${release}` : 'content';
const privatePrefix = `private/releases/${release}`;
const region = process.env.AWS_REGION || 'us-east-2';
const cognito = new CognitoIdentityProviderClient({ region });
const s3 = new S3Client({ region });
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const contentCache = new Map<string, { expires: number; value: unknown }>();

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function json(statusCode: number, data: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(data) };
}

async function readContent<T>(key: string): Promise<T> {
  const cached = contentCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value as T;
  let text: string;
  const privateKey = key.startsWith('private/');
  const localRoot = privateKey ? process.env.LOCAL_PRIVATE_CONTENT_DIR : process.env.LOCAL_CONTENT_DIR;
  if (localRoot && process.env.NODE_ENV !== 'production') {
    text = await readFile(resolve(localRoot, key.slice((privateKey ? privatePrefix : publicPrefix).length + 1)), 'utf8');
  } else {
    if (!process.env.CONTENT_BUCKET) throw new HttpError(503, 'CONTENT_UNAVAILABLE', 'The lesson library is not available yet. Please try again shortly.');
    const result = await s3.send(new GetObjectCommand({ Bucket: process.env.CONTENT_BUCKET, Key: key }));
    text = await result.Body!.transformToString();
  }
  const value = JSON.parse(text) as T;
  contentCache.set(key, { expires: Date.now() + 30_000, value });
  return value;
}

async function chapterFor(id: string): Promise<Chapter> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(404, 'NOT_FOUND', 'That lesson is not in the library.');
  const catalog = await readContent<Catalog>(`${publicPrefix}/catalog.json`);
  const chapter = catalog.chapters.find((item) => item.id === id);
  if (!chapter) throw new HttpError(404, 'NOT_FOUND', 'That lesson is not in the library.');
  return chapter;
}

function learningMode(value?: string): Mode {
  const mode = value || 'learn';
  if (!['learn', 'practice', 'revise'].includes(mode)) throw new HttpError(400, 'INVALID_MODE', 'Choose Learn, Practice or Revise.');
  if (!release && mode !== 'learn') throw new HttpError(404, 'MODE_UNAVAILABLE', 'This learning mode is not available yet.');
  return mode as Mode;
}

function modeKey(chapterId: string, language: string, mode: Mode) {
  return `${publicPrefix}/${mode === 'learn' ? 'lessons' : mode}/${chapterId}/${language}.json`;
}

function requestBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
  if (raw.length > 20_000) throw new HttpError(413, 'TOO_LARGE', 'This update is too large.');
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'INVALID_JSON', 'The update could not be read.'); }
}

function validLanguage(value: unknown): 'en' | 'hi' {
  if (value !== 'en' && value !== 'hi') throw new HttpError(400, 'INVALID_LANGUAGE', 'Choose English or Hindi.');
  return value;
}

function validSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new HttpError(400, 'INVALID_SESSION', 'Start a practice round before answering.');
  return value;
}

async function practiceSession(userId: string, chapterId: string, sessionId: string, language: string) {
  const sessionKey = `PRACTICE#${chapterId}#SESSION#${sessionId}`;
  const rows = await db.send(new QueryCommand({
    TableName: process.env.TABLE_NAME, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': sessionKey }, ConsistentRead: true,
  }));
  const meta = rows.Items?.find((item) => item.SK === sessionKey);
  if (!meta) throw new HttpError(404, 'SESSION_NOT_FOUND', 'This practice round could not be found in your account.');
  const bank = await readContent<PracticeBank>(modeKey(chapterId, language, 'practice'));
  const keys = await readContent<PrivateAnswers>(`${privatePrefix}/practice/${chapterId}/${language}.json`);
  const answers = (rows.Items || []).filter((item) => item.kind === 'practice-answer').map((item) => {
    const key = keys.answers[item.questionId];
    if (!key) throw new HttpError(503, 'REVIEW_UNAVAILABLE', 'The prepared review for this question is unavailable.');
    return { questionId: item.questionId, selectedOptionIds: item.selectedOptionIds, correct: item.correct, answeredAt: item.answeredAt, correctAnswerText: key.correctAnswerText, reason: key.reason };
  });
  return { id: sessionId, chapterId, language, startedAt: meta.startedAt, totalQuestions: bank.questions.length, answered: answers.length, correctCount: answers.filter((answer) => answer.correct).length, completed: answers.length === bank.questions.length, answers };
}

async function verifiedUser(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer /i, '');
  if (!claims?.sub || claims.token_use !== 'access' || !token) {
    throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Sign in to save your learning progress.');
  }
  let result;
  try { result = await cognito.send(new GetUserCommand({ AccessToken: token })); }
  catch (error) {
    if ((error as Error).name === 'NotAuthorizedException') throw new HttpError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
    throw error;
  }
  const attrs = Object.fromEntries((result.UserAttributes || []).map((item) => [item.Name!, item.Value]));
  if (attrs.sub !== claims.sub) throw new HttpError(401, 'INVALID_SESSION', 'Please sign in again.');
  if (attrs.email_verified !== 'true') throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before saving progress.');
  if (!process.env.TABLE_NAME) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Your progress storage is temporarily unavailable.');
  return { id: String(claims.sub), email: attrs.email || '', emailVerified: true };
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  try {
    const path = event.rawPath.replace(/\/$/, '');
    const method = event.requestContext.http.method;
    if (method === 'GET' && path === '/api/health') {
      return json(200, { status: 'ok', service: 'school-learning-simplified', release: process.env.RELEASE_SHA || 'local-preview', contentRelease: release || 'foundation' });
    }
    if (method === 'GET' && path === '/api/catalog') return json(200, await readContent<Catalog>(`${publicPrefix}/catalog.json`));
    const lessonMatch = path.match(/^\/api\/lessons\/([^/]+)$/);
    if (method === 'GET' && lessonMatch) {
      const chapter = await chapterFor(lessonMatch[1]);
      const language = event.queryStringParameters?.language || 'en';
      if (!chapter.languages.includes(language) || !['en', 'hi'].includes(language)) throw new HttpError(400, 'INVALID_LANGUAGE', 'Choose English or Hindi.');
      const mode = learningMode(event.queryStringParameters?.mode);
      return json(200, await readContent<Lesson | PracticeBank>(modeKey(chapter.id, language, mode)));
    }
    if (path.startsWith('/api/school/')) return await handleSchool(event, await verifiedUser(event));
    if (method === 'GET' && path === '/api/me') {
      const user = await verifiedUser(event);
      const now = new Date().toISOString();
      await db.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME, Key: { PK: `USER#${user.id}`, SK: 'PROFILE' },
        UpdateExpression: 'SET email = :email, emailVerified = :verified, createdAt = if_not_exists(createdAt, :now), updatedAt = :now',
        ExpressionAttributeValues: { ':email': user.email, ':verified': true, ':now': now },
      }));
      return json(200, user);
    }
    const practiceMatch = path.match(/^\/api\/practice\/([^/]+)\/(session|sessions|attempts)$/);
    if (practiceMatch) {
      learningMode('practice');
      const user = await verifiedUser(event);
      const chapter = await chapterFor(practiceMatch[1]);
      const pk = `USER#${user.id}`;
      const stateKey = { PK: pk, SK: `PRACTICE_STATE#${chapter.id}` };
      if (method === 'GET' && practiceMatch[2] === 'session') {
        const state = await db.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: stateKey, ConsistentRead: true }));
        if (!state.Item) return json(200, { session: null });
        const language = validLanguage(event.queryStringParameters?.language || state.Item.language || 'en');
        return json(200, { session: await practiceSession(user.id, chapter.id, state.Item.sessionId, language) });
      }
      if (method === 'PUT' && practiceMatch[2] === 'session') {
        const language = validLanguage(requestBody(event).language);
        const state = await db.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: stateKey, ConsistentRead: true }));
        if (!state.Item) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Start a practice round first.');
        await db.send(new UpdateCommand({ TableName: process.env.TABLE_NAME, Key: stateKey, UpdateExpression: 'SET #language = :language', ExpressionAttributeNames: { '#language': 'language' }, ExpressionAttributeValues: { ':language': language } }));
        return json(200, { session: await practiceSession(user.id, chapter.id, state.Item.sessionId, language) });
      }
      if (method === 'POST' && practiceMatch[2] === 'sessions') {
        const body = requestBody(event);
        const sessionId = validSessionId(body.sessionId);
        const language = validLanguage(body.language);
        const sessionKey = { PK: pk, SK: `PRACTICE#${chapter.id}#SESSION#${sessionId}` };
        const existing = await db.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: sessionKey, ConsistentRead: true }));
        if (!existing.Item) {
          const now = new Date().toISOString();
          try { await db.send(new TransactWriteCommand({ TransactItems: [
            { Put: { TableName: process.env.TABLE_NAME, Item: { ...sessionKey, kind: 'practice-session', chapterId: chapter.id, sessionId, startedAt: now }, ConditionExpression: 'attribute_not_exists(PK)' } },
            { Put: { TableName: process.env.TABLE_NAME, Item: { ...stateKey, sessionId, language, updatedAt: now } } },
          ] })); } catch (issue) {
            if ((issue as Error).name !== 'TransactionCanceledException') throw issue;
            const winner = await db.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: sessionKey, ConsistentRead: true }));
            if (!winner.Item) throw issue;
          }
        }
        return json(200, { session: await practiceSession(user.id, chapter.id, sessionId, language) });
      }
      if (method === 'POST' && practiceMatch[2] === 'attempts') {
        const body = requestBody(event);
        const sessionId = validSessionId(body.sessionId);
        const language = validLanguage(body.language);
        if (typeof body.questionId !== 'string') throw new HttpError(400, 'INVALID_QUESTION', 'Choose a question from this chapter.');
        const sessionKey = `PRACTICE#${chapter.id}#SESSION#${sessionId}`;
        const meta = await db.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: { PK: pk, SK: sessionKey }, ConsistentRead: true }));
        if (!meta.Item) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Start a practice round in your account first.');
        const bank = await readContent<PracticeBank>(modeKey(chapter.id, language, 'practice'));
        const question = bank.questions.find((item) => item.id === body.questionId);
        if (!question) throw new HttpError(400, 'INVALID_QUESTION', 'This question does not belong to the chapter.');
        const keys = await readContent<PrivateAnswers>(`${privatePrefix}/practice/${chapter.id}/${language}.json`);
        const answerKey = keys.answers[question.id];
        if (!answerKey) throw new HttpError(503, 'QUESTION_UNAVAILABLE', 'This question is temporarily unavailable.');
        let correct: boolean;
        try { correct = gradeOptions(question, answerKey, body.selectedOptionIds); }
        catch (issue) { throw new HttpError(400, 'INVALID_ANSWER', (issue as Error).message); }
        try {
          await db.send(new PutCommand({ TableName: process.env.TABLE_NAME, Item: {
            PK: pk, SK: `${sessionKey}#ANSWER#${question.id}`, kind: 'practice-answer', chapterId: chapter.id,
            sessionId, questionId: question.id, language, selectedOptionIds: body.selectedOptionIds,
            correct, answeredAt: new Date().toISOString(),
          }, ConditionExpression: 'attribute_not_exists(PK)' }));
        } catch (issue) { if ((issue as Error).name !== 'ConditionalCheckFailedException') throw issue; }
        // A retry reads the first recorded answer; it cannot award duplicate credit.
        return json(200, { session: await practiceSession(user.id, chapter.id, sessionId, language) });
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This practice action is not supported.');
    }
    const progressMatch = path.match(/^\/api\/progress\/([^/]+)$/);
    if (progressMatch && (method === 'GET' || method === 'PUT')) {
      const user = await verifiedUser(event);
      const chapter = await chapterFor(progressMatch[1]);
      const mode = learningMode(event.queryStringParameters?.mode);
      if (mode === 'practice') throw new HttpError(400, 'INVALID_MODE', 'Practice results are recorded with each answer.');
      const key = { PK: `USER#${user.id}`, SK: mode === 'learn' ? `PROGRESS#${chapter.id}` : `PROGRESS#${mode}#${chapter.id}` };
      if (method === 'GET') {
        const result = await db.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: key, ConsistentRead: true }));
        if (!result.Item) return json(200, { chapterId: chapter.id, currentCardId: null, completedCardIds: [], language: 'en', updatedAt: null });
        const item = result.Item;
        return json(200, { chapterId: chapter.id, currentCardId: item.currentCardId, completedCardIds: [...(item.completedCards || [])], language: item.language, updatedAt: item.updatedAt });
      }
      const body = requestBody(event);
      const language = body.language;
      if (language !== 'en' && language !== 'hi') throw new HttpError(400, 'INVALID_LANGUAGE', 'Choose English or Hindi.');
      const lesson = await readContent<Lesson>(modeKey(chapter.id, language, mode));
      const validCards = new Set(lesson.cards.map((card) => card.id));
      if (typeof body.currentCardId !== 'string' || !validCards.has(body.currentCardId) || !Array.isArray(body.completedCardIds) || body.completedCardIds.length > validCards.size || body.completedCardIds.some((id) => typeof id !== 'string' || !validCards.has(id))) {
        throw new HttpError(400, 'INVALID_PROGRESS', 'The progress update does not match this lesson.');
      }
      const now = new Date().toISOString();
      // ADD a string set so an older tab cannot erase recorded completed cards.
      const completed = [...new Set(body.completedCardIds as string[])];
      const result = await db.send(new UpdateCommand({
        TableName: process.env.TABLE_NAME, Key: key,
        UpdateExpression: `SET chapterId = :chapter, currentCardId = :card, #language = :language, updatedAt = :now${completed.length ? ' ADD completedCards :completed' : ''}`,
        ExpressionAttributeNames: { '#language': 'language' },
        ExpressionAttributeValues: { ':chapter': chapter.id, ':card': body.currentCardId, ':language': language, ':now': now, ...(completed.length ? { ':completed': new Set(completed) } : {}) },
        ReturnValues: 'ALL_NEW',
      }));
      const item = result.Attributes!;
      return json(200, { chapterId: chapter.id, currentCardId: item.currentCardId, completedCardIds: [...(item.completedCards || [])], language: item.language, updatedAt: item.updatedAt });
    }
    throw new HttpError(404, 'NOT_FOUND', 'This page could not be found.');
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.code, message: error.message });
    // Record only the exception category and request ID: never tokens, emails or bodies.
    console.error(JSON.stringify({ error: (error as Error).name, requestId: event.requestContext.requestId }));
    return json(503, { error: 'TEMPORARILY_UNAVAILABLE', message: 'Something is temporarily unavailable. Please try again.' });
  }
}
