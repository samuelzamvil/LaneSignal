import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { startNotifier } from '../src/notify.ts';
import { Store } from '../src/store.ts';
import { AGENT, ALICE, startServer } from './helpers.ts';
import { esc as escalate, lane as publishLane } from './publish.ts';

const settle = () => new Promise((r) => setTimeout(r, 150));

/** Local ntfy stand-in collecting JSON publishes. */
async function ntfySink() {
  const received: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(body) });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function setup(extraEnv: Record<string, string>) {
  const config = loadConfig({
    LANESIGNAL_CONFIG: '/nonexistent.json',
    LANESIGNAL_AGENT_TOKENS: 'bot:agent-token-0123456789',
    ...extraEnv,
  });
  const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
  return { config, store };
}

test('ntfy gets new escalations only, as UTF-8 JSON, not positions or decisions', async () => {
  const sink = await ntfySink();
  const { config, store } = setup({ LANESIGNAL_NTFY_URL: `${sink.url}/lanes-topic`, LANESIGNAL_PUBLIC_URL: 'https://ls.example/' });
  assert.deepEqual(startNotifier(config, store), { fcm: false, ntfy: true });

  publishLane(store, 'default/lane-1', { name: 'Auth → OAuth 🚀', status: 'pending_ci' }, 'bot');
  const esc = escalate(store, { laneId: 'default/lane-1', question: 'Ship it?' }, 'bot');
  await new Promise((r) => setTimeout(r, 5));
  store.addPosition(esc.id, { agent: 'reviewer', stance: 'agree' }, 'bot');
  store.decideEscalation(esc.id, 'yes', null, 'alice');
  await settle();

  assert.equal(sink.received.length, 1);
  const { path: p, body } = sink.received[0];
  assert.equal(p, '/');
  assert.equal(body.topic, 'lanes-topic');
  assert.equal(body.title, `Needs you ${esc.ref} · Ungrouped / Auth → OAuth 🚀`);
  assert.equal(body.priority, 4);
  assert.equal(body.message, 'Ship it?');
  // Tapping opens the Android app; a button opens the web app instead.
  assert.equal(body.click, `lanesignal://esc/${esc.id}`);
  assert.deepEqual(body.actions, [{ action: 'view', label: 'Open in browser', url: `https://ls.example/#/esc/${esc.id}` }]);
  sink.close();
  store.close();
});

test('lane notifications fire once per real status transition', async () => {
  const sink = await ntfySink();
  const { config, store } = setup({ LANESIGNAL_NTFY_URL: `${sink.url}/t`, LANESIGNAL_NOTIFY_ON: 'completed' });
  startNotifier(config, store);

  publishLane(store, 'default/done', { status: 'active', group: 'default/g1' }, 'bot');
  const esc = escalate(store, { laneId: 'default/done', question: 'Q?', blocking: false }, 'bot');
  store.decideEscalation(esc.id, 'ok', null, 'alice');
  publishLane(store, 'default/done', { status: 'completed' }, 'bot');
  store.acknowledgeEscalation(esc.id, null, 'bot');
  publishLane(store, 'default/other', { group: 'default/g2' }, 'bot');
  store.deleteGroup('default/g2');
  publishLane(store, 'default/done', { activity: 'still completed' }, 'bot');
  await settle();

  assert.deepEqual(
    sink.received.map((r) => r.body.title),
    ['Completed · done'],
  );
  sink.close();
  store.close();
});

test('an FCM payload error does not unregister devices; a token error does', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-fcm-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(dir, 'sa.json');
  writeFileSync(
    keyFile,
    JSON.stringify({
      project_id: 'p',
      client_email: 'sa@p.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  );
  const realFetch = globalThis.fetch;
  const sends: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/')) {
      return new Response(JSON.stringify({ access_token: 'x', expires_in: 3600 }));
    }
    const token = JSON.parse(String(init?.body)).message.token as string;
    sends.push(token);
    if (token === 'gone-device-token') {
      return new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 });
    }
    return new Response(
      '{"error":{"code":400,"message":"Message is too big","status":"INVALID_ARGUMENT"}}',
      { status: 400 },
    );
  }) as typeof fetch;

  try {
    const { config, store } = setup({ LANESIGNAL_FCM_SERVICE_ACCOUNT_FILE: keyFile });
    // A removed or banned person's phone is skipped.
    assert.deepEqual(startNotifier(config, store, (userId) => userId !== 'u-removed'), { fcm: true, ntfy: false });
    store.addPushToken('removed-device-token', 'android', 'carol', 'u-removed');
    store.addPushToken('good-device-token', 'android', 'alice');
    store.addPushToken('gone-device-token', 'android', 'bob');
    escalate(store, { laneId: 'default/l', question: 'Q?', recommendation: 'x'.repeat(5000) }, 'bot');
    await settle();
    assert.deepEqual(sends.sort(), ['gone-device-token', 'good-device-token']);
    assert.deepEqual(
      store.listPushTokens().map((t) => t.token),
      ['removed-device-token', 'good-device-token'],
    );
    store.close();
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ntfy taps can open the web app instead, and the app link works without a public URL', async () => {
  const { ntfyLinks } = await import('../src/notify.ts');
  assert.deepEqual(ntfyLinks({ publicUrl: 'https://ls.example', ntfyOpen: 'browser' }, '#/esc/e1'), { click: 'https://ls.example/#/esc/e1' });
  assert.deepEqual(ntfyLinks({ publicUrl: null, ntfyOpen: 'app' }, '#/lane/default/l1'), { click: 'lanesignal://lane/default/l1' });
  assert.deepEqual(ntfyLinks({ publicUrl: null, ntfyOpen: 'browser' }, '#/esc/e1'), {});
});

test('an FYI raised again as blocking notifies like a new question; notices go out quietly', async () => {
  const sink = await ntfySink();
  const { config, store } = setup({ LANESIGNAL_NTFY_URL: `${sink.url}/lanes-topic` });
  startNotifier(config, store);
  publishLane(store, 'default/lane-1', { name: 'Auth', status: 'active' }, 'bot');
  const fyi = escalate(store, { laneId: 'default/lane-1', question: 'Heads up: CI is slow', blocking: false }, 'bot');
  const again = store.createEscalation({ laneId: 'default/lane-1', question: 'Heads up: CI is slow', blocking: true }, 'bot');
  assert.equal(again.id, fyi.id);
  assert.equal(again.upgraded, true);
  assert.equal(again.blocking, true);
  assert.equal(store.getLane('default/lane-1')?.status, 'blocked_human');
  // A plain retry of a blocking question changes nothing.
  assert.equal(store.createEscalation({ laneId: 'default/lane-1', question: 'Heads up: CI is slow', blocking: true }, 'bot').upgraded, undefined);
  store.postNotice('default/lane-1', 'Merged PR #311', 'bot');
  await settle();

  assert.deepEqual(
    sink.received.map((r) => [r.body.title, r.body.priority]),
    [
      [`FYI ${fyi.ref} · Ungrouped / Auth`, 3],
      [`Needs you ${fyi.ref} · Ungrouped / Auth`, 4],
      ['Ungrouped / Auth', 3],
    ],
  );
  assert.equal(sink.received[2].body.message, 'Merged PR #311');
  assert.equal(sink.received[2].body.click, 'lanesignal://lane/default/lane-1');
  sink.close();
  store.close();
});

test("every agent message in a conversation reaches the owner", async () => {
  const sink = await ntfySink();
  const { config, store } = setup({ LANESIGNAL_NTFY_URL: `${sink.url}/lanes-topic` });
  startNotifier(config, store);
  publishLane(store, 'default/lane-1', { name: 'Auth', status: 'active' }, 'bot');
  const e = escalate(store, { laneId: 'default/lane-1', question: 'Ship?' }, 'bot');
  store.decideEscalation(e.id, 'Other', 'Behind a flag', 'alice');
  store.postMessage(e.id, { from: 'agent', author: 'bot', body: 'Flag checkout_v2?' }, 'bot');
  await settle();
  assert.deepEqual(
    sink.received.map((r) => [r.body.title, r.body.message, r.body.priority]),
    [
      [`Needs you ${e.ref} · Ungrouped / Auth`, 'Ship?', 4],
      [`Reply ${e.ref} · Ungrouped / Auth`, 'Flag checkout_v2?', 4],
    ],
  );
  sink.close();
  store.close();
});

test('quiet alerts send questions as regular notifications', async () => {
  const sink = await ntfySink();
  const { config, store } = setup({ LANESIGNAL_NTFY_URL: `${sink.url}/t` });
  startNotifier(config, store);
  publishLane(store, 'default/q', { status: 'active' }, 'bot');

  store.setQuietAlerts(true);
  const quiet = escalate(store, { laneId: 'default/q', question: 'Quietly?' }, 'bot');
  await settle();
  store.setQuietAlerts(false);
  escalate(store, { laneId: 'default/q', question: 'Loudly?' }, 'bot');
  await settle();

  assert.deepEqual(
    sink.received.map((r) => [r.body.title, r.body.priority]),
    [
      [`Needs you ${quiet.ref} · Ungrouped / q`, 3],
      // The ticket's next letter.
      [`Needs you ${quiet.ref.replace(/A$/, 'B')} · Ungrouped / q`, 4],
    ],
  );
  sink.close();
  store.close();
});

test('instance admins switch quiet alerts; agents cannot', async () => {
  const srv = await startServer();
  assert.equal((await srv.call('GET', '/api/config', ALICE)).body.quietAlerts, false);
  assert.equal((await srv.call('PUT', '/api/settings/push', AGENT, { quietAlerts: true })).status, 403);
  assert.equal((await srv.call('PUT', '/api/settings/push', ALICE, { quietAlerts: true })).status, 204);
  assert.equal((await srv.call('GET', '/api/config', ALICE)).body.quietAlerts, true);
  srv.close();
});
