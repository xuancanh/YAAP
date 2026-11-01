/** Sign-in screen (AUTH_MODE=accounts): email → "check your inbox". The link
 *  in the mail lands on the API callback, which sets the session cookie and
 *  redirects back here; the auth context then re-reads /api/auth/me. */
import { useState } from 'react';
import { api } from '../lib/api';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'sent'; mailed: boolean } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const theme = localStorage.getItem('yaam-theme') || 'dark';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || state.kind === 'busy') return;
    setState({ kind: 'busy' });
    try {
      const res = await api.requestLink(email.trim());
      setState({ kind: 'sent', mailed: res.sent });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      setState({ kind: 'error', message: /429/.test(msg) ? 'Too many links requested. Wait a few minutes and try again.' : /400/.test(msg) ? 'That does not look like an email address.' : 'Could not send a link. Try again.' });
    }
  };

  const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px', color: 'var(--text)', fontSize: 14, outline: 'none' };

  return (
    <div data-theme={theme} style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 380, background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 14, padding: '28px 28px 24px', boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,var(--accent),var(--blue))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', fontSize: 14 }}>Y</div>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-.2px' }}>Sign in to yaam</div>
        </div>
        {state.kind === 'sent' ? (
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Check your inbox</div>
            <div style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>
              {state.mailed
                ? <>We sent a sign-in link to <span style={{ color: 'var(--text)' }}>{email.trim()}</span>. It works once and expires in 15 minutes.</>
                : <>This server has no mail sender configured; the sign-in link was written to its log. Open it from there.</>}
            </div>
            <button onClick={() => setState({ kind: 'idle' })} style={{ marginTop: 18, background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 12.5, cursor: 'pointer', padding: 0 }}>Use a different address</button>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <div style={{ color: 'var(--text-dim)', marginBottom: 14, lineHeight: 1.5 }}>Passwordless: enter your email and we send you a one-time link. New addresses get an account on the free plan.</div>
            <input autoFocus type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" style={input} />
            {state.kind === 'error' && <div style={{ color: 'var(--red, #e5484d)', fontSize: 12.5, marginTop: 8 }}>{state.message}</div>}
            <button type="submit" disabled={state.kind === 'busy'} style={{ marginTop: 14, width: '100%', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: state.kind === 'busy' ? 0.7 : 1 }}>
              {state.kind === 'busy' ? 'Sending…' : 'Email me a link'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
