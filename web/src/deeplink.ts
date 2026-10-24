/**
 * The app's own links, lanesignal://esc/<id> or lanesignal://lane/<project>/<id>, as the hash
 * route they open; null for anything else.
 */
export function routeFromAppLink(url: string): string | null {
  const m = /^lanesignal:\/\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  const path = m[1].replace(/^\/+/, '').split(/[?#]/)[0];
  return /^(esc|lane|lanes|reqs|settings)(\/|$)/.test(path) ? `#/${path}` : '#/';
}
