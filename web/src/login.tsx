import { useEffect, useState } from 'react';
import { createClient, isNative, normalizeServer, publicApi, type Connection } from './api.ts';

type Mode = 'signin' | 'setup' | 'token';

/**
 * Email/password sign-in; first-run admin setup when the server has no
 * accounts yet; and a fallback for static access tokens from the server config.
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

  // Ask the server whether it still needs its first account (debounced while typing a URL).
  useEffect(() => {
    if (isNative && !base) return;
    let cancelled = false;
    const t = setTimeout(() => {
      publicApi
        .setupStatus(base)
        .then((s) => !cancelled && setMode((m) => (s.needsSetup ? 'setup' : m === 'setup' ? 'signin' : m)))
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
        {mode === 'token' ? (
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
          {busy ? 'Connecting…' : mode === 'setup' ? 'Create admin account' : 'Sign in'}
        </button>
        {mode !== 'setup' && (
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
