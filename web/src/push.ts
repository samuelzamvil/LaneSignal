import { PushNotifications } from '@capacitor/push-notifications';
import { isNative, type Client, type PublicConfig } from './api.ts';

const TOKEN_KEY = 'lanesignal.pushToken';

/**
 * FCM is compiled into the APK only when CI had a google-services.json
 * (VITE_FCM_ENABLED=true); registering without it crashes the native layer.
 */
export const pushSupported = isNative && import.meta.env.VITE_FCM_ENABLED === 'true';

export async function setupPush(client: Client, config: PublicConfig, navigate: (route: string) => void) {
  if (!pushSupported || !config.push.fcm) return () => {};

  await PushNotifications.createChannel({
    id: 'escalations',
    name: 'Human decisions',
    description: 'Alerts from agents that need you',
    importance: 5,
    visibility: 1,
    vibration: true,
  });
  await PushNotifications.createChannel({ id: 'updates', name: 'Lane updates', importance: 3 });

  const handles = await Promise.all([
    PushNotifications.addListener('registration', (t) => {
      localStorage.setItem(TOKEN_KEY, t.value);
      client.registerPush(t.value).catch((err: unknown) => console.warn('push token registration failed', err));
    }),
    PushNotifications.addListener('registrationError', (err) => console.warn('push registration failed', err)),
    PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      const route = (a.notification.data as { route?: string } | undefined)?.route;
      if (route) navigate(route);
    }),
  ]);

  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive === 'granted') await PushNotifications.register();

  return () => handles.forEach((h) => void h.remove());
}

export async function teardownPush(client: Client) {
  const token = localStorage.getItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  if (!pushSupported) return;
  if (token) await client.unregisterPush(token).catch(() => {});
  await PushNotifications.unregister().catch(() => {});
}
