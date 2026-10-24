# Android app and push notifications

The Android app is the same React web app wrapped with Capacitor 8, so it has the same screens, server and accounts as the browser.

## Getting the APK

Download it from the repository's **Releases** page, on the phone:

- **Latest build (main):** a pre-release that CI replaces on every merge to `main`.
- **Versions:** pushing a tag like `v0.1.0` publishes a release named after it.

Open the downloaded `lanesignal-<version>.apk` and allow *Install unknown apps* for your browser or file manager when Android asks. The release notes say the same.

Without the signing secrets below, the APK is **unsigned**: not signed with a release key, only with a throwaway debug key per build, so it can only be sideloaded. Android also refuses to install one such build over another, so uninstall the old version before installing a new one, then sign in again. Pull-request builds are only attached to their CI run (Actions → the run → **Artifacts**), not released.

To build it yourself you need JDK 21 and the Android SDK (platform 36):

```bash
npm ci
cd web && npm run android:apk      # → web/android/app/build/outputs/apk/debug/app-debug.apk
```

For FCM push in a local build, put `google-services.json` in `web/android/app/` and set `VITE_FCM_ENABLED=true` for the build (`VITE_FCM_ENABLED=true npm run android:apk`). CI does both when the secret exists.

### Signed release builds (install updates in place)

Without a signing key, every build is signed with a throwaway debug key, so Android refuses to install it over the previous one. Set up a key once and CI signs every APK on the Releases page with it. Either way below creates the same thing.

**From GitHub, no computer needed** (the key is made in a runner and goes straight into encrypted secrets):

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new): repository access *Only select repositories* → this one; permissions **Administration**, **Environments** and **Secrets**: *Read and write*; a short expiry (e.g. 1 day).
2. In the repository: Settings → Secrets and variables → Actions → New repository secret, named `SIGNING_SETUP_TOKEN`, with the token as its value.
3. Actions → **Android signing setup** → Run workflow (on `main`).
4. When it's green, delete the `SIGNING_SETUP_TOKEN` secret and the token. The next build of `main` is signed; to get one straight away, run Actions → **CI** → Run workflow on `main`. No backup of the key is kept this way; if the environment's secrets are ever deleted, phones need one more uninstall.

**From your computer** (also keeps a backup of the key):

```bash
scripts/android-signing-setup.sh            # or: scripts/android-signing-setup.sh owner/repo
```

Run it on your own machine (it needs a JDK's `keytool`, `openssl` and the GitHub CLI signed in with admin rights on the repository). It:

- creates a self-signed key (RSA 4096, valid about 27 years);
- creates the GitHub environment **android-signing**, which only `main` and `v*` tags may use, so pull request builds never see the key;
- stores the keystore and its passwords there as secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`);
- keeps a backup in `~/.lanesignal-signing/`. Keep a copy somewhere safe: if the key is lost, phones need one more uninstall.

The first signed build still needs the old (debug-signed) app uninstalled once; every build after that updates in place. The script refuses to replace an existing key, since that would mean another uninstall everywhere. If it fails part-way, run it again: it reuses the saved key.

- **Remove old repository secrets.** If you added `ANDROID_KEYSTORE_*` / `ANDROID_KEY_*` as repository secrets before, delete them: repository secrets reach every build, pull requests included. The script warns when it finds them.
- **Tags.** Anyone who can push a `v*` tag gets a build signed with the key. If others have write access, restrict who may create `v*` tags (a tag ruleset) or add required reviewers to the environment.

## Signing in

1. On first launch, enter the server URL (e.g. `https://lanesignal.example.com`) and sign in with your email and password.
2. If the server has no accounts yet, the app shows the setup screen, which needs the setup code (see [accounts](accounts.md)).

The server must be reachable over **HTTPS**; see [Reverse proxy](reverse-proxy.md). For testing over plain HTTP on a LAN only, build with `LANESIGNAL_ALLOW_HTTP=1 npm run android:sync`.

## Push notifications

Push goes out for **new escalations** and overseers' milestone **notices**, unless `LANESIGNAL_NOTIFY_ON` says otherwise (it can also add `blocked` or `completed`). Tapping a notification opens that escalation, or the lane for a notice. Pick one backend, or use both.

### ntfy (simplest, no Google account)

1. Choose a long, random topic name. On public `ntfy.sh`, anyone who knows the topic can read it.
2. Set `LANESIGNAL_NTFY_URL=https://ntfy.sh/<topic>`, or point it at your own ntfy server. Add `LANESIGNAL_NTFY_TOKEN` if the topic needs auth.
3. Install the ntfy app on your phone and subscribe to the topic.
4. Tapping a notification opens that alert in the LaneSignal app (through its `lanesignal://` link). With `LANESIGNAL_PUBLIC_URL` set, the notification also has an **Open in browser** button. If you read ntfy anywhere other than an Android phone with the LaneSignal app (ntfy web or desktop, iOS), set `LANESIGNAL_NTFY_OPEN=browser` so a tap opens the web app instead: the app link goes nowhere there.

### Firebase Cloud Messaging (native push in the LaneSignal app)

1. Create a Firebase project and add an Android app with the package name `dev.lanesignal.app`.
2. Download its `google-services.json` and save the whole file as the repository secret `GOOGLE_SERVICES_JSON`. CI builds push support into the APK only when this secret exists.
3. In Firebase → Project settings → Service accounts, generate a private key. Put the file in the stack (e.g. `./config/fcm-service-account.json`, mounted at `/config`) and set `LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE=/config/fcm-service-account.json`.
4. Install the new APK and sign in. It asks for notification permission and registers itself with the server.

With the Dockge stack, add the config mount to `volumes:`:

```yaml
      - ./config:/config:ro
```

Settings shows whether push is available: "Enabled for escalations", "Not included in this build", or "Server has no FCM credentials". In the browser it shows "Android app only".

### Quiet alerts

Questions that need you normally arrive as high priority: in the app's **Escalations** channel (pops up on screen and vibrates) or at ntfy priority 4. An instance admin can turn on **Settings → Alerts → Quiet** to send them as regular notifications instead: the **Lane updates** channel, or ntfy priority 3. It applies to everyone on the server and takes effect for the next notification. FCM still delivers them promptly; only how they show changes. To change just one phone instead, edit the Escalations channel in Android's settings for the app (Settings → Apps → LaneSignal → Notifications).
