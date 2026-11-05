// Overseer presence over the existing waits: which of a group's overseer sessions are connected,
// held by `wait_for_decisions` and `GET /api/wait`, with the quiet and offline windows after.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { presenceForWait } from '../src/access.ts';
import { loadConfig } from '../src/config.ts';
import { MAX_SESSIONS, Presence } from '../src/presence.ts';
import { Store } from '../src/store.ts';
import type { PresenceChange, StreamEvent } from '../src/types.ts';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

const WATCHER = 'watcher-token-0123456789';
const QUIET = 200;
const OFFLINE = 600;

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer({ LANESIGNAL_OBSERVER_TOKENS: `overseer:${WATCHER}` }, { presence: { quietMs: QUIET, offlineMs: OFFLINE } });
});
after(() => srv.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await sleep(10);
  }
}

const presenceOf = async (group: string) =>
  ((await srv.call('GET', '/api/groups', ALICE)).body as any[]).find((g) => g.id === group)?.presence;

const register = async (group: string, token = AGENT) => {
  const res = await srv.call('PUT', `/api/groups/${group}`, token, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

/** A long `GET /api/wait` that hangs up when stopped. */
function openWait(query: string, token = AGENT) {
  const ctrl = new AbortController();
  const done = fetch(`${srv.base}/api/wait?timeout=30&${query}`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal })
    .then((r) => r.text())
    .catch(() => null);
  return {
    async stop() {
      ctrl.abort();
      await done;
    },
  };
}

const listening = (p: any) => p?.state === 'listening';
const sessionIds = (p: any) => (p?.sessions ?? []).map((s: any) => s.id).sort();

/** The group's events from now on. */
function recordEvents(group: string) {
  const seen: Extract<StreamEvent, { type: 'group' }>[] = [];
  const on = (e: StreamEvent) => {
    if (e.type === 'group' && e.group.id === `default/${group}`) seen.push(e);
  };
  srv.store.events.on('change', on);
  return { seen, stop: () => srv.store.events.off('change', on) };
}

describe('presence over waits', () => {
  test('a group nobody has waited on is disconnected, since the start', async () => {
    await register('pres-none');
    assert.deepEqual(await presenceOf('pres-none'), { state: 'disconnected', since: null, sessions: [] });
  });

  test('an idle group wait shows its session listening, named by `session`', async () => {
    await register('pres-idle');
    const w = openWait('group=pres-idle&session=https://claude.ai/code/session_1');
    const p = await until(() => presenceOf('pres-idle'), listening);
    assert.equal(p.state, 'listening');
    assert.deepEqual(p.sessions.map((s: any) => [s.id, s.transport, s.state]), [['https://claude.ai/code/session_1', 'wait', 'listening']]);
    assert.ok(p.since);
    await w.stop();
  });

  test('wait_for_decisions holds the session too; get_updates does not', async () => {
    await register('pres-mcp');
    const call = srv.tool(AGENT, 'wait_for_decisions', { group_id: 'pres-mcp', wait_seconds: 1, session: 'mcp-1' });
    assert.deepEqual(sessionIds(await until(() => presenceOf('pres-mcp'), listening)), ['mcp-1']);
    await call;
    await register('pres-updates');
    const res = await srv.tool(AGENT, 'get_updates', { group_id: 'pres-updates' });
    assert.equal(res.isError, false, res.text);
    assert.equal((await presenceOf('pres-updates')).state, 'disconnected');
    // `session` is only wait_for_decisions'.
    const list = await fetch(`${srv.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const line = (await list.text()).split('\n').find((l) => l.startsWith('data: '))!;
    const tools = JSON.parse(line.slice(6)).result.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    const props = (name: string) => Object.keys(tools.find((t) => t.name === name)!.inputSchema.properties);
    assert.ok(props('wait_for_decisions').includes('session'));
    assert.ok(!props('get_updates').includes('session'));
  });

  test('a wait that returns at once still checks its session in, without a name as wait:<key name>', async () => {
    await register('pres-quick');
    const res = await srv.call('GET', '/api/wait?group=pres-quick&timeout=0', AGENT);
    assert.equal(res.status, 200);
    const p = await presenceOf('pres-quick');
    assert.equal(p.state, 'listening');
    assert.deepEqual(sessionIds(p), ['wait:overseer']);
    // So does an MCP wait that's ready at once.
    await register('pres-quick-mcp');
    await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'pres-quick-mcp', wait_seconds: 0 });
    assert.equal((await presenceOf('pres-quick-mcp')).state, 'listening');
  });

  test('`session` is checked: up to 512 characters, and nothing else unknown on /api/wait', async () => {
    await register('pres-long');
    assert.equal((await srv.call('GET', `/api/wait?group=pres-long&timeout=0&session=${'x'.repeat(513)}`, AGENT)).status, 400);
    assert.equal((await srv.call('GET', `/api/wait?group=pres-long&timeout=0&session=${'x'.repeat(512)}`, AGENT)).status, 200);
    assert.equal((await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'pres-long', wait_seconds: 0, session: 'x'.repeat(513) })).isError, true);
  });

  test('after the wait: listening for the quiet window, then reconnecting, then disconnected', async () => {
    await register('pres-timers');
    const events = recordEvents('pres-timers');
    const w = openWait('group=pres-timers&session=s');
    await until(() => presenceOf('pres-timers'), listening);
    const ended = Date.now();
    await w.stop();
    const reconnecting = await until(() => presenceOf('pres-timers'), (p) => p.state === 'reconnecting');
    assert.equal(reconnecting.state, 'reconnecting');
    assert.ok(Date.now() - ended >= QUIET - 20, 'listening through the quiet window');
    assert.deepEqual(reconnecting.sessions.map((s: any) => s.state), ['reconnecting']);
    const gone = await until(() => presenceOf('pres-timers'), (p) => p.state === 'disconnected');
    assert.equal(gone.state, 'disconnected');
    assert.ok(Date.now() - ended >= OFFLINE - 20);
    assert.deepEqual(gone.sessions, [], "the session's record is dropped");
    assert.ok(gone.since, 'the group keeps when it went');
    events.stop();
    assert.deepEqual(
      events.seen.filter((e) => e.presence).map((e) => e.presence),
      [
        { from: 'disconnected', to: 'listening', reason: 'connected' },
        { from: 'listening', to: 'reconnecting', reason: 'quiet' },
        { from: 'reconnecting', to: 'disconnected', reason: 'offline' },
      ],
    );
    // Each event carries the group as it is after the change.
    assert.equal(events.seen.at(-1)!.group.presence!.state, 'disconnected');
  });

  test('a re-wait inside the quiet window shows no change', async () => {
    await register('pres-rewait');
    const first = openWait('group=pres-rewait&session=s');
    await until(() => presenceOf('pres-rewait'), listening);
    const events = recordEvents('pres-rewait');
    await first.stop();
    await sleep(20);
    const second = openWait('group=pres-rewait&session=s');
    await sleep(QUIET + 50);
    assert.equal((await presenceOf('pres-rewait')).state, 'listening');
    await second.stop();
    events.stop();
    assert.deepEqual(events.seen.filter((e) => e.presence), []);
  });

  test('two sessions on one key are tracked separately; a second one is a plain group event', async () => {
    await register('pres-two');
    const a = openWait('group=pres-two&session=a');
    await until(() => presenceOf('pres-two'), listening);
    const events = recordEvents('pres-two');
    const b = openWait('group=pres-two&session=b');
    const both = await until(() => presenceOf('pres-two'), (p) => p.sessions.length === 2);
    assert.deepEqual(sessionIds(both), ['a', 'b']);
    assert.ok(events.seen.length > 0 && events.seen.every((e) => !e.presence), 'only the session list changed');
    await a.stop();
    const one = await until(() => presenceOf('pres-two'), (p) => p.sessions.some((s: any) => s.state === 'reconnecting'));
    assert.equal(one.state, 'listening', 'the group takes its best session');
    assert.deepEqual(one.sessions.map((s: any) => [s.id, s.state]), [['b', 'listening'], ['a', 'reconnecting']]);
    // Two waits on one session hold it until both end.
    const b2 = openWait('group=pres-two&session=b');
    await sleep(50);
    await b.stop();
    await sleep(QUIET + 100);
    assert.equal((await presenceOf('pres-two')).sessions.find((s: any) => s.id === 'b').state, 'listening');
    await b2.stop();
    events.stop();
  });

  test("a non-overseer key's wait doesn't count, and neither does an observer's or a person's", async () => {
    await register('pres-others');
    for (const token of [REVIEWER, WATCHER, ALICE]) {
      const res = await srv.call('GET', '/api/wait?group=pres-others&timeout=0&session=x', token);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const w = openWait('group=pres-others&session=y', REVIEWER);
    await sleep(100);
    assert.equal((await presenceOf('pres-others')).state, 'disconnected');
    await w.stop();
    await srv.tool(REVIEWER, 'wait_for_decisions', { group_id: 'pres-others', wait_seconds: 0 });
    assert.equal((await presenceOf('pres-others')).state, 'disconnected');
  });

  test('a group with no owner counts any agent key, and the same name under two keys is two sessions', async () => {
    // Groups made by publishing a lane, or from before overseers, have no owner.
    srv.store.upsertGroup('default/pres-unowned', { name: 'unowned' }, 'overseer');
    assert.equal(srv.store.groupOwner('default/pres-unowned'), null);
    const a = openWait('group=pres-unowned&session=same', AGENT);
    const b = openWait('group=pres-unowned&session=same', REVIEWER);
    const p = await until(() => presenceOf('pres-unowned'), (v) => v.sessions.length === 2);
    assert.deepEqual(sessionIds(p), ['same', 'same']);
    // A person's or an observer's wait still doesn't.
    await srv.call('GET', '/api/wait?group=pres-unowned&timeout=0&session=person', ALICE);
    await srv.call('GET', '/api/wait?group=pres-unowned&timeout=0&session=watcher', WATCHER);
    assert.deepEqual(sessionIds(await presenceOf('pres-unowned')), ['same', 'same']);
    await a.stop();
    await b.stop();
  });

  test('a takeover ends the previous overseer\'s sessions at once; their late release does nothing', async () => {
    await register('pres-take');
    const w = openWait('group=pres-take&session=old');
    await until(() => presenceOf('pres-take'), listening);
    const events = recordEvents('pres-take');
    await register('pres-take', REVIEWER);
    const p = await presenceOf('pres-take');
    assert.equal(p.state, 'disconnected');
    assert.deepEqual(p.sessions, []);
    assert.deepEqual(
      events.seen.filter((e) => e.presence).map((e) => e.presence),
      [{ from: 'listening', to: 'disconnected', reason: 'taken_over' } satisfies PresenceChange],
    );
    const count = events.seen.length;
    // The old overseer's wait ends now: nothing changes, then or after the quiet window.
    await w.stop();
    await sleep(QUIET + 50);
    assert.equal((await presenceOf('pres-take')).state, 'disconnected');
    assert.equal(events.seen.length, count);
    // And its new waits don't count; the new overseer's do.
    await srv.call('GET', '/api/wait?group=pres-take&timeout=0&session=old', AGENT);
    assert.equal((await presenceOf('pres-take')).state, 'disconnected');
    await srv.call('GET', '/api/wait?group=pres-take&timeout=0&session=new', REVIEWER);
    assert.deepEqual(sessionIds(await presenceOf('pres-take')), ['new']);
    events.stop();
  });

  test('update_group takes a group over the same way', async () => {
    await register('pres-take-mcp');
    await srv.call('GET', '/api/wait?group=pres-take-mcp&timeout=0', AGENT);
    assert.equal((await presenceOf('pres-take-mcp')).state, 'listening');
    // Registering again with the same key changes nothing.
    await srv.tool(AGENT, 'update_group', { group_id: 'pres-take-mcp' });
    assert.equal((await presenceOf('pres-take-mcp')).state, 'listening');
    const res = await srv.tool(REVIEWER, 'update_group', { group_id: 'pres-take-mcp' });
    assert.equal(res.isError, false, res.text);
    assert.equal((await presenceOf('pres-take-mcp')).state, 'disconnected');
  });

  test('a group event reaches the dashboard with its presence transition', async () => {
    await register('pres-sse');
    const ctrl = new AbortController();
    const res = await fetch(`${srv.base}/api/events`, { headers: { authorization: `Bearer ${ALICE}` }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    await srv.call('GET', '/api/wait?group=pres-sse&timeout=0&session=s', AGENT);
    let text = '';
    const end = Date.now() + 3000;
    while (!text.includes('"presence":{"from"') && Date.now() < end) text += decoder.decode((await reader.read()).value);
    ctrl.abort();
    const line = text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"presence":{"from"'))!;
    const event = JSON.parse(line.slice(6));
    assert.equal(event.type, 'group');
    assert.equal(event.group.id, 'pres-sse');
    assert.deepEqual(event.presence, { from: 'disconnected', to: 'listening', reason: 'connected' });
    assert.equal(event.group.presence.sessions[0].id, 's');
  });

  test('a removed group forgets its presence', async () => {
    await register('pres-removed');
    await srv.call('GET', '/api/wait?group=pres-removed&timeout=0', AGENT);
    assert.equal((await srv.call('DELETE', '/api/groups/pres-removed', ALICE)).status, 204);
    await register('pres-removed');
    assert.equal((await presenceOf('pres-removed')).state, 'disconnected');
  });
});

describe('who counts', () => {
  test("a person whose key string matches the overseer's (same name) never counts", () => {
    // `token:twin` is both a config agent token's key and a config human token's: only the agent counts.
    srv.store.upsertGroup('default/pres-twin', { name: 'pres-twin' }, 'twin', 'token:twin');
    const person = presenceForWait(srv.store, { name: 'twin', role: 'human' }, 'default/pres-twin', undefined);
    assert.equal(srv.store.presence.of('default/pres-twin').state, 'disconnected');
    person();
    const agent = presenceForWait(srv.store, { name: 'twin', role: 'agent' }, 'default/pres-twin', undefined);
    assert.equal(srv.store.presence.of('default/pres-twin').state, 'listening');
    agent();
  });
});

describe('presence settings', () => {
  test('presence is absent with answering in LaneSignal off', async () => {
    const off = await startServer({ LANESIGNAL_DECISIONS: 'false' });
    try {
      await off.call('PUT', '/api/groups/quiet', AGENT, {});
      const groups = (await off.call('GET', '/api/groups', ALICE)).body as any[];
      assert.ok(groups.length > 0);
      assert.ok(groups.every((g) => !('presence' in g)));
      assert.equal((await off.call('GET', '/api/wait?group=quiet&timeout=0', AGENT)).status, 404);
    } finally {
      off.close();
    }
  });

  test('the quiet and offline windows: defaults, and quiet must be shorter', () => {
    const base = { LANESIGNAL_DATA_DIR: '/nonexistent-unused', LANESIGNAL_CONFIG: '/nonexistent.json' };
    assert.deepEqual(loadConfig(base).presence, { quietSeconds: 60, offlineMinutes: 10 });
    assert.deepEqual(
      loadConfig({ ...base, LANESIGNAL_PRESENCE_QUIET_SECONDS: '30', LANESIGNAL_PRESENCE_OFFLINE_MINUTES: '2' }).presence,
      { quietSeconds: 30, offlineMinutes: 2 },
    );
    assert.throws(() => loadConfig({ ...base, LANESIGNAL_PRESENCE_QUIET_SECONDS: '120', LANESIGNAL_PRESENCE_OFFLINE_MINUTES: '2' }), /shorter/);
    assert.throws(() => loadConfig({ ...base, LANESIGNAL_PRESENCE_QUIET_SECONDS: '0' }), /LANESIGNAL_PRESENCE_QUIET_SECONDS/);
  });
});

describe('the presence record', () => {
  const record = (quietMs = 30, offlineMs = 80) => {
    const changes: { group: string; change: PresenceChange | null }[] = [];
    const p = new Presence({ quietMs, offlineMs, now: () => new Date(), onChange: (group, change) => changes.push({ group, change }) });
    return { p, changes };
  };

  test('the cap: a new session past it drops the one that ended longest ago', async () => {
    const { p } = record(10_000, 20_000);
    const releases = Array.from({ length: MAX_SESSIONS }, (_, i) => p.attach('g', 'k', `s${i}`, 'wait'));
    // s3 ended first, then s7; the rest stay connected.
    releases[3]();
    await sleep(5);
    releases[7]();
    p.attach('g', 'k', 'new', 'wait');
    let ids = p.of('g').sessions.map((s) => s.id);
    assert.equal(ids.length, MAX_SESSIONS);
    assert.ok(!ids.includes('s3') && ids.includes('s7') && ids.includes('new'));
    p.attach('g', 'k', 'newer', 'wait');
    ids = p.of('g').sessions.map((s) => s.id);
    assert.ok(!ids.includes('s7') && ids.includes('newer'));
    // A dropped session's release does nothing.
    releases[3]();
    assert.equal(p.of('g').sessions.length, MAX_SESSIONS);
    p.close();
  });

  test('at the cap with every session connected, a new one is not tracked and nothing changes', () => {
    const { p, changes } = record(10_000, 20_000);
    for (let i = 0; i < MAX_SESSIONS; i++) p.attach('g', 'k', `s${i}`, 'wait');
    const before = changes.length;
    const release = p.attach('g', 'k', 'extra', 'wait');
    assert.equal(changes.length, before, 'no event');
    assert.ok(!p.of('g').sessions.some((s) => s.id === 'extra'));
    release();
    assert.equal(p.of('g').sessions.length, MAX_SESSIONS);
    p.close();
  });

  test('reconnecting and disconnected date from when the connection ended', async () => {
    let clock = Date.parse('2026-11-05T10:00:00Z');
    const p = new Presence({ quietMs: 20, offlineMs: 50, now: () => new Date(clock), onChange: () => {} });
    const release = p.attach('g', 'k', 's', 'wait');
    clock += 1000;
    release();
    const endedAt = new Date(clock).toISOString();
    clock += 5000; // the timers fire later than the connection ended
    await sleep(30);
    assert.equal(p.of('g').state, 'reconnecting');
    assert.equal(p.of('g').since, endedAt);
    assert.equal(p.of('g').sessions[0].since, endedAt);
    await sleep(40);
    assert.equal(p.of('g').state, 'disconnected');
    assert.equal(p.of('g').since, endedAt);
    p.close();
  });

  test('a release after a takeover is a no-op, even once the same session is back', () => {
    const { p } = record(10_000, 20_000);
    const stale = p.attach('g', 'old', 's', 'wait');
    p.endOwner('g', 'new');
    assert.equal(p.of('g').state, 'disconnected');
    // The same key and name connecting again is a new session: the old release doesn't end it.
    p.attach('g', 'old', 's', 'wait');
    stale();
    assert.deepEqual(p.of('g').sessions.map((s) => s.state), ['listening']);
    p.close();
  });

  test('unread events make a connected session not responding, after the offline window', async () => {
    const { p, changes } = record(20, 60);
    const release = p.attach('g', 'k', 's', 'socket');
    p.setArmed('g', 'k', 's', false);
    await sleep(100);
    assert.equal(p.of('g').state, 'not_responding');
    p.setArmed('g', 'k', 's', true);
    assert.equal(p.of('g').state, 'listening');
    assert.deepEqual(
      changes.map((c) => c.change?.reason),
      ['connected', 'not_reading', 'reading'],
    );
    release();
    p.close();
  });

  test('timers stop on close', async () => {
    const { p, changes } = record(20, 40);
    p.attach('g', 'k', 's', 'wait')();
    const before = changes.length;
    p.close();
    await sleep(80);
    assert.equal(changes.length, before);
    assert.equal(p.of('g').state, 'listening');
    // Nothing attaches after close.
    p.attach('g', 'k', 'late', 'wait');
    assert.equal(p.of('g').sessions.length, 1);
  });

  test("a store's presence timers stop on close, and tolerate a closed database", async () => {
    const store = new Store({ path: ':memory:', resolveTicketUrl: () => null, waitGraceMs: 20, presenceOfflineMs: 40 });
    store.upsertGroup('default/g', { name: 'g' }, 'overseer', 'token:overseer');
    const events: StreamEvent[] = [];
    store.events.on('change', (e) => events.push(e));
    store.presence.attach('default/g', 'token:overseer', 's', 'wait')();
    assert.equal(store.getGroup('default/g')!.presence!.state, 'listening');
    store.close();
    const before = events.length;
    await sleep(80);
    assert.equal(events.length, before);
  });
});
