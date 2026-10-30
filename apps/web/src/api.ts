import { CognitoIdentityProviderClient, InitiateAuthCommand, RevokeTokenCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { Config } from './types';
import { checkRequestSignal, createGetRequestQueue } from './getRequestQueue';

type Session = { accessToken: string; refreshToken: string; expiresAt: number; subject: string };
const key = 'sls.session.v1';
let refreshing: Promise<Session> | null = null;
let refreshingOwner = '';
const scheduleGet = createGetRequestQueue();
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
function tokenSubject(token: string): string {
  // This only prevents cross-account queued UI writes; the gateway and API still
  // verify the token and identity independently before any data access.
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || ''; } catch { return ''; }
}
export function session(): Session | null {
  try { const value = JSON.parse(sessionStorage.getItem(key) || 'null'); return value?.accessToken && value?.refreshToken ? { ...value, subject: tokenSubject(value.accessToken) } : null; } catch { return null; }
}
export function saveSession(accessToken: string, refreshToken: string, expiresIn: number) {
  const value = { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000, subject: tokenSubject(accessToken) };
  sessionStorage.setItem(key, JSON.stringify(value)); return value;
}
export function clearSession() { sessionStorage.removeItem(key); }
/** Clear this browser session immediately; revoke only its captured refresh token. */
export async function signOutOnThisDevice(config: Config | null): Promise<void> {
  const saved = session();
  clearSession();
  if (!saved || !config?.userPoolClientId) return;
  const client = new CognitoIdentityProviderClient({ region: config.region, maxAttempts: 1 });
  try {
    await client.send(new RevokeTokenCommand({ ClientId: config.userPoolClientId, Token: saved.refreshToken }), { abortSignal: AbortSignal.timeout(5_000) });
  } catch {
    // Local sign-out is complete even offline. Never fall back to global sign-out
    // or clear a new account that signed in while this request was in flight.
  } finally { client.destroy(); }
}
export function identityClient(config: Config) { return new CognitoIdentityProviderClient({ region: config.region }); }
async function accessToken(config: Config): Promise<string> {
  const saved = session();
  if (!saved) throw new ApiError('Sign in to save your learning progress.', 401);
  if (saved.expiresAt > Date.now() + 60_000) return saved.accessToken;
  if (!refreshing || refreshingOwner !== saved.refreshToken) {
    refreshingOwner = saved.refreshToken;
    refreshing = identityClient(config).send(new InitiateAuthCommand({ ClientId: config.userPoolClientId, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { REFRESH_TOKEN: saved.refreshToken } }))
      .then((result) => {
        if (!result.AuthenticationResult?.AccessToken) throw new Error('Session ended');
        if (session()?.refreshToken !== saved.refreshToken) throw new Error('Account changed');
        return saveSession(result.AuthenticationResult.AccessToken, saved.refreshToken, result.AuthenticationResult.ExpiresIn || 3600);
      }).catch((issue: Error) => {
        if (session()?.refreshToken !== saved.refreshToken) throw new ApiError('The account changed. Please sign in again.', 401);
        if (['NotAuthorizedException', 'UserNotFoundException', 'InvalidParameterException'].includes(issue.name)) { clearSession(); throw new ApiError('Your session has ended. Please sign in again.', 401); }
        throw new Error('Your account could not reconnect. Check your connection and try again.');
      }).finally(() => { if (refreshingOwner === saved.refreshToken) { refreshing = null; refreshingOwner = ''; } });
  }
  return (await refreshing).accessToken;
}
export async function request<T>(config: Config, path: string, options: { authenticated?: boolean; expectedUserId?: string; body?: unknown; method?: 'GET' | 'PUT' | 'POST'; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method || (options.body ? 'PUT' : 'GET');
  const attempt = async () => {
    checkRequestSignal(options.signal);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.authenticated) {
      // GETs reach this only after obtaining a slot, including on their one retry.
      const token = await accessToken(config);
      checkRequestSignal(options.signal);
      if (options.expectedUserId && tokenSubject(token) !== options.expectedUserId) throw new ApiError('The account changed. Open this lesson again to continue.', 401);
      headers.Authorization = `Bearer ${token}`;
    }
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${config.apiBaseUrl}${path}`, { method, headers, body: options.body ? JSON.stringify(options.body) : undefined, signal: options.signal });
    const data = await response.json().catch((issue: Error) => {
      if (issue.name === 'AbortError' || options.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
      return { message: 'The server returned an unexpected response. Please try again.' };
    });
    checkRequestSignal(options.signal);
    if (!response.ok) throw new ApiError(data.message || 'Please try again shortly.', response.status);
    return data as T;
  };
  return method === 'GET' ? scheduleGet(attempt, options.signal) : attempt();
}
