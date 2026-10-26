/**
 * The app's own links, lanesignal://esc/<id>, lanesignal://lane/<project>/<id> or lanesignal://epic/<project>/<n>, as the hash
 * route they open; null for anything else.
 */
export function routeFromAppLink(url: string): string | null {
  const m = /^lanesignal:\/\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  const path = m[1].replace(/^\/+/, '').split(/[?#]/)[0];
  // Cloudflare Access and OIDC sign-ins return here; the sign-in screen handles them.
  if (/^(oauth|oidc)\/callback\/?$/.test(path)) return null;
  // Any app or web page can open these links: pass on only known screens with plain, decodable segments.
  const known = /^(esc|lane|epic|lanes|reqs|history|settings)(\/|$)/.test(path) && /^[A-Za-z0-9._~%/-]*$/.test(path);
  const decodable = path.split('/').every((part) => {
    try {
      decodeURIComponent(part);
      return true;
    } catch {
      return false;
    }
  });
  return known && decodable ? `#/${path}` : '#/';
}

/** The message an OIDC sign-in the app started failed with (lanesignal://oidc/callback?error=...). */
export function oidcError(url: string): string | null {
  const app = /^lanesignal:\/\/oidc\/callback\?(.*)$/i.exec(url.trim());
  return app ? new URLSearchParams(app[1]).get('error') : null;
}

/** The handoff code in a finished sign-in's return: `#oidc=<code>` in the browser, lanesignal://oidc/callback?code= in the app. */
export function oidcCode(url: string): string | null {
  const web = /#oidc=([\w-]+)$/.exec(url);
  if (web) return web[1];
  const app = /^lanesignal:\/\/oidc\/callback\?(.*)$/i.exec(url.trim());
  return app ? new URLSearchParams(app[1]).get('code') : null;
}
