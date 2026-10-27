import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

type Profile = { displayName: string; grade: number | null; curriculum: 'cbse' | 'other' | null; language: 'en' | 'hi' | null; setupStep: number; completed: boolean; version: number; updatedAt: string | null };
type Account = { id: string; emailVerified: boolean };
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-2' }));
const defaults = (): Profile => ({ displayName: '', grade: null, curriculum: null, language: null, setupStep: 0, completed: false, version: 0, updatedAt: null });
const json = (statusCode: number, data: unknown): APIGatewayProxyResultV2 => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(data) });
class PreferenceError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
function fail(status: number, code: string, message: string): never { throw new PreferenceError(status, code, message); }
function clean(value: Partial<Profile>): Profile {
  const { displayName, grade, curriculum, language, setupStep, completed, version, updatedAt } = { ...defaults(), ...value };
  return { displayName, grade, curriculum, language, setupStep, completed, version, updatedAt };
}

/** The caller supplies a freshly verified account; request fields cannot select another user's profile. */
export async function handlePreferences(event: APIGatewayProxyEventV2WithJWTAuthorizer, user: Account): Promise<APIGatewayProxyResultV2> {
  try {
    if (!user.id || !user.emailVerified) return fail(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before saving your learner preferences.');
    const method = event.requestContext.http.method;
    if (!['GET', 'PUT'].includes(method)) return fail(405, 'METHOD_NOT_ALLOWED', 'This preference action is not available.');
    const table = process.env.TABLE_NAME;
    if (!table) return fail(503, 'STORAGE_UNAVAILABLE', 'Your preferences could not be opened. Please try again.');
    const Key = { PK: `USER#${user.id}`, SK: 'LEARNER_PREFERENCES' };
    const result = await db.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }));
    const previous = clean(result.Item || {});
    if (method === 'GET') return json(200, { preferences: previous });
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    if (Buffer.byteLength(raw) > 2_000) return fail(413, 'TOO_LARGE', 'This preference update is too large.');
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { return fail(400, 'INVALID_JSON', 'Your preferences could not be read.'); }
    const fields = ['displayName', 'grade', 'curriculum', 'language', 'setupStep', 'completed', 'version'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) return fail(400, 'INVALID_FIELDS', 'Only learner preferences can be updated here.');
    if (!Number.isSafeInteger(body.version) || body.version !== previous.version) return fail(409, 'PREFERENCES_CHANGED', 'Your preferences changed in another session. Refresh and try again.');
    const next = { ...previous };
    if ('displayName' in body) {
      if (typeof body.displayName !== 'string' || !body.displayName.trim() || [...body.displayName.trim()].length > 60 || /[\u0000-\u001f\u007f]/.test(body.displayName)) return fail(400, 'INVALID_NAME', 'Enter a learner name of up to 60 characters.');
      next.displayName = body.displayName.trim();
    }
    if ('grade' in body) {
      if (!Number.isInteger(body.grade) || Number(body.grade) < 1 || Number(body.grade) > 12) return fail(400, 'INVALID_GRADE', 'Choose a class from 1 to 12.');
      next.grade = Number(body.grade);
    }
    if ('curriculum' in body) {
      if (body.curriculum !== 'cbse' && body.curriculum !== 'other') return fail(400, 'INVALID_CURRICULUM', 'Choose CBSE or another curriculum.');
      next.curriculum = body.curriculum;
    }
    if ('language' in body) {
      if (body.language !== 'en' && body.language !== 'hi') return fail(400, 'INVALID_LANGUAGE', 'Choose English or Hindi.');
      next.language = body.language;
    }
    if ('setupStep' in body) {
      if (!Number.isInteger(body.setupStep) || Number(body.setupStep) < 0 || Number(body.setupStep) > 5) return fail(400, 'INVALID_STEP', 'This setup step is not available.');
      next.setupStep = Number(body.setupStep);
    }
    if ('completed' in body) {
      if (typeof body.completed !== 'boolean') return fail(400, 'INVALID_SETUP', 'Complete each learner setup step first.');
      next.completed = body.completed;
    }
    if (next.completed && (!next.displayName || !next.grade || !next.curriculum || !next.language)) return fail(400, 'SETUP_INCOMPLETE', 'Choose a learner name, class, curriculum and language before finishing setup.');
    next.version = previous.version + 1; next.updatedAt = new Date().toISOString();
    try {
      await db.send(new PutCommand({ TableName: table, Item: { ...Key, ...next }, ConditionExpression: previous.version ? '#version = :version' : 'attribute_not_exists(PK)', ...(previous.version ? { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':version': previous.version } } : {}) }));
    } catch (issue) {
      if ((issue as Error).name === 'ConditionalCheckFailedException') return fail(409, 'PREFERENCES_CHANGED', 'Your preferences changed in another session. Refresh and try again.');
      throw issue;
    }
    return json(200, { preferences: clean(next) });
  } catch (issue) {
    if (issue instanceof PreferenceError) return json(issue.status, { error: issue.code, message: issue.message });
    throw issue;
  }
}
