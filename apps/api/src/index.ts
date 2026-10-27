import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type Chapter = { id: string; title: string; languages: string[]; cardCount: number };
type Catalog = { schemaVersion: number; chapters: Chapter[] };
type Lesson = { id: string; language: string; cards: { id: string }[] };
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
  if (process.env.LOCAL_CONTENT_DIR && process.env.NODE_ENV !== 'production') {
    text = await readFile(resolve(process.env.LOCAL_CONTENT_DIR, key.replace(/^content\//, '')), 'utf8');
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
  const catalog = await readContent<Catalog>('content/catalog.json');
  const chapter = catalog.chapters.find((item) => item.id === id);
  if (!chapter) throw new HttpError(404, 'NOT_FOUND', 'That lesson is not in the library.');
  return chapter;
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
      return json(200, { status: 'ok', service: 'school-learning-simplified', release: process.env.RELEASE_SHA || 'local-preview' });
    }
    if (method === 'GET' && path === '/api/catalog') return json(200, await readContent<Catalog>('content/catalog.json'));
    const lessonMatch = path.match(/^\/api\/lessons\/([^/]+)$/);
    if (method === 'GET' && lessonMatch) {
      const chapter = await chapterFor(lessonMatch[1]);
      const language = event.queryStringParameters?.language || 'en';
      if (!chapter.languages.includes(language) || !['en', 'hi'].includes(language)) throw new HttpError(400, 'INVALID_LANGUAGE', 'Choose English or Hindi.');
      return json(200, await readContent<Lesson>(`content/lessons/${chapter.id}/${language}.json`));
    }
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
    const progressMatch = path.match(/^\/api\/progress\/([^/]+)$/);
    if (progressMatch && (method === 'GET' || method === 'PUT')) {
      const user = await verifiedUser(event);
      const chapter = await chapterFor(progressMatch[1]);
      const key = { PK: `USER#${user.id}`, SK: `PROGRESS#${chapter.id}` };
      if (method === 'GET') {
        const result = await db.send(new GetCommand({ TableName: process.env.TABLE_NAME, Key: key, ConsistentRead: true }));
        if (!result.Item) return json(200, { chapterId: chapter.id, currentCardId: null, completedCardIds: [], language: 'en', updatedAt: null });
        const item = result.Item;
        return json(200, { chapterId: chapter.id, currentCardId: item.currentCardId, completedCardIds: [...(item.completedCards || [])], language: item.language, updatedAt: item.updatedAt });
      }
      const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
      if (raw.length > 12_000) throw new HttpError(413, 'TOO_LARGE', 'This progress update is too large.');
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'INVALID_JSON', 'The progress update could not be read.'); }
      if (!body || typeof body !== 'object') throw new HttpError(400, 'INVALID_PROGRESS', 'The progress update could not be read.');
      const language = body.language;
      if (language !== 'en' && language !== 'hi') throw new HttpError(400, 'INVALID_LANGUAGE', 'Choose English or Hindi.');
      const lesson = await readContent<Lesson>(`content/lessons/${chapter.id}/${language}.json`);
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
