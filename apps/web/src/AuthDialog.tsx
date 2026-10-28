import { uiText, uiError } from './uiCopy';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ConfirmForgotPasswordCommand, ConfirmSignUpCommand, ForgotPasswordCommand, InitiateAuthCommand, ResendConfirmationCodeCommand, SignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ArrowRight, Mail, ShieldCheck, X } from 'lucide-react';
import { ApiError, identityClient, request, saveSession, clearSession } from './api';
import type { Config, Language, User } from './types';

type Mode = 'signin' | 'signup' | 'verify' | 'forgot' | 'reset';
export function AuthDialog({ config, initialMode, onClose, onSignedIn, language = 'en' }: { config: Config; language?: Language; initialMode: 'signin' | 'signup'; onClose: () => void; onSignedIn: (user: User) => void }) {
  const copy = (source: string) => uiText(language, source);
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const ready = Boolean(config.userPoolClientId && config.userPoolId);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const switchMode = (next: Mode) => { if (busy) return; setMode(next); setError(''); setNotice(''); setPassword(''); };
  const client = () => identityClient(config);
  const username = email.trim().toLowerCase();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice('');
    try {
      if (!ready) throw new Error('Account setup is temporarily unavailable. Please try again shortly.');
      if (mode === 'signup') {
        const result = await client().send(new SignUpCommand({ ClientId: config.userPoolClientId, Username: username, Password: password, UserAttributes: [{ Name: 'email', Value: username }] }));
        setPassword(''); setMode(result.UserConfirmed ? 'signin' : 'verify');
        setNotice(result.UserConfirmed ? 'Your account is ready. Sign in to continue.' : 'We sent a verification code to your email. Check your inbox and spam folder.');
      } else if (mode === 'verify') {
        await client().send(new ConfirmSignUpCommand({ ClientId: config.userPoolClientId, Username: username, ConfirmationCode: code.trim() }));
        setMode('signin'); setCode(''); setNotice('Email verified. Sign in to continue.');
      } else if (mode === 'signin') {
        const result = await client().send(new InitiateAuthCommand({ ClientId: config.userPoolClientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: username, PASSWORD: password } }));
        const auth = result.AuthenticationResult;
        if (!auth?.AccessToken || !auth.RefreshToken) throw new Error('This account requires an additional sign-in step. Please reset your password or try again.');
        saveSession(auth.AccessToken, auth.RefreshToken, auth.ExpiresIn || 3600);
        try { const user = await request<User>(config, '/me', { authenticated: true }); if (!user.emailVerified) throw new ApiError('Verify your email before continuing.', 403); setPassword(''); onSignedIn(user); }
        catch (issue) { clearSession(); throw issue; }
      } else if (mode === 'forgot') {
        await client().send(new ForgotPasswordCommand({ ClientId: config.userPoolClientId, Username: username }));
        setMode('reset'); setNotice('If your account can be recovered, a reset code has been sent to your email.');
      } else {
        await client().send(new ConfirmForgotPasswordCommand({ ClientId: config.userPoolClientId, Username: username, ConfirmationCode: code.trim(), Password: password }));
        setPassword(''); setCode(''); setMode('signin'); setNotice('Password updated. You can now sign in.');
      }
    } catch (issue) {
      const problem = issue as Error;
      if (problem.name === 'UserNotConfirmedException') { setMode('verify'); setPassword(''); setError('Please verify your email first. Enter the code from your email or request another.'); }
      else if (problem.name === 'NotAuthorizedException' || problem.name === 'UserNotFoundException') setError('The email or password was not recognized. Please try again.');
      else if (problem.name === 'CodeMismatchException') setError('That code does not match. Check your email and try again.');
      else if (problem.name === 'ExpiredCodeException') setError('That code has expired. Request a new code and try again.');
      else if (problem.name === 'UsernameExistsException') setError('An account already uses this email. Sign in or reset your password.');
      else if (problem.name === 'InvalidPasswordException') setError('Use at least 10 characters, with an uppercase letter, lowercase letter and number.');
      else if (problem.name === 'LimitExceededException' || problem.name === 'TooManyRequestsException') setError('Too many attempts. Please wait a little before trying again.');
      else setError(problem.message || 'We could not finish that step. Please try again.');
    } finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError('');
    try { await client().send(new ResendConfirmationCodeCommand({ ClientId: config.userPoolClientId, Username: username })); setNotice('A new verification code has been sent.'); }
    catch { setError('We could not resend the code. Check the email address and try again shortly.'); }
    finally { setBusy(false); }
  }
  const titles: Record<Mode, string> = { signin: 'Welcome back.', signup: 'A little learning starts here.', verify: 'Check your inbox.', forgot: 'Let’s get you back in.', reset: 'Choose a fresh password.' };
  const actions: Record<Mode, string> = { signin: 'Sign in', signup: 'Create account', verify: 'Verify email', forgot: 'Send reset code', reset: 'Reset password' };
  return <dialog ref={dialog} className="auth-dialog" lang={language} aria-labelledby="auth-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClick={(event) => { if (!busy && event.target === dialog.current) onClose(); }}>
    <div className="auth-inner">
      <button className="icon-button close-dialog" aria-label={copy("Close sign-in form")} disabled={busy} onClick={onClose}><X size={21} /></button>
      <div className="dialog-symbol">{mode === 'verify' ? <Mail /> : <ShieldCheck />}</div>
      <p className="eyebrow">{copy("YOUR LEARNING SPACE")}</p><h2 id="auth-title">{copy(titles[mode])}</h2>
      <p className="muted">{copy(mode === 'signup' ? 'Save your place and pick up where curiosity left off.' : mode === 'verify' ? 'Use the code we sent to verify your email address.' : 'Your lessons and saved progress, all in one place.')}</p>
      {!ready && <p className="notice">{copy("Account setup is not available in this preview. Open the live website to sign in.")}</p>}
      <form onSubmit={submit}>
        <label>{copy("Email address")}<input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="you@example.com" /></label>
        {(mode === 'signin' || mode === 'signup' || mode === 'reset') && <label>{copy(mode === 'reset' ? 'New password' : 'Password')}<input type="password" name="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={mode === 'signin' ? undefined : 10} value={password} onChange={(e) => setPassword(e.target.value)} required />{mode !== 'signin' && <small>{copy("10+ characters with uppercase, lowercase and a number.")}</small>}</label>}
        {(mode === 'verify' || mode === 'reset') && <label>{copy("Email code")}<input name="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required minLength={6} maxLength={8} placeholder={copy("6-digit code")} /></label>}
        {error && <p className="form-error" role="alert">{uiError(language, error)}</p>}
        {notice && <p className="notice" role="status">{copy(notice)}</p>}
        <button className="button primary full" disabled={busy || !ready} type="submit">{copy(busy ? 'One moment…' : actions[mode])}<ArrowRight size={18} /></button>
      </form>
      <div className="auth-options">
        {mode === 'signin' && <><button className="text-button" disabled={busy} onClick={() => switchMode('forgot')}>{copy("Forgot password?")}</button><p>{copy("New here?")} <button className="text-button" disabled={busy} onClick={() => switchMode('signup')}>{copy("Create an account")}</button></p></>}
        {mode === 'signup' && <p>{copy("Already have an account?")} <button className="text-button" disabled={busy} onClick={() => switchMode('signin')}>{copy("Sign in")}</button></p>}
        {mode === 'verify' && <button className="text-button" onClick={resend} disabled={busy || !ready || !username}>{copy("Send a new code")}</button>}
        {mode !== 'signin' && mode !== 'signup' && <button className="text-button" disabled={busy} onClick={() => switchMode('signin')}>{copy("Back to sign in")}</button>}
      </div>
      <p className="auth-footnote">{copy("Students, parents and teachers use their own email accounts.")}</p>
    </div>
  </dialog>;
}
