# Sign in with Cloudflare Access (beta)

With [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/) in front of LaneSignal, people sign in with Google (or whatever identity provider your Cloudflare team uses) instead of a LaneSignal password. Access checks their email against its policy, and LaneSignal signs them in as the account with that email.

It's off by default. Turn it on with `LANESIGNAL_CLOUDFLARE_ACCESS=true`. It's a beta: it depends on Cloudflare's **Managed OAuth** for Access, which is new, so test it on your setup before relying on it.

## How it works

- **Browser:** Access signs you in with its own cookie, and passes every request on to LaneSignal with a signed token in the `Cf-Access-Jwt-Assertion` header. LaneSignal checks that token and opens the dashboard without a sign-in screen.
- **Android app:**
  1. When the server URL you enter turns out to be behind Access, the app shows **Sign in with Cloudflare Access**.
  2. It registers itself with Access's Managed OAuth, then opens Access's sign-in in a Chrome Custom Tab. This is OAuth 2.0 authorization code + PKCE.
  3. You sign in with Google, and Access checks your email against its policy.
  4. Access redirects to `https://<server>/oauth/callback`, which returns to the app. An [App Link](#optional-app-link) hands that URL straight to the app; without one, the page at that URL forwards it to `lanesignal://oauth/callback`.
  5. The app exchanges the code for an access token and a refresh token. The refresh token is stored encrypted with a key in the **Android Keystore**; the access token is kept only in memory.
  6. Every request carries `Authorization: Bearer <access token>`. Access checks the token at Cloudflare's edge and passes the request on with the same signed assertion a browser gets. The app refreshes the token shortly before it expires (15 minutes by default) and again whenever it's refused.
- **The server** verifies the assertion and refuses it unless all of these hold:
  - it's signed with your team's keys from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`;
  - it was issued by your team domain;
  - it's for your Access application (its AUD tag);
  - it hasn't expired;
  - it names an email.

  The email must belong to a LaneSignal account that exists and isn't banned. Otherwise the request is refused and the person is told so. Set `LANESIGNAL_CF_ACCESS_CREATE_ACCOUNTS=true` to give a new account (not an admin) to every email Access lets in instead.

Password sign-in, agent keys and static tokens keep working beside it. A request that carries a LaneSignal credential (`Authorization: Bearer ls_…`, a session or a static token) uses that credential, whoever Access says it is. If the credential is wrong or revoked, the request is refused; it doesn't fall back to the Access identity.

## 1. Cloudflare

In the Zero Trust dashboard (**Access controls → Applications**):

1. **Add a self-hosted application** for LaneSignal's hostname (e.g. `lanesignal.example.com`). Give it an **Allow** policy that includes the emails (or the email domain, or the group) who may use LaneSignal, with Google as the login method.
2. **Advanced settings → Managed OAuth:** turn it on, then:
   - **Allowed redirect URIs:** `https://lanesignal.example.com/oauth/callback`.
   - **Access token lifetime:** 15 minutes (the default) is fine. The app refreshes in the background.
   - **Grant session duration:** how long the app stays signed in without your opening the Custom Tab again, e.g. 2 weeks. Access re-checks the policy at every refresh.
   - **Dynamic client registration:** must be on (it is by default). The app registers itself.
3. **Advanced settings → CORS:** turn on **Bypass OPTIONS requests to origin**, so the app's preflight requests reach LaneSignal (which answers them for the app's origin).
4. **Bypass the callback.** Add a second self-hosted application for `lanesignal.example.com/oauth/callback`, with a single **Bypass** policy (Include: Everyone). It only forwards the code to the app, and the code is useless without the app's PKCE verifier. If you set up the [App Link](#optional-app-link), add `lanesignal.example.com/.well-known/assetlinks.json` to it as well: Google has to read that file without signing in.
5. Copy the application's **Application Audience (AUD) tag** (application → Additional settings / Overview) and your **team domain** (`<team>.cloudflareaccess.com`, under Settings → Team name).

Put LaneSignal behind Cloudflare with a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) (`cloudflared`) or a proxied DNS record, and don't leave another way in: the assertion can't be forged, but anything that bypasses Cloudflare also bypasses its policy for password sign-in.

## 2. LaneSignal

Add these to the stack's `.env` and recreate the container:

```bash
LANESIGNAL_CLOUDFLARE_ACCESS=true
LANESIGNAL_CF_ACCESS_TEAM_DOMAIN=myteam.cloudflareaccess.com
LANESIGNAL_CF_ACCESS_AUD=<the AUD tag>
LANESIGNAL_PUBLIC_URL=https://lanesignal.example.com
```

| Env var | Default | Notes |
|---|---|---|
| `LANESIGNAL_CLOUDFLARE_ACCESS` | `false` | The feature flag. On, the two below are required, or the server stops at startup with a message |
| `LANESIGNAL_CF_ACCESS_TEAM_DOMAIN` | | `myteam.cloudflareaccess.com` (https is assumed) |
| `LANESIGNAL_CF_ACCESS_AUD` | | The Access application's AUD tag. Comma-separate several if more than one Access application fronts LaneSignal |
| `LANESIGNAL_CF_ACCESS_CREATE_ACCOUNTS` | `false` | `true` gives an account (not an admin, with a random password) to every email Access lets in that has none. Off, an admin [adds people](accounts.md#people) first, with the email they sign in to Google with |
| `LANESIGNAL_ANDROID_CERT_SHA256` | | Optional, for the [App Link](#optional-app-link): the APK's signing-certificate SHA-256 fingerprints, comma-separated |

The first admin account is still created with the [setup code](accounts.md#first-run). LaneSignal never makes anyone an admin because of Access.

`LANESIGNAL_PUBLIC_URL` matters here: changes signed in through Access are refused unless they come from LaneSignal's own origin or the app (see [security](#security)).

## 3. Signing in

- **Browser:** open `https://lanesignal.example.com`. After Access's sign-in, the dashboard opens. **Sign out** ends the Access session (`/cdn-cgi/access/logout`).
- **App:** enter the server URL. When the app finds Access with Managed OAuth there, the password fields give way to **Sign in with Cloudflare Access**. Tap it and sign in with Google in the tab that opens; the app comes back signed in. **Sign out** revokes the app's refresh token at Cloudflare and deletes it from the phone.

Settings shows *through Cloudflare Access* next to your name. **Agent keys** and **People** work as usual. LaneSignal keeps a session for each person signed in through Access and uses it for those screens. **Change password** isn't shown: your Google account is your password.

When Access stops letting someone in (their refresh fails, or they're removed from the policy), the app shows *You were signed out*. Removing or banning their LaneSignal account cuts them off at once, as with a password sign-in. With `LANESIGNAL_CF_ACCESS_CREATE_ACCOUNTS=true`, a removed person gets a new, empty account the next time they sign in, so take them out of the Access policy as well, or ban them instead.

In the app, a server behind Access only offers Access sign-in: create the first admin account (with the setup code) in the browser.

## On your LAN

Access only signs people in when their requests go through Cloudflare. If the same hostname resolves straight to the server on your LAN, Cloudflare isn't in the path there, and you'd land on the password screen. To sign in with Cloudflare there too, add [sign-in with Cloudflare (OIDC)](oidc.md). It gives a LaneSignal session that works both ways, and the app keeps using Access's token through the tunnel.

## Optional: App Link

Without an App Link, the tab lands on `https://<server>/oauth/callback`, which forwards it to `lanesignal://oauth/callback` (if Chrome holds the redirect back, tap **Open LaneSignal** there). With one, Android opens the callback in the app directly. The callback host has to be built into the APK:

1. Set the repository variable `LANESIGNAL_APP_LINK_HOST` (Settings → Secrets and variables → Actions → Variables) to your server's host, e.g. `lanesignal.example.com`, and let CI build a new APK. For a local build: `LANESIGNAL_APP_LINK_HOST=lanesignal.example.com npm run android:apk`.
2. Set `LANESIGNAL_ANDROID_CERT_SHA256` on the server to the APK's signing-certificate SHA-256 (`keytool -list -v -keystore <keystore>` for a [signed build](android.md#signed-release-builds-install-updates-in-place); unsigned builds have a new key each time, so they can't use this). The server then serves `/.well-known/assetlinks.json`.
3. Bypass Access for `/.well-known/assetlinks.json` (step 4 above), and reinstall the app so Android verifies the link.

## Agents behind Access

Access sits in front of `/mcp` and the agent API too, so overseers need a way through. Agent keys still identify them to LaneSignal; Access only needs to let them past:

- **Service token:** create one under **Access controls → Service credentials**, add a **Service Auth** policy for it to the LaneSignal application, and send its headers with the agent key:

  ```bash
  claude mcp add --transport http lanesignal https://lanesignal.example.com/mcp \
    --header "Authorization: Bearer ls_…" \
    --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
  ```
- **Bypass** `lanesignal.example.com/mcp` for agents on a network you trust (an Access policy can also be limited to IP ranges).

Managed OAuth also answers unauthenticated requests with a `401` that names its OAuth endpoints, so MCP clients that support OAuth may offer to sign in through Access themselves. A person signed in that way gets the human tools, not an overseer's.

The service-token combination (an `Authorization` header that isn't Access's, next to the service-token headers, with Managed OAuth on) hasn't been tested against Cloudflare. Check it with `curl` before moving overseers over.

## Security

- The assertion is only trusted after its signature, issuer, audience and expiry check out. The signing keys are cached for an hour and re-read when a token names a new key, so Cloudflare's key rotation needs nothing from you. If Cloudflare can't be reached for the keys, sign-in through Access fails; LaneSignal never falls back to trusting an unchecked assertion.
- **Cross-site requests:** a browser sends Access's cookie on cross-site requests, which bearer tokens never are. So changes (anything but `GET`) signed in through Access are refused when their `Origin` is neither LaneSignal's own (its host, or `LANESIGNAL_PUBLIC_URL`) nor one of `LANESIGNAL_CORS_ORIGINS` (by default the Android app's, which include `https://localhost` and `http://localhost`). A request with no `Origin` is let through: browsers send one with every cross-site request and every same-origin change, and other clients can't use Access's cookie without signing in anyway.
- The app's Managed OAuth access token is opaque to LaneSignal: only Cloudflare can resolve it, and LaneSignal ignores it if it's passed on. The refresh token is stored only in the phone's Keystore-encrypted storage, and sent only to Cloudflare's token endpoint. While the app runs it's also held in the app's memory.
- Long-lived connections (the event stream) re-check the assertion. When it expires, the stream ends and the app reconnects with a fresh token.
- See also the [security model](security.md).
