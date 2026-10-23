# Android app and push notifications

The Android app is the same React web app wrapped with Capacitor 8, so it has the same screens, server and accounts as the browser.

## Getting the APK

CI builds an APK for every pull request and every merge to `main`:

1. Open the repository's **Actions** tab and pick the latest **CI** run on `main`.
2. Download the **`lanesignal-apk`** artifact (a zip containing `app-debug.apk`).
3. On the phone, allow *Install unknown apps* for your browser or file manager, then open the APK.

To build it yourself you need JDK 21 and the Android SDK (platform 36):

```bash
npm ci
cd web && npm run android:apk      # → web/android/app/build/outputs/apk/debug/app-debug.apk
```

For FCM push in a local build, put `google-services.json` in `web/android/app/` and set `VITE_FCM_ENABLED=true` for the build (`VITE_FCM_ENABLED=true npm run android:apk`). CI does both when the secret exists.

### Signed release builds

Add these repository secrets and CI also builds `app-release.apk`:

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
4. Set `LANESIGNAL_PUBLIC_URL` so tapping a notification opens the escalation in LaneSignal.

### Firebase Cloud Messaging (native push in the LaneSignal app)

1. Create a Firebase project and add an Android app with the package name `dev.lanesignal.app`.
2. Download its `google-services.json` and save the whole file as the repository secret `GOOGLE_SERVICES_JSON`. CI builds push support into the APK only when this secret exists.
3. In Firebase → Project settings → Service accounts, generate a private key. Put the file in the stack (e.g. `./config/fcm-service-account.json`, mounted at `/config`) and set `LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE=/config/fcm-service-account.json`.
4. Install the new APK and sign in. It asks for notification permission and registers itself with the server.

With the Dockge stack, add the config mount to `volumes:`:

```yaml
      - ./config:/config:ro
```

Settings shows whether push is available: "Enabled for human decisions", "Not included in this build", or "Server has no FCM credentials". In the browser it shows "Android app only".
