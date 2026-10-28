import { get, normalizeEmail, put, write, SchoolError, type VerifiedAccount } from '../school/index.js';

/** Only a fresh GetUser result may update this server-owned identity evidence. */
export async function syncVerifiedProfile(user: VerifiedAccount) {
  const PK = `USER#${user.id}`; const email = normalizeEmail(user.email);
  const previous = await get<Record<string, any>>(PK, 'PROFILE');
  if (previous?.email === email && previous.emailVerified === true) return;
  const timestamp = new Date().toISOString();
  const operation = put(PK, 'PROFILE', { ...previous, email, emailVerified: true, createdAt: previous?.createdAt || timestamp, updatedAt: timestamp });
  const conditions: string[] = []; const values: Record<string, unknown> = {};
  if (!previous) conditions.push('attribute_not_exists(PK)');
  else {
    for (const field of ['email', 'emailVerified']) {
      if (previous[field] === undefined) conditions.push(`attribute_not_exists(${field})`);
      else { conditions.push(`${field} = :${field}`); values[`:${field}`] = previous[field]; }
    }
  }
  try { await write([{ Put: { ...operation.Put, ConditionExpression: conditions.join(' AND '), ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) } }]); }
  catch (error) {
    if ((error as Error).name !== 'TransactionCanceledException' && !(error instanceof SchoolError && error.status === 409)) throw error;
    const current = await get<Record<string, any>>(PK, 'PROFILE');
    if (current?.email !== email || current.emailVerified !== true) throw new SchoolError(409, 'IDENTITY_CHANGED', 'Your account changed while reconnecting. Sign in again before continuing.');
  }
}
