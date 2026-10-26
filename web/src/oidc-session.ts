import { Browser } from '@capacitor/browser';
import { isNative } from './api.ts';
import type { AccessClient } from './cloudflare.ts';
import { pkce } from './cloudflare.ts';

/**
 * Sign-in with the server's OIDC provider (LANESIGNAL_OIDC_*): the server runs it with the provider and hands
 * back a one-time code, which only this client can redeem (with the PKCE verifier of the challenge it started
 * with). The result is a LaneSignal session, so it works with or without Cloudflare in the path.
 */

/** The sign-in in progress (in the browser, across the page loads it takes). */
const PENDING_KEY = 'lanesignal.oidcPending';
/** A sign-in not finished within this is abandoned (the server forgets it sooner). */
const PENDING_MAX_MS = 15 * 60_000;

export interface OidcPending {
  /** '' for the browser on the server's own origin. */
  server: string;
  verifier: string;
  startedAt: number;
  /** In the app behind Cloudflare Access: the Managed OAuth client it signed in with first. */
  access?: AccessClient;
}

export function readPending(): OidcPending | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const p = raw ? (JSON.parse(raw) as OidcPending) : null;
    return p && Date.now() - p.startedAt < PENDING_MAX_MS ? p : null;
  } catch {
    return null;
  }
}

export function clearPending() {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Opens the provider's sign-in: this page in the browser, a Custom Tab in the app. */
export async function startOidcSignIn(server: string, access?: AccessClient): Promise<void> {
  const { verifier, challenge } = await pkce();
  const pending: OidcPending = { server, verifier, startedAt: Date.now(), ...(access ? { access } : {}) };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = `${server}/api/oidc/start?challenge=${challenge}${isNative ? '&app=1' : ''}`;
  if (isNative) await Browser.open({ url });
  else location.assign(url);
}
