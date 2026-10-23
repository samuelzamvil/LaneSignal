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

  store.upsertLane('lane-1', { name: 'Auth → OAuth 🚀', status: 'pending_ci' }, 'bot');
  const esc = store.createEscalation({ laneId: 'lane-1', question: 'Ship it?' }, 'bot');
  await new Promise((r) => setTimeout(r, 5));
  store.addPosition(esc.id, { agent: 'reviewer', stance: 'agree' }, 'bot');
  store.decideEscalation(esc.id, 'yes', null, 'alice');
  await settle();

  assert.equal(sink.received.length, 1);
  const { path: p, body } = sink.received[0];
  assert.equal(p, '/');
  assert.equal(body.topic, 'lanes-topic');
  assert.equal(body.title, `Decision needed ${esc.ref} · Auth → OAuth 🚀`);
  assert.equal(body.priority, 4);
  assert.equal(body.message, 'Ship it?');
  assert.equal(body.click, `https://ls.example/#/esc/${esc.id}`);
  sink.close();
  store.close();
});

test('lane notifications fire once per real status transition', async () => {
  const sink = await ntfySink();
  const { config, store } = setup({ LANESIGNAL_NTFY_URL: `${sink.url}/t`, LANESIGNAL_NOTIFY_ON: 'completed' });
  startNotifier(config, store);

  store.upsertLane('done', { status: 'active', group: 'g1' }, 'bot');
  const esc = store.createEscalation({ laneId: 'done', question: 'Q?', blocking: false }, 'bot');
  store.decideEscalation(esc.id, 'ok', null, 'alice');
  store.upsertLane('done', { status: 'completed' }, 'bot');
  store.acknowledgeEscalation(esc.id, null, 'bot');
  store.upsertLane('other', { group: 'g2' }, 'bot');
  store.deleteGroup('g2');
  store.upsertLane('done', { activity: 'still completed' }, 'bot');
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
    store.createEscalation({ laneId: 'l', question: 'Q?', recommendation: 'x'.repeat(5000) }, 'bot');
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
