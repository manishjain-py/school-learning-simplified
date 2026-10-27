import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { Config } from './types';

type Session = { accessToken: string; refreshToken: string; expiresAt: number; subject: string };
const key = 'sls.session.v1';
let refreshing: Promise<Session> | null = null;
let refreshingOwner = '';
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
      }).catch(() => { if (session()?.refreshToken === saved.refreshToken) clearSession(); throw new ApiError('Your session has ended. Please sign in again.', 401); }).finally(() => { if (refreshingOwner === saved.refreshToken) { refreshing = null; refreshingOwner = ''; } });
  }
  return (await refreshing).accessToken;
}
export async function request<T>(config: Config, path: string, options: { authenticated?: boolean; expectedUserId?: string; body?: unknown; method?: 'GET' | 'PUT' | 'POST'; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.authenticated) {
    const token = await accessToken(config);
    if (options.expectedUserId && tokenSubject(token) !== options.expectedUserId) throw new ApiError('The account changed. Open this lesson again to continue.', 401);
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${config.apiBaseUrl}${path}`, { method: options.method || (options.body ? 'PUT' : 'GET'), headers, body: options.body ? JSON.stringify(options.body) : undefined, signal: options.signal });
  const data = await response.json().catch(() => ({ message: 'The server returned an unexpected response. Please try again.' }));
  if (!response.ok) throw new ApiError(data.message || 'Please try again shortly.', response.status);
  return data as T;
}
