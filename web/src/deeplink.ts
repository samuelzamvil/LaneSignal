/**
 * The app's own links, lanesignal://esc/<id>, lanesignal://lane/<project>/<id> or lanesignal://epic/<project>/<n>, as the hash
 * route they open; null for anything else.
 */
export function routeFromAppLink(url: string): string | null {
  const m = /^lanesignal:\/\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  const path = m[1].replace(/^\/+/, '').split(/[?#]/)[0];
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
