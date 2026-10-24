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
function fakeTrmnl(statuses: number[] = [], delayMs = 0) {
  const pushes: any[] = [];
  const urls: string[] = [];
  const redirects: (string | undefined)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    pushes.push(JSON.parse(String(init.body)).merge_variables);
    urls.push(String(url));
    redirects.push(init.redirect);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await sleep(delayMs);
    inFlight--;
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? '{}' : 'nope', { status });
  }) as typeof globalThis.fetch;
  return { pushes, urls, redirects, fetch, maxInFlight: () => maxInFlight };
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
    // TRMNL's own servers: only a plugin's webhook URL.
    assert.equal(checkWebhookUrl(`${URL_}/`, hosts), URL_);
    assert.throws(() => checkWebhookUrl('https://trmnl.com/plugin_settings/123/edit', hosts), /plugin's webhook URL/);
    assert.throws(() => checkWebhookUrl(`https://trmnl.com:8443/api/custom_plugins/x`, hosts), /plugin's webhook URL/);
    assert.throws(() => checkWebhookUrl(`${URL_}?next=https://evil.example`, hosts), /plugin's webhook URL/);
  });

  test('settings show the URL with the plugin id hidden', () => {
    assert.equal(maskWebhookUrl(URL_), 'https://trmnl.com/api/custom_plugins/…6666');
    assert.equal(maskWebhookUrl(`${URL_}/`), 'https://trmnl.com/api/custom_plugins/…6666');
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

    // Switching lane updates on drops whatever card was kept from before.
    store.saveTrmnlSetup('default', { enabled: true, includeNotifications: true });
    assert.equal(store.trmnlSetup('default')!.card, null);
    store.setTrmnlCard('default', notice);
    const p = buildPayload(store, store.trmnlSetup('default')!, new Date());
    assert.equal(p.card?.type, 'notice');
    assert.equal(p.card?.title, 'Tests green');
    assert.equal(p.card?.lane, 'Auth rework');
    assert.deepEqual(
      p.pending.map((r) => r.code),
      [q.ref],
    );

    // A day later the update gives the card back to the open question.
    const later = new Date(Date.now() + 25 * 3_600_000);
    assert.equal(buildPayload(store, store.trmnlSetup('default')!, later).card?.code, q.ref);
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

  test('control characters and broken surrogates cannot push it over the limit', () => {
    const store = newStore();
    const junk = '\u0001'.repeat(400) + '\ud800';
    escalate(
      store,
      { laneId: 'default/e2e', question: junk, context: junk, recommendation: junk, acceptMeans: junk, rejectMeans: junk },
      'bot',
    );
    store.updateProject('default', { name: '\u0002'.repeat(100) });
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const json = JSON.stringify(buildPayload(store, store.trmnlSetup('default')!, new Date()));
    assert.ok(Buffer.byteLength(json) <= 4500);
    assert.ok(!/\\u00|\\ud8/.test(json), 'no escaped control characters or lone surrogates');
    // An emoji is never cut in half.
    escalate(store, { laneId: 'default/auth', question: '🚀'.repeat(300) }, 'bot');
    const emoji = buildPayload(store, store.trmnlSetup('default')!, new Date());
    assert.ok(!/\\ud8/.test(JSON.stringify(emoji)));
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

  test('a burst of escalations: the first goes out at once, the latest after the gap, nothing queued', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl();
    const pusher = new TrmnlPusher(store, { fetch: trmnl.fetch, minGapMs: 300, debounceMs: 10, heartbeatMs: 3_600_000 }).start();
    try {
      await sleep(350); // the start-up push, and its gap, are behind us
      assert.equal(trmnl.pushes.length, 1);
      const first = escalate(store, { laneId: 'default/e2e', question: 'Q1?' }, 'bot');
      await sleep(40);
      assert.equal(trmnl.pushes.length, 2, 'the first escalation goes out right away');
      assert.equal(trmnl.pushes[1].card.title, 'Q1?');
      const refs = [first.ref];
      for (let i = 2; i <= 6; i++) {
        refs.push(escalate(store, { laneId: 'default/auth', question: `Q${i}?` }, 'bot').ref);
        await sleep(20);
      }
      await sleep(100);
      assert.equal(trmnl.pushes.length, 2, 'the follow-ups wait out the gap');
      await sleep(250);
      assert.equal(trmnl.pushes.length, 3, 'one push for all five follow-ups');
      assert.equal(trmnl.pushes[2].card.title, 'Q6?');
      assert.deepEqual(trmnl.pushes[2].pending.map((x: any) => x.code).sort(), refs.slice(0, 5).sort());
      await sleep(350);
      assert.equal(trmnl.pushes.length, 3, 'no queued pushes after it');
    } finally {
      pusher.stop();
    }
  });

  test('TRMNL+ spaces pushes by its shorter gap, also right after turning it on', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl();
    const pusher = new TrmnlPusher(store, { fetch: trmnl.fetch, minGapMs: 2_000, plusGapMs: 150, debounceMs: 10, heartbeatMs: 3_600_000 }).start();
    try {
      await sleep(40);
      assert.equal(trmnl.pushes.length, 1);
      escalate(store, { laneId: 'default/e2e', question: 'Q1?' }, 'bot'); // waiting out the free tier's gap
      await sleep(100);
      assert.equal(trmnl.pushes.length, 1);
      // Leaving `plus` out keeps it; turning it on reschedules the waiting push.
      store.saveTrmnlSetup('default', { enabled: true, includeNotifications: false, plus: true });
      assert.equal(store.saveTrmnlSetup('default', { enabled: true, includeNotifications: false }).plus, true);
      pusher.reset('default', false);
      await sleep(100);
      assert.equal(trmnl.pushes.length, 2, 'sent once the TRMNL+ gap passed');
      escalate(store, { laneId: 'default/auth', question: 'Q2?' }, 'bot');
      await sleep(60);
      assert.equal(trmnl.pushes.length, 2);
      await sleep(150);
      assert.equal(trmnl.pushes.length, 3);
      assert.equal(trmnl.pushes[2].card.title, 'Q2?');
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

  test('a refused push is not repeated by the hourly heartbeat', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const refusing = fakeTrmnl([404, 404, 404, 404]);
    const pusher = new TrmnlPusher(store, { fetch: refusing.fetch, minGapMs: 20, debounceMs: 5, heartbeatMs: 50 }).start();
    try {
      await sleep(400);
      assert.equal(refusing.pushes.length, 1);
      // New data is tried again, once.
      escalate(store, { laneId: 'default/e2e', question: 'Ship it?' }, 'bot');
      await sleep(400);
      assert.equal(refusing.pushes.length, 2);
    } finally {
      pusher.stop();
    }
  });

  test('without changes, it pushes once per heartbeat to show it is alive', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl();
    const pusher = new TrmnlPusher(store, { fetch: trmnl.fetch, minGapMs: 20, debounceMs: 5, heartbeatMs: 120 }).start();
    try {
      await sleep(420);
      assert.ok(trmnl.pushes.length >= 2 && trmnl.pushes.length <= 4, `pushes: ${trmnl.pushes.length}`);
      assert.ok(trmnl.redirects.every((r) => r === 'error'), 'never follows redirects');
    } finally {
      pusher.stop();
    }
  });

  test('a new URL while a push is out: the new plugin still gets the data', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl([], 80);
    const pusher = new TrmnlPusher(store, opts(trmnl.fetch)).start();
    try {
      await sleep(30); // the first push is out
      const other = 'https://trmnl.com/api/custom_plugins/new-plugin-0000';
      store.saveTrmnlSetup('default', { webhookUrl: other, enabled: true, includeNotifications: false });
      pusher.reset('default', true);
      await sleep(250);
      assert.deepEqual(trmnl.urls, [URL_, other]);
      assert.ok(store.trmnlSetup('default')!.lastPushAt);
    } finally {
      pusher.stop();
    }
  });

  test('Send now waits for a push already out instead of overlapping it', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl([], 60);
    const pusher = new TrmnlPusher(store, opts(trmnl.fetch)).start();
    try {
      await sleep(25);
      const r = await pusher.sendNow('default');
      assert.equal(r.ok, true);
      assert.equal(trmnl.pushes.length, 2);
      assert.equal(trmnl.maxInFlight(), 1);
      await sleep(250);
      assert.equal(trmnl.pushes.length, 2, 'nothing extra afterwards');
    } finally {
      pusher.stop();
    }
  });

  test('two Send now at once still never overlap; a paused screen refuses Send now', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl([], 60);
    const pusher = new TrmnlPusher(store, opts(trmnl.fetch)).start();
    try {
      await sleep(25);
      const [a, b] = await Promise.all([pusher.sendNow('default'), pusher.sendNow('default')]);
      assert.equal(a.ok && b.ok, true);
      assert.equal(trmnl.maxInFlight(), 1);
      store.saveTrmnlSetup('default', { enabled: false, includeNotifications: false });
      await assert.rejects(pusher.sendNow('default'), /paused/);
    } finally {
      pusher.stop();
    }
  });

  test("a new URL doesn't wait out the old plugin's gap", async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    const trmnl = fakeTrmnl();
    const pusher = new TrmnlPusher(store, { fetch: trmnl.fetch, minGapMs: 2_000, debounceMs: 10, heartbeatMs: 3_600_000 }).start();
    try {
      await sleep(40);
      escalate(store, { laneId: 'default/e2e', question: 'Ship it?' }, 'bot'); // now waiting out the gap
      await sleep(20);
      const other = 'https://trmnl.com/api/custom_plugins/new-plugin-0000';
      store.saveTrmnlSetup('default', { webhookUrl: other, enabled: true, includeNotifications: false });
      pusher.reset('default', true);
      await sleep(100);
      assert.deepEqual(trmnl.urls, [URL_, other]);
    } finally {
      pusher.stop();
    }
  });

  test("a notice's files show on the card", async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: true });
    const trmnl = fakeTrmnl();
    const pusher = new TrmnlPusher(store, opts(trmnl.fetch)).start();
    try {
      await sleep(30);
      const shot = store.addAttachment({ name: 'shot.png', type: 'image/png', data: new Uint8Array([1]) }, 'bot', 'bot');
      store.postNotice('default/auth', 'Merged, screenshot attached', 'bot', [shot.id]);
      await sleep(250);
      assert.equal(trmnl.pushes.at(-1).card.files, 1);
    } finally {
      pusher.stop();
    }
  });

  test('after a restart, pushes stay spaced from the ones before it', async () => {
    const store = newStore();
    store.saveTrmnlSetup('default', { webhookUrl: URL_, enabled: true, includeNotifications: false });
    store.recordTrmnlPush('default', new Date(), null);
    const trmnl = fakeTrmnl();
    const pusher = new TrmnlPusher(store, { fetch: trmnl.fetch, minGapMs: 300, debounceMs: 5, heartbeatMs: 3_600_000 }).start();
    try {
      await sleep(100);
      assert.equal(trmnl.pushes.length, 0);
      await sleep(300);
      assert.equal(trmnl.pushes.length, 1);
    } finally {
      pusher.stop();
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
      assert.equal(kept.body.plus, false);
      const plus = await srv.call('PUT', '/api/projects/default/trmnl', ALICE, { enabled: true, includeNotifications: true, plus: true });
      assert.equal(plus.body.plus, true);
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
