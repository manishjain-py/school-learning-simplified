import { useEffect, useRef, useState } from 'react';
import { request } from '../api';
import type { Config } from '../types';
import { friendlySchoolTimestamp } from './dates';

type Status = 'pending' | 'sending' | 'accepted' | 'not_sent' | 'unknown' | 'superseded';
type Notification = { id: string; revision: number; recipient: string; status: Status; message: string; canRetry: boolean; hasPreview: boolean; acceptedAt?: string };
type Preview = { subject: string; html: string; acceptedAt: string };
const labels: Record<Status, string> = { pending: 'Email not sent yet', sending: 'Sending email', accepted: 'Accepted for sending', not_sent: 'Email not sent', unknown: 'Sending outcome unknown', superseded: 'Replaced by a newer update' };
const errorMessage = (issue: unknown) => issue instanceof Error ? issue.message : 'Email status could not be opened. Please refresh it.';
const previewCsp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'";

export function ParentEmailStatus({ config, userId, updatePath, revision, timeZone }: { config: Config; userId: string; updatePath: string; revision: number; timeZone: string }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const base = `${updatePath}/email`;
  useEffect(() => {
    generation.current++; pending.current = false; setBusy(false); setPreview(null); setNotifications([]); setActionError('');
    return () => { generation.current++; };
  }, [userId, base]);
  useEffect(() => {
    const abort = new AbortController(); generation.current++; pending.current = false;
    setLoading(true); setBusy(false); setError(''); setNotifications([]); setPreview(null);
    request<{ notifications: Notification[] }>(config, base, { authenticated: true, expectedUserId: userId, signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setNotifications(value.notifications); })
      .catch(issue => { if (!abort.signal.aborted) setError(errorMessage(issue)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [config, userId, base, revision, refresh]);

  async function act(item: Notification, action: 'preview' | 'retry') {
    if (pending.current || loading || error || (action === 'retry' && (!item.canRetry || !['pending', 'not_sent'].includes(item.status))) || (action === 'preview' && (item.status !== 'accepted' || !item.hasPreview))) return;
    const current = generation.current;
    pending.current = true; setBusy(true); setActionError(''); setPreview(null);
    const path = `${base}/${encodeURIComponent(String(item.revision))}/${encodeURIComponent(item.id)}/${action}`;
    try {
      if (action === 'preview') {
        const result = await request<Preview>(config, path, { authenticated: true, expectedUserId: userId });
        if (generation.current === current) setPreview(result);
      } else await request(config, path, { authenticated: true, expectedUserId: userId, method: 'POST' });
    } catch (issue) { if (generation.current === current) setActionError(errorMessage(issue)); }
    finally {
      if (generation.current === current) {
        pending.current = false; setBusy(false);
        // Always reconcile an uncertain retry response before offering another send.
        if (action === 'retry') { setLoading(true); setRefresh(value => value + 1); }
      }
    }
  }

  return <section className="parent-email-status" aria-label="Parent email status">
    <div className="parent-email-heading"><h4>Parent email</h4><button className="text-button" type="button" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>Refresh email status</button></div>
    {loading && <p className="school-help" role="status">Checking email status…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {!loading && !error && notifications.length === 0 && <p className="school-help">No email notification is recorded for this update. The family update is available in the app.</p>}
    {!loading && !error && notifications.map(item => <div className={`parent-email-recipient email-${item.status}`} key={`${item.revision}:${item.id}`}>
      <strong>{labels[item.status] || 'Email status unavailable'}</strong><span className="parent-email-address">{item.recipient}</span>
      <small>Update revision {item.revision}{item.acceptedAt ? ` · ${friendlySchoolTimestamp(item.acceptedAt, timeZone)}` : ''}</small>
      <p>{item.message}</p>
      {item.status === 'accepted' && <p className="school-help">The email provider accepted this message for sending. Inbox delivery is not confirmed.</p>}
      {item.status === 'unknown' && <p className="school-help">This message will not be sent again automatically.</p>}
      <div className="parent-email-actions">
        {item.canRetry && ['pending', 'not_sent'].includes(item.status) && <button className="button secondary" type="button" disabled={busy || loading || Boolean(error)} onClick={() => void act(item, 'retry')}>Try sending email</button>}
        {item.status === 'accepted' && item.hasPreview && <button className="text-button" type="button" disabled={busy || loading || Boolean(error)} onClick={() => void act(item, 'preview')}>View sent email</button>}
      </div>
    </div>)}
    {!loading && !error && preview && <section className="parent-email-preview" aria-label="Sent email preview">
      <div className="parent-email-heading"><h4>Sent email</h4><button className="text-button" type="button" onClick={() => setPreview(null)}>Close preview</button></div>
      <p><strong>{preview.subject}</strong></p><p className="school-help">Accepted for sending {friendlySchoolTimestamp(preview.acceptedAt, timeZone)}. This is the saved email content.</p>
      <iframe title="Saved parent email" sandbox="" referrerPolicy="no-referrer" srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="${previewCsp}"><meta name="referrer" content="no-referrer">${preview.html}`} />
    </section>}
  </section>;
}
