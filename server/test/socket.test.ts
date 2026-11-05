// The agent socket (GET /api/agent/socket): an overseer session's connection, with the digest items
// wait_for_decisions returns, a heartbeat, presence, and close codes for every refusal or end.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import type { StreamEvent } from '../src/types.ts';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

const WATCHER = 'watcher-token-0123456789';
const QUIET = 200;
const OFFLINE = 600;
const PING = 100;

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer(
    { LANESIGNAL_OBSERVER_TOKENS: `overseer:${WATCHER}`, LANESIGNAL_SIGNIN_RATE_MAX: '50' },
    { presence: { quietMs: QUIET, offlineMs: OFFLINE }, agentSocket: { pingMs: PING, missedPings: 2 } },
  );
});
after(() => srv.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await sleep(10);
  }
}

type Frame = { type: string; [k: string]: any };

/** A socket from the test, recording its frames and how it closed. */
function connect(
  query: string,
  token: string | null = AGENT,
  opts: { path?: string; base?: string; ws?: WebSocket.ClientOptions } = {},
) {
  const url = `${(opts.base ?? srv.base).replace(/^http/, 'ws')}${opts.path ?? '/api/agent/socket'}${query ? `?${query}` : ''}`;
  const ws = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, ...opts.ws });
  const frames: Frame[] = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  ws.on('error', () => {});
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  /** Resolves once a refused upgrade's response is over and the server let go of its connection. */
  let refusedEnd: () => void;
  const refused = new Promise<void>((r) => (refusedEnd = r));
  const status = new Promise<number | null>((resolve) => {
    ws.on('upgrade', () => resolve(101));
    // With a listener here, ws leaves the refused request to us: read it to its end.
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? null);
      res.on('close', () => refusedEnd());
      res.resume();
    });
  });
  /** Item frames' items so far. */
  const items = () => frames.filter((f) => f.type === 'items').flatMap((f) => f.items as any[]);
  return {
    ws,
    frames,
    closed,
    status,
    refused,
    items,
    /** Waits for a frame matching `ok`. */
    async frame(ok: (f: Frame) => boolean, ms = 3000) {
      const f = await until(() => frames.find(ok), (v) => v !== undefined, ms);
      assert.ok(f, `no matching frame; got ${JSON.stringify(frames)}`);
      return f!;
    },
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
    stop: async () => {
      ws.close();
      await closed;
    },
  };
}

const register = async (group: string, token = AGENT) => {
  const res = await srv.call('PUT', `/api/groups/${group}`, token, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

const presenceOf = async (group: string) =>
  ((await srv.call('GET', '/api/groups', ALICE)).body as any[]).find((g) => g.id === group)?.presence;

const laneOf = async (lane: string) => (await srv.call('GET', `/api/lanes/${lane}`, ALICE)).body.lane as { agentWaiting: boolean };

async function ask(lane: string, question: string) {
  const res = await srv.call('POST', '/api/escalations', AGENT, { laneId: lane, question });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; ref: string };
}

const decide = async (id: string, decision: string) => {
  const res = await srv.call('POST', `/api/escalations/${id}/decide`, ALICE, { decision });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

/** The group's presence transitions from now on. */
function recordTransitions(group: string) {
  const seen: unknown[] = [];
  const on = (e: StreamEvent) => {
    if (e.type === 'group' && e.group.id === `default/${group}` && e.presence) seen.push(e.presence);
  };
  srv.store.events.on('change', on);
  return { seen, stop: () => srv.store.events.off('change', on) };
}

/** A person with an account, signed in, and an agent key of theirs. */
async function personWithKey(name: string, email: string) {
  const password = 'correct horse battery';
  const created = await srv.call('POST', '/api/admin/people', ALICE, { email, name, password });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const signIn = await fetch(`${srv.base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(signIn.status, 200);
  const session = signIn.headers.get('set-auth-token')!;
  const key = await fetch(`${srv.base}/api/auth/api-key/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session}`, origin: srv.base },
    body: JSON.stringify({ name: `${name.toLowerCase()}-bot` }),
  });
  assert.equal(key.status, 200);
  return { userId: created.body.id as string, session, key: (await key.json()).key as string };
}

describe('agent socket: connecting', () => {
  test('the header credential opens it: hello, then what is pending', async () => {
    await register('sock-hello');
    const c = connect('group=sock-hello&session=s1');
    assert.equal(await c.status, 101);
    const hello = await c.frame((f) => f.type === 'hello');
    assert.equal(hello.group, 'sock-hello');
    assert.equal(hello.session, 's1');
    assert.ok(Date.parse(hello.checkedAt));
    const first = await c.frame((f) => f.type === 'items');
    assert.deepEqual(first.items, []);
    assert.deepEqual(first.counts, { open: 0, decidedUnacknowledged: 0, waitingOnYou: 0 });
    assert.equal(first.checkedAt, hello.checkedAt);
    assert.equal(c.frames.indexOf(hello), 0, 'hello comes first');
    await c.stop();
  });

  test('refusals are close codes after the upgrade', async () => {
    await register('sock-refuse');
    const cases: [string, string | null, number][] = [
      ['no credential', null, 4401],
      ['a wrong key', 'not-a-key-0123456789', 4401],
      ["a person's credential", ALICE, 4403],
      ['an observer key', WATCHER, 4403],
      ["an agent key that isn't the group's overseer", REVIEWER, 4403],
    ];
    for (const [what, token, code] of cases) {
      const c = connect('group=sock-refuse&session=s', token);
      assert.equal(await c.status, 101, what);
      assert.equal((await c.closed).code, code, what);
      assert.ok(!c.frames.some((f) => f.type === 'hello'), what);
    }
    // The credential comes from the Authorization header only: not the query (as /api/events allows), nor a subprotocol.
    const query = connect(`group=sock-refuse&session=s&access_token=${AGENT}`, null);
    assert.equal((await query.closed).code, 4401);
    const proto = connect('group=sock-refuse&session=s', null, { ws: { protocols: [AGENT] } as WebSocket.ClientOptions });
    proto.ws.on('error', () => {});
    assert.notEqual((await proto.closed).code, 1000);
    assert.ok(!proto.frames.some((f) => f.type === 'hello'));
    // An unknown group, and one in a project the key can't see.
    assert.equal((await connect('group=sock-nowhere&session=s').closed).code, 4404);
    assert.equal((await connect('group=main&session=s&project=nope').closed).code, 4404);
    // A malformed query: a client bug, said so.
    const bad = await connect('group=sock-refuse').closed;
    assert.equal(bad.code, 4400);
    assert.match(bad.reason, /session/);
    assert.equal((await connect('group=sock-refuse&session=s&timeout=5').closed).code, 4400);
    // Nothing counted as a session.
    assert.equal((await presenceOf('sock-refuse')).state, 'disconnected');
  });

  test('a group with no owner takes any agent key', async () => {
    srv.store.upsertGroup('default/sock-unowned', { name: 'unowned' }, 'overseer');
    const c = connect('group=sock-unowned&session=s', REVIEWER);
    await c.frame((f) => f.type === 'hello');
    assert.equal((await presenceOf('sock-unowned')).sessions[0].transport, 'socket');
    await c.stop();
  });

  test('a wrong upgrade path gets 404 and its socket is destroyed', async () => {
    for (const path of ['/api/agent/socket/', '/api/events', '/mcp', '/nope']) {
      const c = connect('group=main&session=s', AGENT, { path });
      assert.equal(await c.status, 404, path);
      await c.refused;
    }
    // A plain request to the socket's path is told it's a WebSocket endpoint.
    assert.equal((await srv.call('GET', '/api/agent/socket?group=main&session=s', AGENT)).status, 426);
  });

  test('with answering in LaneSignal off, the socket path is 404 too', async () => {
    const off = await startServer({ LANESIGNAL_DECISIONS: 'false' });
    try {
      await off.call('PUT', '/api/groups/quiet', AGENT, {});
      const c = connect('group=quiet&session=s', AGENT, { base: off.base });
      assert.equal(await c.status, 404);
      await c.refused;
      assert.equal((await off.call('GET', '/api/agent/socket?group=quiet&session=s', AGENT)).status, 404);
    } finally {
      off.close();
    }
  });
});

describe('agent socket: items', () => {
  test('pending items on connect, then new ones as they come, each once per connection', async () => {
    await srv.publish('sock-items-lane', { group: 'sock-items' });
    const a = await ask('sock-items-lane', 'Ship it?');
    const b = await ask('sock-items-lane', 'Rename it?');
    await decide(a.id, 'yes');
    const c = connect('group=sock-items&session=s');
    const first = await c.frame((f) => f.type === 'items');
    assert.deepEqual(first.items, [{ code: a.ref, kind: 'decided', text: 'yes' }]);
    assert.deepEqual(first.counts, { open: 1, decidedUnacknowledged: 1, waitingOnYou: 0 });

    // A note from a person, then the second decision: each comes once, alone.
    const note = await srv.call('POST', '/api/groups/sock-items/messages', ALICE, { body: 'Mind the release' });
    assert.equal(note.status, 201);
    await c.frame((f) => f.type === 'items' && f.items.some((i: any) => i.kind === 'group_note'));
    await decide(b.id, 'no');
    const second = await c.frame((f) => f.type === 'items' && f.items.some((i: any) => i.code === b.ref));
    assert.deepEqual(second.items, [{ code: b.ref, kind: 'decided', text: 'no' }]);
    assert.deepEqual(second.counts, { open: 0, decidedUnacknowledged: 2, waitingOnYou: 0 });
    // Unrelated changes send nothing new.
    await srv.call('PUT', '/api/lanes/sock-items-lane', AGENT, { status: 'active' });
    await sleep(100);
    const items = c.items();
    assert.deepEqual(
      items.map((i) => [i.kind, i.code ?? i.id]),
      [
        ['decided', a.ref],
        ['group_note', String(note.body.id)],
        ['decided', b.ref],
      ],
    );
    assert.deepEqual(items[1], { kind: 'group_note', id: String(note.body.id), text: 'Mind the release', by: 'alice' });

    // A second connection gets what's still pending again.
    const again = connect('group=sock-items&session=s2');
    const pending = await again.frame((f) => f.type === 'items');
    assert.deepEqual(pending.items.map((i: any) => i.kind).sort(), ['decided', 'decided', 'group_note']);

    // The socket doesn't hand notes over: a wait from after the note still gets it as new (not `seen`).
    const wait = await srv.call('GET', `/api/wait?group=sock-items&timeout=0&since=${encodeURIComponent(second.checkedAt)}`, AGENT);
    const waitNote = wait.body.items.find((i: any) => i.kind === 'group_note');
    assert.ok(waitNote && !('seen' in waitNote), JSON.stringify(wait.body));
    await c.stop();
    await again.stop();
  });

  test('`since` brings back what was withdrawn or removed after it', async () => {
    await srv.publish('sock-since-lane', { group: 'sock-since' });
    const e = await ask('sock-since-lane', 'Keep it?');
    const before = (await srv.call('GET', '/api/wait?group=sock-since&timeout=0', AGENT)).body.checkedAt;
    assert.equal((await srv.call('POST', `/api/escalations/${e.id}/withdraw`, ALICE, { note: 'Not needed' })).status < 300, true);
    const c = connect(`group=sock-since&session=s&since=${encodeURIComponent(before)}`);
    const first = await c.frame((f) => f.type === 'items');
    assert.deepEqual(first.items.map((i: any) => [i.kind, i.code]), [['closed', e.ref]]);
    // Without one, only what's pending now.
    const fresh = connect('group=sock-since&session=s2');
    assert.deepEqual((await fresh.frame((f) => f.type === 'items')).items, []);
    // And a lane removed while connected comes as it happens.
    assert.equal((await srv.call('DELETE', '/api/lanes/sock-since-lane', ALICE)).status, 204);
    const removed = await fresh.frame((f) => f.type === 'items' && f.items.length > 0);
    assert.deepEqual(removed.items.map((i: any) => [i.kind, i.id]), [['lane_removed', 'sock-since-lane']]);
    await c.stop();
    await fresh.stop();
  });
});

describe('agent socket: heartbeat', () => {
  test('`ping` frames come every ping interval', async () => {
    await register('sock-ping');
    const c = connect('group=sock-ping&session=s');
    await c.frame((f) => f.type === 'hello');
    await sleep(PING * 3.5);
    const pings = c.frames.filter((f) => f.type === 'ping');
    assert.ok(pings.length >= 2 && pings.length <= 4, `${pings.length} pings`);
    assert.deepEqual(pings[0], { type: 'ping' });
    await c.stop();
  });

  test('a client that stops answering protocol pings is dropped', async () => {
    await register('sock-dead');
    const c = connect('group=sock-dead&session=s', AGENT, { ws: { autoPong: false } });
    await c.frame((f) => f.type === 'hello');
    const started = Date.now();
    const { code } = await c.closed;
    assert.equal(code, 1006, 'cut off, without a close handshake');
    const took = Date.now() - started;
    assert.ok(took >= PING * 2 - 20 && took < PING * 6, `dropped after ${took}ms`);
    // Its session ended like any other: listening for the quiet window, then reconnecting.
    const p = await until(() => presenceOf('sock-dead'), (v) => v.state === 'reconnecting');
    assert.equal(p.state, 'reconnecting');
  });

  test('a client that answers stays connected', async () => {
    await register('sock-alive');
    const c = connect('group=sock-alive&session=s');
    await c.frame((f) => f.type === 'hello');
    await sleep(PING * 5);
    assert.equal(c.ws.readyState, WebSocket.OPEN);
    await c.stop();
  });
});

describe('agent socket: presence', () => {
  test('the connection is a listening socket session; closed, it ends like a wait', async () => {
    await register('sock-pres');
    const events = recordTransitions('sock-pres');
    const c = connect('group=sock-pres&session=https://claude.ai/code/session_9');
    await c.frame((f) => f.type === 'hello');
    const p = await presenceOf('sock-pres');
    assert.equal(p.state, 'listening');
    assert.deepEqual(p.sessions.map((s: any) => [s.id, s.transport, s.state]), [['https://claude.ai/code/session_9', 'socket', 'listening']]);
    await c.stop();
    await until(() => presenceOf('sock-pres'), (v) => v.state === 'disconnected', 3000);
    events.stop();
    assert.deepEqual(
      events.seen.map((x: any) => x.to),
      ['listening', 'reconnecting', 'disconnected'],
    );
  });

  test('a reconnect inside the quiet window shows no change', async () => {
    await register('sock-recon');
    const first = connect('group=sock-recon&session=s');
    await first.frame((f) => f.type === 'hello');
    const events = recordTransitions('sock-recon');
    await first.stop();
    await sleep(20);
    const second = connect('group=sock-recon&session=s');
    await second.frame((f) => f.type === 'hello');
    await sleep(QUIET + 100);
    const p = await presenceOf('sock-recon');
    assert.equal(p.state, 'listening');
    assert.equal(p.sessions.length, 1);
    events.stop();
    assert.deepEqual(events.seen, []);
    await second.stop();
  });

  test('`armed: false` leads to not responding; `armed: true` back to listening', async () => {
    await register('sock-armed');
    const c = connect('group=sock-armed&session=s');
    await c.frame((f) => f.type === 'hello');
    // Never sent: armed.
    await sleep(OFFLINE + 50);
    assert.equal((await presenceOf('sock-armed')).state, 'listening');
    c.send({ type: 'armed', armed: false });
    await sleep(OFFLINE / 2);
    assert.equal((await presenceOf('sock-armed')).state, 'listening', 'still within the offline window');
    const p = await until(() => presenceOf('sock-armed'), (v) => v.state === 'not_responding');
    assert.equal(p.state, 'not_responding');
    assert.deepEqual(p.sessions.map((s: any) => s.state), ['not_responding']);
    // Junk is ignored.
    c.ws.send('not json');
    c.send({ type: 'armed', armed: 'yes' });
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    c.send({ type: 'armed', armed: true });
    assert.equal((await until(() => presenceOf('sock-armed'), (v) => v.state === 'listening')).state, 'listening');
    assert.equal(c.ws.readyState, WebSocket.OPEN);
    await c.stop();
  });

  test('an oversized frame closes the socket (1009)', async () => {
    await register('sock-big');
    const c = connect('group=sock-big&session=s');
    await c.frame((f) => f.type === 'hello');
    c.ws.send('x'.repeat(64 * 1024));
    assert.equal((await c.closed).code, 1009);
  });

  test('lanes show agent waiting while the session listens: open ones, and ones that get a question later', async () => {
    await srv.publish('sock-held-a', { group: 'sock-held' });
    await srv.publish('sock-held-b', { group: 'sock-held' });
    await ask('sock-held-a', 'First?');
    assert.equal((await laneOf('sock-held-a')).agentWaiting, false);
    const c = connect('group=sock-held&session=s');
    await c.frame((f) => f.type === 'items');
    assert.equal((await laneOf('sock-held-a')).agentWaiting, true);
    assert.equal((await laneOf('sock-held-b')).agentWaiting, false, 'nothing open there yet');
    await ask('sock-held-b', 'Second?');
    assert.equal((await until(() => laneOf('sock-held-b'), (l) => l.agentWaiting)).agentWaiting, true);
    // Not responding: the lanes stop showing it (after the quiet window, as after a wait).
    c.send({ type: 'armed', armed: false });
    await until(() => presenceOf('sock-held'), (v) => v.state === 'not_responding');
    assert.equal((await until(() => laneOf('sock-held-a'), (l) => !l.agentWaiting)).agentWaiting, false);
    // Back: held again.
    c.send({ type: 'armed', armed: true });
    assert.equal((await until(() => laneOf('sock-held-a'), (l) => l.agentWaiting)).agentWaiting, true);
    // Closed: released after the quiet window.
    await c.stop();
    await sleep(QUIET / 2);
    assert.equal((await laneOf('sock-held-a')).agentWaiting, true, 'within the quiet window');
    assert.equal((await until(() => laneOf('sock-held-a'), (l) => !l.agentWaiting)).agentWaiting, false);
    assert.equal((await laneOf('sock-held-b')).agentWaiting, false);
  });
});

describe('agent socket: closes', () => {
  test('a takeover closes the old overseer\'s socket with 4409', async () => {
    await register('sock-take');
    const c = connect('group=sock-take&session=s');
    await c.frame((f) => f.type === 'hello');
    // Registering again with the same key changes nothing.
    await register('sock-take');
    await sleep(50);
    assert.equal(c.ws.readyState, WebSocket.OPEN);
    await register('sock-take', REVIEWER);
    assert.equal((await c.closed).code, 4409);
    assert.equal((await presenceOf('sock-take')).state, 'disconnected');
    // The new overseer's socket is fine.
    const mine = connect('group=sock-take&session=s', REVIEWER);
    await mine.frame((f) => f.type === 'hello');
    await mine.stop();
  });

  test('an owner-less group taken by another key closes the others with 4409', async () => {
    srv.store.upsertGroup('default/sock-claim', { name: 'claim' }, 'overseer');
    const c = connect('group=sock-claim&session=s', REVIEWER);
    await c.frame((f) => f.type === 'hello');
    await register('sock-claim', AGENT);
    assert.equal((await c.closed).code, 4409);
  });

  test('a removed group closes it with 4404', async () => {
    await register('sock-gone');
    const c = connect('group=sock-gone&session=s');
    await c.frame((f) => f.type === 'hello');
    assert.equal((await srv.call('DELETE', '/api/groups/sock-gone', ALICE)).status, 204);
    assert.equal((await c.closed).code, 4404);
  });

  test('a revoked key closes it with 4401, and a membership change with 4100', async () => {
    const dana = await personWithKey('Dana', 'dana@example.com');
    await register('sock-rev', dana.key);
    const c = connect('group=sock-rev&session=s', dana.key);
    await c.frame((f) => f.type === 'hello');

    // Any membership change: the key's access is worked out again on reconnect.
    const member = await srv.call('PUT', `/api/projects/default/members/${dana.userId}`, ALICE, { role: 'member' });
    assert.ok(member.status < 300, JSON.stringify(member.body));
    assert.equal((await c.closed).code, 4100);

    const again = connect('group=sock-rev&session=s', dana.key);
    await again.frame((f) => f.type === 'hello');
    const list = await fetch(`${srv.base}/api/auth/api-key/list`, { headers: { authorization: `Bearer ${dana.session}`, origin: srv.base } });
    const keys = await list.json();
    const id = (keys.apiKeys ?? keys)[0].id;
    const del = await fetch(`${srv.base}/api/auth/api-key/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${dana.session}`, origin: srv.base },
      body: JSON.stringify({ keyId: id }),
    });
    assert.equal(del.status, 200);
    assert.equal((await again.closed).code, 4401);
  });

  test('shutdown closes every socket with 1012, and refuses new ones the same way', async () => {
    const other = await startServer({}, { agentSocket: { pingMs: PING } });
    try {
      await other.call('PUT', '/api/groups/sock-down', AGENT, {});
      const a = connect('group=sock-down&session=a', AGENT, { base: other.base });
      const b = connect('group=sock-down&session=b', AGENT, { base: other.base });
      await a.frame((f) => f.type === 'hello');
      await b.frame((f) => f.type === 'hello');
      other.closeSockets();
      assert.equal((await a.closed).code, 1012);
      assert.equal((await b.closed).code, 1012);
      const late = connect('group=sock-down&session=c', AGENT, { base: other.base });
      assert.equal((await late.closed).code, 1012);
    } finally {
      other.close();
    }
  });
});
