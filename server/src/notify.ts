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
          notification: { title: n.title, body: n.body },
          data: { ...n.data, route: n.route },
          android: {
            priority: n.urgent ? 'high' : 'normal',
            notification: { channel_id: n.urgent ? 'escalations' : 'updates', tag: n.data.escalationId ?? n.data.laneId },
          },
        },
      }),
    });
    if (res.status === 404 || res.status === 400) {
      const text = await res.text();
      if (text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')) return false;
      throw new Error(`FCM send failed: ${res.status} ${text}`);
    }
    if (!res.ok) throw new Error(`FCM send failed: ${res.status} ${await res.text()}`);
    return true;
  }
}

/** Subscribes to store changes and sends push notifications for the configured triggers. */
export function startNotifier(config: Config, store: Store) {
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
      for (const t of store.listPushTokens()) {
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
        const headers: Record<string, string> = {
          Title: n.title,
          Priority: n.urgent ? 'high' : 'default',
          Tags: n.urgent ? 'rotating_light' : 'information_source',
        };
        if (config.publicUrl) headers.Click = `${config.publicUrl.replace(/\/$/, '')}/${n.route}`;
        if (config.ntfyToken) headers.Authorization = `Bearer ${config.ntfyToken}`;
        const res = await fetch(config.ntfyUrl, { method: 'POST', headers, body: n.body });
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
      return {
        title: `Decision needed · ${lane?.name ?? e.escalation.laneId}`,
        body: e.escalation.recommendation
          ? `${e.escalation.question}\nRecommended: ${e.escalation.recommendation}`
          : e.escalation.question,
        data: { escalationId: e.escalation.id, laneId: e.escalation.laneId },
        route: `#/esc/${e.escalation.id}`,
        urgent: true,
      };
    }
    if (e.type === 'lane' && e.lane.statusSince === e.lane.updatedAt) {
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
