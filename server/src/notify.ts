import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { log } from './log.ts';
import type { Store } from './store.ts';
import type { StreamEvent } from './types.ts';

export interface Notification {
  title: string;
  body: string;
  data: Record<string, string>;
  /** Deep link inside the app, e.g. "#/esc/<id>". */
  route: string;
  urgent: boolean;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Firebase Cloud Messaging over the HTTP v1 API, using a service account
 * file. Implemented with node:crypto + fetch to avoid the firebase-admin SDK.
 */
class FcmSender {
  private account: ServiceAccount;
  private accessToken: { value: string; expires: number } | null = null;

  constructor(file: string) {
    this.account = JSON.parse(readFileSync(file, 'utf8')) as ServiceAccount;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now() + 60_000) return this.accessToken.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key, 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  /** Returns false when the device token is no longer valid. */
  async send(deviceToken: string, n: Notification): Promise<boolean> {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: clip(n.title, 200), body: clip(n.body, 1000) },
          data: { ...n.data, route: n.route },
          android: {
            priority: n.urgent ? 'high' : 'normal',
            notification: { channel_id: n.urgent ? 'escalations' : 'updates', tag: n.data.escalationId ?? n.data.laneId },
          },
        },
      }),
    });
    if (res.ok) return true;
    const text = await res.text();
    // Only token errors mean the device is gone. Other 400s (e.g. "message too big")
    // are about the payload and must not unregister anyone.
    if (res.status === 404 || text.includes('UNREGISTERED')) return false;
    if (res.status === 400 && text.includes('message.token')) return false;
    throw new Error(`FCM send failed: ${res.status} ${text}`);
  }
}

/**
 * Subscribes to store changes and sends push notifications for the configured
 * triggers. `userActive` filters out phones of people who were removed or banned.
 */
export function startNotifier(config: Config, store: Store, userActive: (userId: string) => boolean = () => true) {
  let fcm: FcmSender | null = null;
  if (config.fcmServiceAccountFile) {
    try {
      fcm = new FcmSender(config.fcmServiceAccountFile);
      log.info('fcm push enabled');
    } catch (err) {
      log.error('fcm disabled: cannot read service account', { error: String(err) });
    }
  }
  const enabled = { fcm: fcm !== null, ntfy: config.ntfyUrl !== null };

  async function deliver(n: Notification) {
    if (fcm) {
      let tokens: ReturnType<Store['listPushTokens']> = [];
      try {
        tokens = store.listPushTokens();
      } catch (err) {
        log.warn('cannot read push tokens', { error: String(err) });
      }
      for (const t of tokens) {
        if (t.userId && !userActive(t.userId)) continue;
        try {
          if (!(await fcm.send(t.token, n))) {
            store.removePushToken(t.token);
            log.info('removed stale push token', { owner: t.owner });
          }
        } catch (err) {
          log.warn('fcm send failed', { error: String(err) });
        }
      }
    }
    if (config.ntfyUrl) {
      try {
        // JSON publishing (POST to the server root with the topic in the body) keeps
        // titles UTF-8; header-based publishing can't carry non-Latin-1 characters.
        const url = new URL(config.ntfyUrl);
        const segments = url.pathname.split('/').filter(Boolean);
        const topic = segments.pop() ?? '';
        url.pathname = `/${segments.map((p) => `${p}/`).join('')}`;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (config.ntfyToken) headers.authorization = `Bearer ${config.ntfyToken}`;
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            topic,
            title: clip(n.title, 200),
            message: clip(n.body, 2000),
            priority: n.urgent ? 4 : 3,
            tags: [n.urgent ? 'rotating_light' : 'information_source'],
            ...(config.publicUrl ? { click: `${config.publicUrl.replace(/\/$/, '')}/${n.route}` } : {}),
          }),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      } catch (err) {
        log.warn('ntfy send failed', { error: String(err) });
      }
    }
  }

  function toNotification(e: StreamEvent): Notification | null {
    const created = e.type === 'escalation' && e.escalation.createdAt === e.escalation.updatedAt;
    if (e.type === 'escalation' && created && config.notifyOn.has('escalation')) {
      // Later open-state events (agent positions) don't re-notify.
      const lane = store.getLane(e.escalation.laneId);
      const where = [lane?.group && store.getGroup(lane.group)?.name, lane?.name ?? e.escalation.laneId].filter(Boolean).join(' / ');
      // FYI questions (non-blocking) still notify once, but quietly.
      const urgent = e.escalation.blocking;
      return {
        title: `${urgent ? 'Decision needed' : 'FYI'} ${e.escalation.ref} · ${where}`,
        body: e.escalation.recommendation
          ? `${e.escalation.question}\nRecommended: ${e.escalation.recommendation}`
          : e.escalation.question,
        data: { escalationId: e.escalation.id, laneId: e.escalation.laneId },
        route: `#/esc/${e.escalation.id}`,
        urgent,
      };
    }
    if (e.type === 'lane' && e.statusChanged) {
      const lane = e.lane;
      // Escalations already notify; don't double up on the lane transition.
      if (lane.status === 'blocked_human' && lane.openEscalations === 0 && config.notifyOn.has('blocked')) {
        return {
          title: `Blocked · ${lane.name}`,
          body: lane.activity ?? 'Lane is blocked on a human decision',
          data: { laneId: lane.id },
          route: `#/lane/${encodeURIComponent(lane.id)}`,
          urgent: true,
        };
      }
      if (lane.status === 'completed' && config.notifyOn.has('completed')) {
        return {
          title: `Completed · ${lane.name}`,
          body: lane.activity ?? 'Lane completed',
          data: { laneId: lane.id },
          route: `#/lane/${encodeURIComponent(lane.id)}`,
          urgent: false,
        };
      }
    }
    return null;
  }

  if (enabled.fcm || enabled.ntfy) {
    store.events.on('change', (e) => {
      const n = toNotification(e);
      if (n) void deliver(n);
    });
  }

  return enabled;
}
