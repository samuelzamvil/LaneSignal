import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { localId, type Store } from './store.ts';
import type { Notice, StreamEvent } from './types.ts';

export interface Notification {
  title: string;
  body: string;
  data: Record<string, string>;
  /** Deep link inside the app, e.g. "#/esc/<id>". */
  route: string;
  urgent: boolean;
  /** The project it's about: only people subscribed to it are notified. */
  project: string;
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
  /** `loud`: the high-importance channel (heads-up, vibration); otherwise the regular one. */
  async send(deviceToken: string, n: Notification, loud: boolean): Promise<boolean> {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: clip(n.title, 200), body: clip(n.body, 1000) },
          data: { ...n.data, route: n.route },
          android: {
            // Delivery stays high priority for urgent ones even when they show quietly, so they aren't delayed.
            priority: n.urgent ? 'high' : 'normal',
            notification: { channel_id: loud ? 'escalations' : 'updates', tag: n.data.escalationId ?? n.data.laneId },
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
 * triggers. `wantsPush` says whether a person's phones get a project's
 * notifications: they're an active member with notifications on (it filters out
 * removed and banned people too). Phones registered with a config token get all.
 */
/**
 * Where tapping an ntfy notification goes. "app": the LaneSignal Android app through its own
 * lanesignal:// link (works without a public URL), plus an "Open in browser" button when there is one.
 * "browser": the web app at the public URL.
 */
export function ntfyLinks(config: Pick<Config, 'publicUrl' | 'ntfyOpen'>, route: string) {
  const web = config.publicUrl ? `${config.publicUrl.replace(/\/$/, '')}/${route}` : null;
  if (config.ntfyOpen === 'browser') return web ? { click: web } : {};
  return {
    click: `lanesignal://${route.replace(/^#\//, '')}`,
    ...(web ? { actions: [{ action: 'view', label: 'Open in browser', url: web }] } : {}),
  };
}

/** A milestone from an overseer: quiet, and opens the lane. */
export function noticeNotification(store: Store, n: Notice): Notification {
  const lane = store.getLane(n.laneId);
  const where = [lane?.group && store.getGroup(lane.group)?.name, lane?.name ?? localId(n.laneId)].filter(Boolean).join(' / ');
  return {
    title: where,
    body: n.message,
    data: { laneId: localId(n.laneId), project: n.project },
    route: `#/lane/${encodeURIComponent(n.project)}/${encodeURIComponent(localId(n.laneId))}`,
    urgent: false,
    project: n.project,
  };
}

export function startNotifier(
  config: Config,
  store: Store,
  wantsPush: (userId: string, project: string) => boolean = () => true,
) {
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
    // Quiet alerts: urgent notifications show like regular ones (no heads-up or high-priority buzz).
    const loud = n.urgent && !store.quietAlerts();
    if (fcm) {
      let tokens: ReturnType<Store['listPushTokens']> = [];
      try {
        tokens = store.listPushTokens();
      } catch (err) {
        log.warn('cannot read push tokens', { error: String(err) });
      }
      for (const t of tokens) {
        if (t.userId && !wantsPush(t.userId, n.project)) continue;
        try {
          if (!(await fcm.send(t.token, n, loud))) {
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
            priority: loud ? 4 : 3,
            tags: [n.urgent ? 'rotating_light' : 'information_source'],
            ...ntfyLinks(config, n.route),
          }),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      } catch (err) {
        log.warn('ntfy send failed', { error: String(err) });
      }
    }
  }

  function toNotification(e: StreamEvent): Notification | null {
    // The agent wrote in a conversation: every message reaches the owner.
    if (e.type === 'escalation' && e.replied && e.escalation.lastMessage && config.notifyOn.has('escalation')) {
      const esc = e.escalation;
      const lane = store.getLane(esc.laneId);
      const where = [lane?.group && store.getGroup(lane.group)?.name, lane?.name ?? localId(esc.laneId)].filter(Boolean).join(' / ');
      const code = store.listProjects().length > 1 ? `${esc.projectKey}·${esc.ref}` : esc.ref;
      const reply = e.replied === 'reply';
      const urgent = esc.blocking && reply;
      return {
        title: `${reply ? 'Reply' : 'Update'} ${code} · ${where}`,
        body: esc.lastMessage!.body,
        data: { escalationId: esc.id, laneId: localId(esc.laneId), project: esc.project },
        route: `#/esc/${esc.id}`,
        urgent,
        project: esc.project,
      };
    }
    // New questions, and FYIs that now need the owner.
    const created = e.type === 'escalation' && (e.raised || e.escalation.createdAt === e.escalation.updatedAt);
    if (e.type === 'escalation' && created && config.notifyOn.has('escalation')) {
      // Later open-state events (agent positions) don't re-notify.
      const lane = store.getLane(e.escalation.laneId);
      const where = [lane?.group && store.getGroup(lane.group)?.name, lane?.name ?? localId(e.escalation.laneId)]
        .filter(Boolean)
        .join(' / ');
      // FYI questions (non-blocking) still notify once, but quietly.
      const urgent = e.escalation.blocking;
      // With several projects, the code carries its project's key: "LS·A12".
      const code = store.listProjects().length > 1 ? `${e.escalation.projectKey}·${e.escalation.ref}` : e.escalation.ref;
      return {
        title: `${urgent ? 'Needs you' : 'FYI'} ${code} · ${where}`,
        body: e.escalation.recommendation
          ? `${e.escalation.question}\nRecommended: ${e.escalation.recommendation}`
          : e.escalation.question,
        data: { escalationId: e.escalation.id, laneId: localId(e.escalation.laneId), project: e.escalation.project },
        route: `#/esc/${e.escalation.id}`,
        urgent,
        project: e.escalation.project,
      };
    }
    if (e.type === 'lane' && e.statusChanged) {
      const lane = e.lane;
      // Escalations already notify; don't double up on the lane transition.
      if (lane.status === 'blocked_human' && lane.openEscalations === 0 && config.notifyOn.has('blocked')) {
        return {
          title: `Blocked · ${lane.name}`,
          body: lane.activity ?? 'Lane is blocked on a human decision',
          data: { laneId: localId(lane.id), project: lane.project },
          route: `#/lane/${encodeURIComponent(lane.project)}/${encodeURIComponent(localId(lane.id))}`,
          urgent: true,
          project: lane.project,
        };
      }
      if (lane.status === 'completed' && config.notifyOn.has('completed')) {
        return {
          title: `Completed · ${lane.name}`,
          body: lane.activity ?? 'Lane completed',
          data: { laneId: localId(lane.id), project: lane.project },
          route: `#/lane/${encodeURIComponent(lane.project)}/${encodeURIComponent(localId(lane.id))}`,
          urgent: false,
          project: lane.project,
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
    if (config.notifyOn.has('notice')) store.events.on('notice', (n) => void deliver(noticeNotification(store, n)));
  }

  return enabled;
}
