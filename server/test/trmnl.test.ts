// The TRMNL notifications channel: a project's latest notification and pending escalations, pushed to a webhook.
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { Store } from '../src/store.ts';
import { buildPayload, checkWebhookUrl, maskWebhookUrl, TrmnlPusher } from '../src/trmnl.ts';
import { AGENT, ALICE, startServer } from './helpers.ts';
import { esc as escalate, lane as publishLane } from './publish.ts';

const URL_ = 'https://trmnl.com/api/custom_plugins/0b8a3c6e-1111-2222-3333-444455556666';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newStore() {
  const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
  publishLane(store, 'default/auth', { name: 'Auth rework', status: 'active' }, 'bot');
  publishLane(store, 'default/e2e', { name: 'E2E', status: 'active' }, 'bot');
  return store;
}

/** A stand-in for TRMNL: records pushes and answers with the given statuses in turn (200 once they run out). */
function fakeTrmnl(statuses: number[] = []) {
  const pushes: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    pushes.push(JSON.parse(String(init.body)).merge_variables);
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? '{}' : 'nope', { status });
  }) as typeof globalThis.fetch;
  return { pushes, fetch };
}

describe('webhook URLs', () => {
  const hosts = ['trmnl.com', 'usetrmnl.com', 'terminus.lan'];
  test("TRMNL's own servers over https, or a self-hosted server named in the config", () => {
    assert.equal(checkWebhookUrl(` ${URL_} `, hosts), URL_);
    assert.equal(checkWebhookUrl('http://terminus.lan/api/custom_plugins/x', hosts), 'http://terminus.lan/api/custom_plugins/x');
    assert.throws(() => checkWebhookUrl('http://trmnl.com/api/custom_plugins/x', hosts), /https/);
    assert.throws(() => checkWebhookUrl('https://evil.example/api/custom_plugins/x', hosts), /LANESIGNAL_TRMNL_HOSTS/);
    assert.throws(() => checkWebhookUrl('https://127.0.0.1/x', hosts), /LANESIGNAL_TRMNL_HOSTS/);
    assert.throws(() => checkWebhookUrl('https://a:b@trmnl.com/x', hosts), /user name/);
    assert.throws(() => checkWebhookUrl('not a url', hosts), /valid URL/);
  });

  test('settings show the URL with the plugin id hidden', () => {
    assert.equal(maskWebhookUrl(URL_), 'https://trmnl.com/api/custom_plugins/…6666');
  });
});

describe('screen data', () => {
  test('the card is the latest question; the others are listed in inbox order', async () => {
    const store = newStore();
    const fyi = escalate(store, { laneId: 'default/e2e', question: 'FYI: bumped Node', blocking: false }, 'bot');
    await sleep(5);
    const first = escalate(store, { laneId: 'default/e2e', question: 'Quarantine the flaky test?' }, 'bot');
    await sleep(5);
    const latest = escalate(
      store,
      {
        laneId: 'default/auth',
        question: 'Drop the legacy table?',
        context: 'Live for 9 days.',
        recommendation: 'Drop it in 0042',
        acceptMeans: 'Write migration 0042',
        rejectMeans: 'Keep it',
      },
      'bot',
    );
    const setup = store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    store.setTrmnlCard('default', { kind: 'escalation', id: latest.id, at: latest.createdAt });

    const p = buildPayload(store, store.trmnlSetup('default')!, new Date());
    assert.equal(p.project, 'Main');
    assert.equal(p.card?.code, latest.ref);
    assert.equal(p.card?.label, 'Needs you');
    assert.equal(p.card?.lane, 'Auth rework');
    assert.equal(p.card?.group, null);
    assert.equal(p.card?.title, 'Drop the legacy table?');
    assert.equal(p.card?.recommendation, 'Drop it in 0042');
    assert.equal(p.card?.accept, 'Write migration 0042');
    assert.equal(p.card?.reject, 'Keep it');
    // Blocking questions waiting on you first, FYIs last.
    assert.deepEqual(
      p.pending.map((r) => [r.code, r.status]),
      [
        [first.ref, 'Needs you'],
        [fyi.ref, 'FYI'],
      ],
    );
    assert.equal(p.more, 0);
    assert.ok(setup.enabled);

    // Once answered, the card goes to the newest question still open.
    store.decideEscalation(latest.id, 'Accept', null, 'alice');
    const after = buildPayload(store, store.trmnlSetup('default')!, new Date());
    assert.equal(after.card?.code, first.ref);
    assert.deepEqual(
      after.pending.map((r) => r.code),
      [fyi.ref],
    );
  });

  test('lane updates take the card only when the setup asks for them', () => {
    const store = newStore();
    const q = escalate(store, { laneId: 'default/e2e', question: 'Ship it?' }, 'bot');
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const notice = { kind: 'notice' as const, laneId: 'default/auth', title: 'Auth rework', body: 'Tests green', at: new Date().toISOString() };
    store.setTrmnlCard('default', notice);
    assert.equal(buildPayload(store, store.trmnlSetup('default')!, new Date()).card?.code, q.ref);

    store.saveTrmnlSetup('default', { enabled: true, includeNotifications: true });
    const p = buildPayload(store, store.trmnlSetup('default')!, new Date());
    assert.equal(p.card?.type, 'notice');
    assert.equal(p.card?.title, 'Tests green');
    assert.equal(p.card?.lane, 'Auth rework');
    assert.deepEqual(
      p.pending.map((r) => r.code),
      [q.ref],
    );
  });

  test('stays under TRMNL’s size limit, counting what it leaves out', () => {
    const store = newStore();
    for (let i = 0; i < 40; i++) {
      escalate(store, { laneId: 'default/e2e', question: `Question ${i} ${'é'.repeat(300)}`, context: 'x'.repeat(2000) }, 'bot');
    }
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const p = buildPayload(store, store.trmnlSetup('default')!, new Date());
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 4500);
    assert.equal(p.pending.length + p.more, 39);
    assert.ok(p.card!.title.length <= 200);
  });
});

describe('pushing', () => {
  const opts = (fetch: typeof globalThis.fetch) => ({ fetch, minGapMs: 150, debounceMs: 10, heartbeatMs: 3_600_000 });

  test('pushes on change, at most once per gap, and skips data that did not change', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl();
    const pusher = new TrmnlPusher(store, opts(trmnl.fetch)).start();
    try {
      await sleep(60);
      assert.equal(trmnl.pushes.length, 1, 'brought up to date on start');
      assert.equal(trmnl.pushes[0].card, null);

      const q = escalate(store, { laneId: 'default/e2e', question: 'Ship it?' }, 'bot');
      escalate(store, { laneId: 'default/auth', question: 'Rename it?' }, 'bot');
      await sleep(60);
      assert.equal(trmnl.pushes.length, 1, 'waits out the gap');
      await sleep(200);
      assert.equal(trmnl.pushes.length, 2, 'the burst became one push');
      assert.equal(trmnl.pushes[1].card.title, 'Rename it?');
      assert.deepEqual(
        trmnl.pushes[1].pending.map((r: any) => r.code),
        [q.ref],
      );
      assert.ok(store.trmnlSetup('default')!.lastPushAt);

      // Activity text changes nothing on screen: no push.
      store.upsertLane('default/e2e', { activity: 'still going' }, 'bot');
      await sleep(250);
      assert.equal(trmnl.pushes.length, 2);
    } finally {
      pusher.stop();
    }
  });

  test('lane milestones take the card when asked; paused setups push nothing', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: true });
    const trmnl = fakeTrmnl();
    const pusher = new TrmnlPusher(store, opts(trmnl.fetch)).start();
    try {
      await sleep(30);
      store.postNotice('default/auth', 'All tests green', 'bot');
      await sleep(250);
      assert.equal(trmnl.pushes.at(-1).card.type, 'notice');
      assert.equal(trmnl.pushes.at(-1).card.title, 'All tests green');

      store.saveTrmnlSetup('default', { enabled: false, includeNotifications: true });
      const count = trmnl.pushes.length;
      escalate(store, { laneId: 'default/e2e', question: 'Ship it?' }, 'bot');
      await sleep(250);
      assert.equal(trmnl.pushes.length, count);
    } finally {
      pusher.stop();
    }
  });

  test('retries after a rate limit; records other refusals without retrying', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl([429]);
    const pusher = new TrmnlPusher(store, opts(trmnl.fetch)).start();
    try {
      await sleep(40);
      assert.match(store.trmnlSetup('default')!.lastError!, /too many/);
      await sleep(200);
      assert.equal(trmnl.pushes.length, 2);
      assert.equal(store.trmnlSetup('default')!.lastError, null);
    } finally {
      pusher.stop();
    }

    const store2 = newStore();
    store2.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const refusing = fakeTrmnl([422, 422]);
    const pusher2 = new TrmnlPusher(store2, opts(refusing.fetch)).start();
    try {
      await sleep(300);
      assert.equal(refusing.pushes.length, 1);
      assert.match(store2.trmnlSetup('default')!.lastError!, /422/);
      // Send now tries again regardless.
      const r = await pusher2.sendNow('default');
      assert.equal(r.ok, false);
      assert.equal(r.status, 422);
      assert.equal(refusing.pushes.length, 2);
    } finally {
      pusher2.stop();
    }
  });
});

describe('settings API', () => {
  test('project admins set it up; the URL is checked and masked; send, preview and plugin download work', async () => {
    const trmnl = fakeTrmnl();
    const srv = await startServer({}, { trmnl: { fetch: trmnl.fetch, minGapMs: 150, debounceMs: 10 } });
    try {
      // A member who isn't the project's admin.
      const created = await srv.call('POST', '/api/admin/people', ALICE, { email: 'pat@example.com', name: 'Pat', password: 'correct horse battery' });
      assert.equal(created.status, 201);
      const signIn = await fetch(`${srv.base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: srv.base },
        body: JSON.stringify({ email: 'pat@example.com', password: 'correct horse battery' }),
      });
      const pat = signIn.headers.get('set-auth-token')!;

      assert.deepEqual((await srv.call('GET', '/api/projects/default/trmnl', ALICE)).body, { configured: false });
      assert.equal((await srv.call('GET', '/api/projects/default/trmnl', pat)).status, 403);
      const body = { webhookUrl: URL_, enabled: true, includeNotifications: false };
      assert.equal((await srv.call('PUT', '/api/projects/default/trmnl', pat, body)).status, 403);
      assert.equal((await srv.call('PUT', '/api/projects/default/trmnl', ALICE, { ...body, webhookUrl: 'https://example.com/x' })).status, 400);
      assert.equal((await srv.call('PUT', '/api/projects/default/trmnl', ALICE, { enabled: true, includeNotifications: false })).status, 400);
      assert.equal((await srv.call('POST', '/api/projects/default/trmnl/send', ALICE, {})).status, 404);

      const saved = await srv.call('PUT', '/api/projects/default/trmnl', ALICE, body);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.equal(saved.body.configured, true);
      assert.equal(saved.body.webhookUrl, 'https://trmnl.com/api/custom_plugins/…6666');
      assert.ok(!JSON.stringify(saved.body).includes('0b8a3c6e'));

      // Keeping the saved URL while changing the options.
      const kept = await srv.call('PUT', '/api/projects/default/trmnl', ALICE, { enabled: true, includeNotifications: true });
      assert.equal(kept.body.includeNotifications, true);
      assert.equal(srv.store.trmnlSetup('default')!.webhookUrl, URL_);

      await srv.publish('auth');
      const q = await srv.call('POST', '/api/escalations', AGENT, { laneId: 'auth', question: 'Ship it?' });
      assert.equal(q.status, 201, JSON.stringify(q.body));

      const preview = await srv.call('GET', '/api/projects/default/trmnl/preview', ALICE);
      assert.equal(preview.body.merge_variables.card.title, 'Ship it?');

      const sent = await srv.call('POST', '/api/projects/default/trmnl/send', ALICE, {});
      assert.equal(sent.status, 200);
      assert.equal(sent.body.ok, true);
      assert.ok(sent.body.setup.lastPushAt);
      assert.equal(trmnl.pushes.at(-1).card.title, 'Ship it?');

      const zip = await fetch(`${srv.base}/api/projects/default/trmnl/plugin.zip`, { headers: { authorization: `Bearer ${ALICE}` } });
      assert.equal(zip.status, 200);
      assert.match(zip.headers.get('content-disposition')!, /lanesignal-trmnl-default\.zip/);
      const files = unzip(Buffer.from(await zip.arrayBuffer()));
      assert.deepEqual(Object.keys(files).sort(), ['full.liquid', 'settings.yml', 'shared.liquid']);
      assert.match(files['settings.yml'], /^name: 'LaneSignal · Main'$/m);
      assert.match(files['settings.yml'], /^strategy: webhook$/m);

      assert.equal((await srv.call('DELETE', '/api/projects/default/trmnl', pat)).status, 403);
      assert.equal((await srv.call('DELETE', '/api/projects/default/trmnl', ALICE)).status, 204);
      assert.deepEqual((await srv.call('GET', '/api/projects/default/trmnl', ALICE)).body, { configured: false });
    } finally {
      srv.close();
    }
  });
});

/** Reads the local file entries of a zip (enough for the plugin download). */
function unzip(buf: Buffer): Record<string, string> {
  const files: Record<string, string> = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 30, at + 30 + nameLength);
    const start = at + 30 + nameLength + extra;
    files[name] = inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    at = start + size;
  }
  return files;
}
