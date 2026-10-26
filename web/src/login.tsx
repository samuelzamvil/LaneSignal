import { App as CapApp } from '@capacitor/app';
import { useEffect, useState } from 'react';
import { accessGuards, accessTokens, finishAccessSignIn, startAccessSignIn } from './access-session.ts';
import { createClient, isNative, normalizeServer, publicApi, type Connection, type SignInOptions } from './api.ts';
import type { AccessClient } from './cloudflare.ts';
import { oidcCode, oidcError } from './deeplink.ts';
import { clearPending, readPending, startOidcSignIn } from './oidc-session.ts';

type Mode = 'signin' | 'setup' | 'token' | 'access' | 'failover';

/** OIDC returns already handled (in this run of the app): the link that started the app is handed out again. */
const handledReturns = new Set<string>();

/** The failover key from a `?failover=<key>` link, taken out of the address bar once read. */
function failoverKeyFromUrl(): string {
  if (isNative) return '';
  const params = new URLSearchParams(location.search);
  const key = params.get('failover') ?? '';
  if (key) {
    params.delete('failover');
    const rest = params.toString();
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  }
  return key;
}

/**
 * Email/password sign-in; first-run admin setup when the server has no
 * accounts yet; and a fallback for static access tokens from the server config.
 * Behind Cloudflare Access (LANESIGNAL_CLOUDFLARE_ACCESS), the browser is already signed in by Access's
 * cookie, and the app signs in through Access's Managed OAuth in a Custom Tab.
 * With an OIDC provider (LANESIGNAL_OIDC_*), "Sign in with <provider>" gets a LaneSignal session that works with
 * or without Cloudflare in the path; with a failover key, passwords are only on the failover page, for admins.
 */
export function Login({ onConnected }: { onConnected: (c: Connection) => void }) {
  const [server, setServer] = useState('');
  const [mode, setMode] = useState<Mode>('signin');
  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [failoverKey, setFailoverKey] = useState(failoverKeyFromUrl);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = normalizeServer(server);

  // Opened with ?failover=<key>: the failover page.
  useEffect(() => {
    if (failoverKey) setMode('failover');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Signs in with the session from a finished OIDC sign-in (`access`: the app behind Cloudflare Access). */
  async function connectOidc(server: string, session: string, access?: AccessClient) {
    const c: Connection = { server, token: session, kind: 'session', ...(access ? { access } : {}) };
    const me = await createClient(c, access ? accessTokens(access) : undefined).me();
    if (me.role !== 'human') throw new Error('That sign-in is an agent. Sign in with your account instead.');
    onConnected(c);
  }

  /** Signed in with Cloudflare Access in the app: connect with Access alone (as before OIDC sign-in existed). */
  async function connectAccess(access: AccessClient) {
    const c: Connection = { server: new URL(access.redirectUri).origin, token: '', kind: 'cloudflare', access };
    const me = await createClient(c, accessTokens(access)).me();
    if (me.role !== 'human') throw new Error('Cloudflare Access signed you in as an agent. Sign in with your account instead.');
    onConnected(c);
  }

  /** Finishes an OIDC sign-in from its return (redeeming its code), if `url` is one. */
  function finishOidc(url: string) {
    const code = oidcCode(url);
    const failed = oidcError(url);
    if (!code && failed === null) return false;
    if (handledReturns.has(url)) return true;
    handledReturns.add(url);
    const pending = readPending();
    clearPending();
    if (!pending) {
      setError(failed ?? 'That sign-in expired. Try again.');
      return true;
    }
    setBusy(true);
    (async () => {
      try {
        if (!code) throw new Error(failed!);
        const edge = pending.access ? await accessTokens(pending.access).token() : undefined;
        const session = await publicApi.redeemOidc(pending.server, code, pending.verifier, edge);
        await connectOidc(pending.server, session, pending.access);
      } catch (err) {
        // Behind Access the app is signed in already: carry on with Access alone (it works through the tunnel).
        if (pending.access) await connectAccess(pending.access);
        else throw err;
      }
    })()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
    return true;
  }

  // Browser: back from the OIDC provider (#oidc=<code>), or on the LaneSignal server behind Access, whose cookie
  // already says who this is.
  useEffect(() => {
    if (isNative) return;
    if (location.hash.startsWith('#oidc=')) {
      const url = location.href;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      finishOidc(url);
      return;
    }
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

  // The app: a Custom Tab comes back with Access's authorization code, or the OIDC sign-in's (also when it started the app).
  useEffect(() => {
    if (!isNative) return;
    const finish = (url: string | undefined) => {
      if (!url || finishOidc(url)) return;
      finishAccessSignIn(url)
        .then(async (access) => {
          if (!access) return;
          setBusy(true);
          const server = new URL(access.redirectUri).origin;
          // With an OIDC provider as well, sign in with it too: its session also works on the LAN, without Access.
          const found = await publicApi.setupStatus(server, await accessTokens(access).token()).catch(() => null);
          if (found?.oidc) {
            await startOidcSignIn(server, access);
            return;
          }
          await connectAccess(access);
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

  // Ask the server how people sign in, and whether it still needs its first account (debounced while typing a URL).
  useEffect(() => {
    if (isNative && !base) return;
    let cancelled = false;
    const t = setTimeout(() => {
      publicApi
        .setupStatus(base)
        .then((s) => {
          if (cancelled) return;
          setOptions(s);
          setMode((m) => (m === 'access' ? m : s.needsSetup ? 'setup' : m === 'setup' ? 'signin' : m));
        })
        .catch(() => !cancelled && setOptions(null));
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [base]);

  async function signInWithOidc() {
    setBusy(true);
    setError(null);
    try {
      await startOidcSignIn(base);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

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
      if (mode === 'setup') {
        await publicApi.setup(base, { name: name.trim(), email: email.trim(), password, code: code.trim() });
        // Passwords need the failover key here, which isn't on this page.
        if (options?.passwordFailover) {
          setMode('signin');
          setNotice(`Admin account created. Sign in with ${options.oidc?.label ?? 'the provider'}, or with your password on the failover page.`);
          return;
        }
      }
      const key = mode === 'failover' ? failoverKey.trim() : undefined;
      const session = await publicApi.signIn(base, email.trim(), password, key);
      onConnected({ server: base, token: session, kind: 'session' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // In the browser, only at the server's public address: the provider sends people back to that page.
  const offered = (mode === 'signin' || mode === 'token') && (isNative || !server) ? options?.oidc : undefined;
  const elsewhere = !isNative && offered && offered.origin !== location.origin ? offered : undefined;
  const oidc = elsewhere ? undefined : offered;
  /** Passwords (and static tokens) on the main page, unless they moved to the failover page. */
  const passwords = mode !== 'signin' && mode !== 'token' ? true : !options?.passwordFailover;

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
        {mode === 'failover' && <p className="hint">Failover sign-in: admins sign in with their password here.</p>}
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
        {notice && <p className="hint">{notice}</p>}
        {elsewhere && (
          <p className="hint">
            To sign in with {elsewhere.label}, open LaneSignal at <a href={elsewhere.origin}>{elsewhere.origin}</a>.
          </p>
        )}
        {oidc && (
          <>
            <button type="button" className="primary" disabled={busy} onClick={() => void signInWithOidc()}>
              {busy ? 'Connecting…' : `Sign in with ${oidc.label}`}
            </button>
            {passwords && <div className="or">or</div>}
          </>
        )}
        {mode === 'access' ? (
          <p className="hint">
            This server is behind Cloudflare Access. Sign in with the account Access lets in (Google, or whatever your team
            uses); LaneSignal signs you in as the person with that email.
          </p>
        ) : !passwords ? null : mode === 'token' ? (
          <label>
            Access token
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
          </label>
        ) : (
          <>
            {mode === 'failover' && isNative && (
              <label>
                Failover key
                <input
                  type="password"
                  value={failoverKey}
                  onChange={(e) => setFailoverKey(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  required
                />
              </label>
            )}
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
        {(passwords || mode === 'access') && (
          <button className={oidc ? undefined : 'primary'} disabled={busy}>
            {busy && !oidc
              ? 'Connecting…'
              : mode === 'setup'
                ? 'Create admin account'
                : mode === 'access'
                  ? 'Sign in with Cloudflare Access'
                  : 'Sign in'}
          </button>
        )}
        {passwords && (mode === 'signin' || mode === 'token') && (
          <button type="button" className="link" onClick={() => setMode(mode === 'token' ? 'signin' : 'token')}>
            {mode === 'token' ? 'Sign in with email instead' : 'Use an access token instead'}
          </button>
        )}
        {isNative && options?.passwordFailover && mode === 'signin' && (
          <button type="button" className="link" onClick={() => (setMode('failover'), setError(null))}>
            Admin sign-in with the failover key
          </button>
        )}
        {mode === 'failover' && (
          <button type="button" className="link" onClick={() => (setMode('signin'), setFailoverKey(''), setError(null))}>
            Back to sign-in
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
