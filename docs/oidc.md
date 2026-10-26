# Sign in with Cloudflare (or another OIDC provider)

LaneSignal can sign people in with an OpenID Connect provider and give them a LaneSignal session of its own. The usual provider is Cloudflare itself, through a Zero Trust **Access for SaaS** OIDC application. Cloudflare then signs people in with whatever login methods your team uses: the one-time PIN by default, or Google, GitHub and others you add in Zero Trust, with no change in LaneSignal. Google, Authentik, Keycloak and other OIDC providers work the same way.

It's off by default. It's useful next to [Cloudflare Access](cloudflare-access.md): Access only signs people in when their requests go through Cloudflare. On your LAN, with the same hostname resolving to the server directly, Cloudflare isn't in the path, and the Access sign-in doesn't work there. A session from this sign-in works both ways.

## How it works

1. The login page shows **Sign in with Cloudflare** (the label is configurable).
2. LaneSignal sends the browser, or the app's Custom Tab, to the provider. This is the authorization code flow with PKCE, a nonce, and a state cookie tied to the browser that started it.
3. The provider sends it back to `https://<server>/api/oidc/callback`. LaneSignal exchanges the code with its client secret, then checks the ID token: its signature (RS256, from the provider's published keys), issuer, audience, expiry and nonce.
4. LaneSignal signs in the account with that email. The ID token must say the email is verified (`email_verified: true`), unless `LANESIGNAL_OIDC_REQUIRE_VERIFIED_EMAIL=false`. Without an account, the person is told so, unless `LANESIGNAL_OIDC_CREATE_ACCOUNTS=true`. Nobody is made an admin by signing in this way.
   - The first sign-in ties the account to the provider's id for that person (`sub`). A later sign-in with the same email but another `sub` is refused (an address reused or reassigned at the provider). An admin clears that by removing and re-adding the account.
5. The browser or app gets a one-time code. It redeems the code for a session, using the PKCE verifier of the challenge it started with, so another app that catches the `lanesignal://` link can't use it.

**Re-checking with the provider.** When the provider issues a refresh token, LaneSignal uses it every `LANESIGNAL_OIDC_RECHECK_MINUTES` (15 by default) while the session is in use. When the provider answers `invalid_grant` (the refresh token expired or was revoked, or, where the provider re-checks its policy on refresh, you were removed from it), the session ends at once. When the provider can't be reached (no internet), or refuses LaneSignal itself (say, a rotated client secret), nothing changes, the log says why, and LaneSignal tries again on the next request. Agent keys made earlier with that session keep working until they're revoked, as after a password change. Without a refresh token, sessions last like password sessions (`LANESIGNAL_SESSION_DAYS`); the log says so at each sign-in.

Removing or banning the LaneSignal account ends the session at once, as with a password sign-in.

## 1. Cloudflare

In the Zero Trust dashboard (**Access controls → Applications**):

1. **Add an application → SaaS**, and pick **OIDC**.
2. **Redirect URLs:** `https://lanesignal.example.com/api/oidc/callback`. This must be the address you open LaneSignal at, on the LAN too.
3. **Scopes:** `openid`, `email`, `profile`.
4. **Refresh tokens:** turn them on (Advanced settings) so LaneSignal can re-check sessions. Keep their lifetime shorter than your team's global session duration.
5. **Policy:** the same people as your LaneSignal application.
6. Copy the **Client ID**, **Client secret** and **Issuer** (`https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>`).

If LaneSignal is behind a [Cloudflare Access application](cloudflare-access.md), add a **Bypass** policy for `lanesignal.example.com/api/oidc` (as for `/oauth/callback`). The sign-in pages there are protected by their own state, PKCE and one-time codes. Without the bypass, they still work, with an extra trip through Access's login.

## 2. LaneSignal

```bash
LANESIGNAL_PUBLIC_URL=https://lanesignal.example.com
LANESIGNAL_OIDC_ISSUER=https://myteam.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>
LANESIGNAL_OIDC_CLIENT_ID=<client id>
LANESIGNAL_OIDC_CLIENT_SECRET=<client secret>
```

| Env var | Default | Notes |
|---|---|---|
| `LANESIGNAL_OIDC_ISSUER` | | Turns it on. The provider's issuer URL (https); its discovery document is read from `<issuer>/.well-known/openid-configuration` |
| `LANESIGNAL_OIDC_CLIENT_ID` | | Required |
| `LANESIGNAL_OIDC_CLIENT_SECRET` | | Required. LaneSignal is a confidential client: the secret stays on the server |
| `LANESIGNAL_OIDC_LABEL` | `Cloudflare` | The button reads "Sign in with <label>" |
| `LANESIGNAL_OIDC_SCOPES` | `openid email profile` | Space- or comma-separated. Some providers need `offline_access` for a refresh token |
| `LANESIGNAL_OIDC_REQUIRE_VERIFIED_EMAIL` | `true` | Refuse ID tokens that don't say `email_verified: true`. Set `false` only for a provider that verifies every email but leaves the claim out; the sign-in error says when that's the case |
| `LANESIGNAL_OIDC_CREATE_ACCOUNTS` | `false` | `true` gives every verified email the provider signs in an account (not an admin). Off, an admin [adds people](accounts.md#people) first |
| `LANESIGNAL_OIDC_RECHECK_MINUTES` | `15` | How often a session is re-checked with the provider, 1 to 1440 |
| `LANESIGNAL_PASSWORD_FAILOVER_KEY` | | Optional, see [failover](#password-failover). At least 16 characters: letters, digits and `. _ ~ -` |

`LANESIGNAL_PUBLIC_URL` is required and must be https: the provider sends people back to `<public URL>/api/oidc/callback`. A half-configured provider stops the server at startup with a message.

## Password failover

By default the login page offers the provider's button and the password form. With `LANESIGNAL_PASSWORD_FAILOVER_KEY` set:

- The login page offers only **Sign in with Cloudflare**.
- Password sign-in moves to `https://lanesignal.example.com/?failover=<key>`, and only admins can use it. The page takes the key out of the address bar once it's read.
- The server refuses every password sign-in that doesn't carry the key, whatever page or client it comes from. With the key, a non-admin is still refused.
- In the app, **Admin sign-in with the failover key** on the sign-in screen asks for the key, email and password. It's offered when the app can reach the server without Cloudflare Access in the way, e.g. on the LAN.

Keep the key somewhere safe, like a password: it's the way in when the provider is down. It's a second thing to know, not a secret that protects much on its own, because it travels in a URL. Static tokens aren't affected. First-run setup still creates the first admin with a password; after it, sign in with the provider or on the failover page.

## Signing in

- **Browser:** **Sign in with Cloudflare**, at `LANESIGNAL_PUBLIC_URL`'s address (at any other address the page links there instead). If Cloudflare already knows you, it returns at once. The session works through the tunnel and on the LAN. Through the tunnel, [Cloudflare Access](cloudflare-access.md) still signs you in without a click, as before.
- **App, through the tunnel:** **Sign in with Cloudflare Access** signs in with Access (as before), then with the provider. Usually the second step needs no input, because the Custom Tab already has your Cloudflare login. If it fails (say, the provider's sign-in has no LaneSignal account for you while Access creates accounts), the app carries on signed in with Access alone, as before. The app keeps both: Access's token gets requests past Cloudflare, and the LaneSignal session (sent in `X-LaneSignal-Session`) signs you in, also on the LAN. If Cloudflare can't be reached for a fresh Access token (no internet), the app sends the session alone.
- **App, on the LAN:** **Sign in with Cloudflare** gives a session that works on the LAN. To use the app through the tunnel too, sign in once while away from the LAN, so it also gets Access's token.

Sign out ends the LaneSignal session (and, in the app, revokes Access's refresh token). It doesn't sign you out of Cloudflare.
