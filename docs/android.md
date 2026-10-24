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

### Signed release builds

Add these repository secrets and CI also builds a release-signed APK, which the Releases page then carries instead (and which updates in place):

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

## Signing in

1. On first launch, enter the server URL (e.g. `https://lanesignal.example.com`) and sign in with your email and password.
2. If the server has no accounts yet, the app shows the setup screen, which needs the setup code (see [accounts](accounts.md)).

The server must be reachable over **HTTPS**; see [Reverse proxy](reverse-proxy.md). For testing over plain HTTP on a LAN only, build with `LANESIGNAL_ALLOW_HTTP=1 npm run android:sync`.

## Push notifications

Push goes out for **new escalations** only, unless `LANESIGNAL_NOTIFY_ON` adds `blocked` or `completed`. Tapping a notification opens that escalation. Pick one backend, or use both.

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
