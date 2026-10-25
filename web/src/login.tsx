import { App as CapApp } from '@capacitor/app';
import { useEffect, useState } from 'react';
import { accessGuards, accessTokens, finishAccessSignIn, startAccessSignIn } from './access-session.ts';
import { createClient, isNative, normalizeServer, publicApi, type Connection } from './api.ts';

type Mode = 'signin' | 'setup' | 'token' | 'access';

/**
 * Email/password sign-in; first-run admin setup when the server has no
 * accounts yet; and a fallback for static access tokens from the server config.
 * Behind Cloudflare Access (LANESIGNAL_CLOUDFLARE_ACCESS), the browser is already signed in by Access's
 * cookie, and the app signs in through Access's Managed OAuth in a Custom Tab.
 */
export function Login({ onConnected }: { onConnected: (c: Connection) => void }) {
  const [server, setServer] = useState('');
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = normalizeServer(server);

  // Browser on the LaneSignal server behind Access: Access's cookie already says who this is.
  useEffect(() => {
    if (isNative) return;
    let cancelled = false;
    fetch('/api/me')
      .then(async (res) => {
        if (cancelled) return;
        const body = (await res.json().catch(() => ({}))) as { cloudflareAccess?: boolean; role?: string; error?: string };
        if (res.ok && body.cloudflareAccess && body.role === 'human') onConnected({ server: '', token: '', kind: 'cloudflare' });
        else if (res.status === 403 && body.error) setError(body.error);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The app: Access sends the Custom Tab back to the app with the authorization code (also when it started the app).
  useEffect(() => {
    if (!isNative) return;
    const finish = (url: string | undefined) => {
      if (!url) return;
      finishAccessSignIn(url)
        .then(async (access) => {
          if (!access) return;
          setBusy(true);
          const c: Connection = { server: new URL(access.redirectUri).origin, token: '', kind: 'cloudflare', access };
          const me = await createClient(c, accessTokens(access)).me();
          if (me.role !== 'human') throw new Error('Cloudflare Access signed you in as an agent. Sign in with your account instead.');
          onConnected(c);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false));
    };
    void CapApp.getLaunchUrl().then((l) => finish(l?.url)).catch(() => {});
    const h = CapApp.addListener('appUrlOpen', (e) => finish(e.url));
    return () => void h.then((x) => x.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // In the app, find out whether Cloudflare Access guards the server (then that's the way in).
  useEffect(() => {
    if (!isNative || !base) return;
    let cancelled = false;
    const t = setTimeout(() => {
      accessGuards(base)
        .then((guarded) => !cancelled && setMode((m) => (guarded ? 'access' : m === 'access' ? 'signin' : m)))
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [base]);

  // Ask the server whether it still needs its first account (debounced while typing a URL).
  useEffect(() => {
    if (isNative && !base) return;
    let cancelled = false;
    const t = setTimeout(() => {
      publicApi
        .setupStatus(base)
        .then((s) => !cancelled && setMode((m) => (m === 'access' ? m : s.needsSetup ? 'setup' : m === 'setup' ? 'signin' : m)))
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [base]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'access') {
        await startAccessSignIn(base);
        return;
      }
      if (mode === 'token') {
        const c: Connection = { server: base, token: token.trim(), kind: 'token' };
        const me = await createClient(c).me();
        if (me.role !== 'human') throw new Error('That is an agent key. Sign in with your account instead.');
        onConnected(c);
        return;
      }
      if (mode === 'setup') await publicApi.setup(base, { name: name.trim(), email: email.trim(), password, code: code.trim() });
      const session = await publicApi.signIn(base, email.trim(), password);
      onConnected({ server: base, token: session, kind: 'session' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>LaneSignal</h1>
        {mode === 'setup' && (
          <p className="hint">
            This server has no accounts yet. Create the first one; it becomes the admin who can add everyone else. The
            setup code is in the server log (<code>docker compose logs lanesignal</code>) and in{' '}
            <code>/data/setup-code</code>.
          </p>
        )}
        {(isNative || server) && (
          <label>
            Server URL
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="https://lanesignal.example.com"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              required={isNative}
            />
          </label>
        )}
        {mode === 'access' ? (
          <p className="hint">
            This server is behind Cloudflare Access. Sign in with the account Access lets in (Google, or whatever your team
            uses); LaneSignal signs you in as the person with that email.
          </p>
        ) : mode === 'token' ? (
          <label>
            Access token
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
          </label>
        ) : (
          <>
            {mode === 'setup' && (
              <label>
                Setup code
                <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="off" autoCorrect="off" required />
              </label>
            )}
            {mode === 'setup' && (
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
              </label>
            )}
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoCapitalize="off"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                minLength={mode === 'setup' ? 10 : undefined}
                required
              />
            </label>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Connecting…' : mode === 'setup' ? 'Create admin account' : mode === 'access' ? 'Sign in with Cloudflare Access' : 'Sign in'}
        </button>
        {mode !== 'setup' && mode !== 'access' && (
          <button type="button" className="link" onClick={() => setMode(mode === 'token' ? 'signin' : 'token')}>
            {mode === 'token' ? 'Sign in with email instead' : 'Use an access token instead'}
          </button>
        )}
        {!isNative && !server && (
          <button type="button" className="link" onClick={() => setServer('https://')}>
            Connect to a different server
          </button>
        )}
      </form>
    </main>
  );
}
