import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { CognitoIdentityProviderClient, InitiateAuthCommand, RevokeTokenCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ApiError, request, saveSession, session, signOutOnThisDevice } from './api';
import type { Config } from './types';

const config: Config = { apiBaseUrl: 'https://api.example.invalid', region: 'us-east-2', userPoolId: 'fictional-pool', userPoolClientId: 'fictional-client', release: 'test' };
const originalFetch = globalThis.fetch; const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
const originalIdentitySend = CognitoIdentityProviderClient.prototype.send;
let reads = 0;
beforeEach(() => {
  reads = 0; const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => { reads++; return values.get(key) || null; },
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
  } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  CognitoIdentityProviderClient.prototype.send = originalIdentitySend;
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const response = (status = 200) => new Response(JSON.stringify(status === 200 ? { ok: true } : { message: 'Service unavailable' }), { status });
const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;

test('API GET acquires a slot before resolving account identity; queued cancellation does not read auth', async () => {
  const first = deferred<Response>(); const second = deferred<Response>(); const fetched: string[] = [];
  globalThis.fetch = (async input => {
    const path = String(input); fetched.push(path);
    if (path.endsWith('/first')) return first.promise;
    if (path.endsWith('/second')) return second.promise;
    throw new Error('A stale queued account must not reach fetch');
  }) as typeof fetch;
  saveSession(token('parent-a'), 'fictional-refresh-a', 3600);
  const one = request(config, '/first'); const two = request(config, '/second');
  const queued = request(config, '/queued', { authenticated: true, expectedUserId: 'parent-a' });
  const rejected = assert.rejects(queued, issue => issue instanceof ApiError && issue.status === 401);
  const abort = new AbortController();
  const cancelled = assert.rejects(request(config, '/cancelled', { authenticated: true, expectedUserId: 'parent-a', signal: abort.signal }), { name: 'AbortError' });
  await tick(); assert.equal(reads, 0); assert.equal(fetched.length, 2); abort.abort(); await cancelled; assert.equal(reads, 0);
  saveSession(token('parent-b'), 'fictional-refresh-b', 3600);
  first.resolve(response()); await one; await rejected;
  assert.equal(reads, 1); assert.equal(fetched.length, 2);
  second.resolve(response()); await two;
});

test('POST and PUT bypass a full GET queue and never retry write failures', async () => {
  const first = deferred<Response>(); const second = deferred<Response>(); const calls: { path: string; method?: string }[] = [];
  globalThis.fetch = (async (input, options) => {
    const path = String(input); calls.push({ path, method: options?.method });
    if (path.endsWith('/first')) return first.promise;
    if (path.endsWith('/second')) return second.promise;
    return response(503);
  }) as typeof fetch;
  const one = request(config, '/first'); const two = request(config, '/second'); await tick();
  await assert.rejects(request(config, '/publish', { method: 'POST', body: { text: 'One publication' } }), { status: 503 });
  await assert.rejects(request(config, '/correct', { body: { version: 1 } }), { status: 503 });
  assert.deepEqual(calls.slice(2).map(call => call.method), ['POST', 'PUT']);
  first.resolve(response()); second.resolve(response()); await Promise.all([one, two]);
  assert.equal(calls.length, 4);
});

test('API GET retries transient 503 once with freshly resolved identity', async () => {
  let calls = 0; const observed: string[] = [];
  saveSession(token('parent-a'), 'fictional-refresh-a', 3600);
  globalThis.fetch = (async (_input, options) => {
    calls++; observed.push((options?.headers as Record<string, string>).Authorization);
    if (calls === 1) {
      saveSession(token('parent-b'), 'fictional-refresh-b', 3600);
      return response(503);
    }
    throw new Error('A retry must not reuse the first account’s token');
  }) as typeof fetch;
  await assert.rejects(request(config, '/private', { authenticated: true, expectedUserId: 'parent-a' }), { status: 401 });
  assert.equal(calls, 1); assert.equal(reads, 2); assert.deepEqual(observed, [`Bearer ${token('parent-a')}`]);
});

test('API GET retry succeeds once after throttling, while its backoff remains cancellable', async () => {
  let calls = 0;
  globalThis.fetch = (async () => response(++calls === 1 ? 429 : 200)) as typeof fetch;
  assert.deepEqual(await request(config, '/read'), { ok: true }); assert.equal(calls, 2);
  const abort = new AbortController(); calls = 0;
  globalThis.fetch = (async () => { calls++; return response(503); }) as typeof fetch;
  const pending = request(config, '/cancel-retry', { signal: abort.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); abort.abort(); await rejected; assert.equal(calls, 1);
});

test('device sign-out revokes only the captured refresh token once and cannot clear a later sign-in on failure', async () => {
  let calls = 0; let finish!: () => void; let attempts: Promise<number> | undefined;
  const pendingRevoke = new Promise((_resolve, reject) => { finish = () => reject(new Error('Connection unavailable')); });
  CognitoIdentityProviderClient.prototype.send = (function (this: CognitoIdentityProviderClient, command: unknown) {
    calls++; attempts = this.config.maxAttempts();
    assert(command instanceof RevokeTokenCommand);
    assert.deepEqual(command.input, { ClientId: config.userPoolClientId, Token: 'fictional-device-a-refresh' });
    assert.equal(session(), null, 'The local session is cleared before the remote operation.');
    return pendingRevoke;
  }) as typeof originalIdentitySend;
  saveSession(token('shared-judge'), 'fictional-device-a-refresh', 3600);
  const signingOut = signOutOnThisDevice(config);
  assert.equal(session(), null); assert.equal(calls, 1); assert.equal(await attempts, 1);
  saveSession(token('another-account'), 'fictional-new-refresh', 3600);
  finish(); await signingOut;
  assert.equal(session()?.refreshToken, 'fictional-new-refresh'); assert.equal(calls, 1);
});

test('a refresh already in flight cannot restore the session after device sign-out', async () => {
  const refresh = deferred<{ AuthenticationResult: { AccessToken: string; ExpiresIn: number } }>();
  const commands: unknown[] = []; let fetched = 0;
  CognitoIdentityProviderClient.prototype.send = (function (command: unknown) {
    commands.push(command);
    if (command instanceof InitiateAuthCommand) return refresh.promise;
    assert(command instanceof RevokeTokenCommand); return Promise.resolve({});
  }) as typeof originalIdentitySend;
  globalThis.fetch = (async () => { fetched++; return response(); }) as typeof fetch;
  saveSession(token('shared-judge'), 'fictional-device-a-refresh', -1);
  const reading = request(config, '/private', { authenticated: true, expectedUserId: 'shared-judge' });
  const rejected = assert.rejects(reading, { status: 401 });
  await tick(); assert.equal(commands.length, 1);
  await signOutOnThisDevice(config);
  refresh.resolve({ AuthenticationResult: { AccessToken: token('shared-judge'), ExpiresIn: 3600 } });
  await rejected;
  assert.equal(session(), null); assert.equal(fetched, 0); assert.equal(commands.length, 2);
});
