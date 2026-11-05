// The skill's relay (skills/lanesignal/relay.mjs) run against a test server: `serve` holds the agent socket and
// writes items to events.jsonl, `follow` prints them for Monitor, and the close codes, liveness and exits behave.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

const RELAY = fileURLToPath(new URL('../../skills/lanesignal/relay.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer({}, { presence: { quietMs: 200, offlineMs: 600 }, agentSocket: { pingMs: 100, missedPings: 2 } });
});
after(() => srv.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}; last: ${JSON.stringify(v)}`);
    await sleep(25);
  }
}

// ---- running the relay ----

const children = new Set<ChildProcess>();
const dirs: string[] = [];
afterEach(() => {
  for (const c of children) c.kill('SIGKILL');
  children.clear();
});
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Run = { child: ChildProcess; out: () => string; err: () => string; exited: Promise<number | null>; lines: () => any[] };

function run(args: string[], env: Record<string, string>, cwd?: string): Run {
  const child = spawn(process.execPath, [RELAY, ...args], { cwd, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      children.delete(child);
      resolve(code);
    }),
  );
  const lines = () =>
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { child, out: () => out, err: () => err, exited, lines };
}

const tempDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'relay-'));
  dirs.push(d);
  return d;
};

const hashOf = (session: string) => createHash('sha256').update(session).digest('hex').slice(0, 16);

/** A group registered by AGENT, a session and the relay's environment and state folder for them. */
async function setup(group: string, opts: { base?: string; key?: string; env?: Record<string, string>; register?: boolean } = {}) {
  if (opts.register !== false) {
    const res = await srv.call('PUT', `/api/groups/${group}`, AGENT, {});
    assert.equal(res.status, 200);
  }
  const root = tempDir();
  const session = `session-${group}`;
  const env = {
    LANESIGNAL_URL: `${opts.base ?? srv.base}/mcp/`,
    LANESIGNAL_KEY: opts.key ?? AGENT,
    LANESIGNAL_GROUP: group,
    LANESIGNAL_RELAY_DIR: root,
    ...opts.env,
  };
  const dir = path.join(root, group, hashOf(session));
  const file = (name: string) => path.join(dir, name);
  const read = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '');
  const events = () =>
    read('events.jsonl')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { unparsed: l };
        }
      });
  return {
    group,
    session,
    env,
    root,
    dir,
    file,
    read,
    events,
    /** The pid in a pid file, or null. */
    pidIn: (name: string) => {
      try {
        return JSON.parse(read(name)).pid as number;
      } catch {
        return null;
      }
    },
    serve: (parent: number = process.pid) => run(['serve', '--session', session, '--parent', String(parent)], env),
    follow: () => run(['follow', '--session', session], env),
  };
}

/** A pid file another process left: a live pid (this test's), but not touched for a minute. */
function stalePidFile(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'someone-else' }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
}

const sessionsOf = async (group: string) =>
  (((await srv.call('GET', '/api/groups', ALICE)).body as any[]).find((g) => g.id === group)?.presence?.sessions ?? []) as {
    id: string;
    transport: string;
    state: string;
  }[];

const socketState = async (group: string, session: string) => (await sessionsOf(group)).find((s) => s.id === session && s.transport === 'socket')?.state;

async function note(group: string, body: string) {
  const res = await srv.call('POST', `/api/groups/${group}/messages`, ALICE, { body });
  assert.equal(res.status, 201);
  return String(res.body.id);
}

const notesIn = (lines: any[]) => lines.filter((l) => l.kind === 'group_note').map((l) => l.text);

/** A port nothing listens on. */
async function closedPort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

// ---- tests ----

describe('relay: serve and follow', () => {
  test('items reach events.jsonl; follow prints from its offset and resumes without repeats or gaps', async () => {
    const r = await setup('relay-items');
    await note(r.group, 'before the relay');
    const serve = r.serve();
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 10_000, 'a socket session');
    await until(() => notesIn(r.events()), (n) => n.includes('before the relay'), 10_000, 'the pending note');
    await note(r.group, 'one');
    await until(() => notesIn(r.events()), (n) => n.includes('one'), 10_000, 'note one in events.jsonl');
    assert.ok(r.read('since'), 'the last checkedAt is kept');
    // Private, and kept out of git.
    assert.equal(readFileSync(path.join(r.root, '.gitignore'), 'utf8'), '*\n');
    assert.equal(statSync(r.dir).mode & 0o777, 0o700);
    assert.equal(statSync(r.file('events.jsonl')).mode & 0o777, 0o600);

    const f1 = r.follow();
    await until(() => notesIn(f1.lines()), (n) => n.includes('one'), 10_000, 'follow printing note one');
    assert.deepEqual(notesIn(f1.lines()), ['before the relay', 'one']);
    // The offset is everything printed.
    await until(() => Number(r.read('offset')), (o) => o === statSync(r.file('events.jsonl')).size, 4000, 'the offset');
    f1.child.kill('SIGTERM');
    await f1.exited;

    // Written while nobody follows: the next follower starts there.
    await note(r.group, 'two');
    await until(() => notesIn(r.events()), (n) => n.includes('two'), 10_000, 'note two in events.jsonl');
    const f2 = r.follow();
    await until(() => notesIn(f2.lines()), (n) => n.includes('two'), 10_000, 'follow printing note two');
    await note(r.group, 'three');
    await until(() => notesIn(f2.lines()), (n) => n.includes('three'), 10_000, 'follow printing note three');
    assert.deepEqual(notesIn(f2.lines()), ['two', 'three']);
    assert.deepEqual(notesIn(r.events()), ['before the relay', 'one', 'two', 'three']);

    // A newer follower takes over: the older one exits.
    const f3 = r.follow();
    assert.equal(await f2.exited, 0);
    await until(() => r.pidIn('follower.pid'), (p) => p === f3.child.pid, 4000, 'the newest follower');
    serve.child.kill('SIGTERM');
    assert.equal(await serve.exited, 0);
    assert.equal(r.read('relay.pid'), '', 'serve removes its pid file');
  });

  test('without LANESIGNAL_RELAY_DIR, state goes in the project, found from a subfolder', async () => {
    const project = tempDir();
    mkdirSync(path.join(project, '.claude'));
    mkdirSync(path.join(project, 'src', 'deep'), { recursive: true });
    const r = await setup('relay-anchored');
    const { LANESIGNAL_RELAY_DIR: _, ...env } = r.env;
    const serve = run(['serve', '--session', r.session, '--parent', String(process.pid)], env, path.join(project, 'src', 'deep'));
    const dir = path.join(project, '.claude', 'lanesignal', r.group, hashOf(r.session));
    await until(() => existsSync(path.join(dir, 'relay.pid')), (v) => v, 5000, 'the anchored state folder');
    serve.child.kill('SIGTERM');
    await serve.exited;
  });

  test('a stopped follower reports armed: false (not responding), and a new one armed again', async () => {
    const r = await setup('relay-armed');
    r.serve();
    const f1 = r.follow();
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 10_000, 'listening');
    // Killed outright, its pid file stays behind: the relay checks the process itself.
    f1.child.kill('SIGKILL');
    await f1.exited;
    await until(() => socketState(r.group, r.session), (s) => s === 'not_responding', 10_000, 'not responding');
    r.follow();
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 10_000, 'listening again');
  });

  test('a follower pid file nobody touches counts as gone, even when its pid is alive', async () => {
    const r = await setup('relay-stale-follower');
    stalePidFile(r.file('follower.pid'));
    r.serve();
    await until(() => socketState(r.group, r.session), (s) => s === 'not_responding', 10_000, 'not responding');
  });

  test('a second serve for the same session exits, leaving the first', async () => {
    const r = await setup('relay-single');
    const first = r.serve();
    await until(() => r.pidIn('relay.pid'), (p) => p === first.child.pid, 4000, 'the pid file');
    const second = r.serve();
    assert.equal(await second.exited, 0);
    assert.match(second.err(), /already serving/);
    assert.equal(first.child.exitCode, null);
    assert.equal(r.pidIn('relay.pid'), first.child.pid);
  });

  test('of two serves started together, one wins', async () => {
    const r = await setup('relay-race');
    const a = r.serve();
    const b = r.serve();
    const first = await Promise.race([a.exited.then(() => a), b.exited.then(() => b)]);
    assert.match(first.err(), /already serving/);
    const winner = first === a ? b : a;
    await sleep(300);
    assert.equal(winner.child.exitCode, null);
    assert.equal(r.pidIn('relay.pid'), winner.child.pid);
  });

  test('a relay pid file nobody touches is taken over, even when its pid is alive', async () => {
    const r = await setup('relay-stale-relay');
    stalePidFile(r.file('relay.pid'));
    const serve = r.serve();
    await until(() => r.pidIn('relay.pid'), (p) => p === serve.child.pid, 4000, 'taken over');
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 10_000, 'listening');
  });

  test('serve exits when --parent is gone, and ignores a --parent it cannot see', async () => {
    const r = await setup('relay-parent');
    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.add(parent);
    const serve = r.serve(parent.pid);
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 10_000, 'listening');
    parent.kill('SIGKILL');
    assert.equal(await serve.exited, 0);
    assert.match(serve.err(), /agent is gone/);

    const r2 = await setup('relay-parent-invisible');
    const blind = r2.serve(999_999_999);
    await until(() => socketState(r2.group, r2.session), (s) => s === 'listening', 10_000, 'listening without a parent');
    assert.match(blind.err(), /isn't visible/);
    assert.equal(blind.child.exitCode, null);
  });

  test('serve exits after the idle timeout with nothing following it', async () => {
    const r = await setup('relay-idle', { env: { LANESIGNAL_RELAY_IDLE_MINUTES: '0.01' } });
    const serve = r.serve();
    assert.equal(await serve.exited, 0);
    assert.match(serve.err(), /nothing has followed/);
  });

  test('a line cut short is ended before anything new is written', async () => {
    const r = await setup('relay-partial');
    mkdirSync(r.dir, { recursive: true });
    writeFileSync(r.file('events.jsonl'), '{"kind":"group_note","id":"x","text":"cut');
    r.serve();
    await note(r.group, 'whole');
    await until(() => notesIn(r.events()), (n) => n.includes('whole'), 10_000, 'the note');
    assert.deepEqual(r.events()[0], { unparsed: '{"kind":"group_note","id":"x","text":"cut' });
  });

  test('follow says so when serve is not running, even when an old pid file names a live pid', { timeout: 30_000 }, async () => {
    const r = await setup('relay-absent');
    stalePidFile(r.file('relay.pid'));
    const f = r.follow();
    assert.equal(await f.exited, 0);
    assert.equal(f.lines().at(-1).reason, 'not_running');
  });
});

describe('relay: connections', () => {
  /** A TCP proxy in front of the server that can cut its connections. */
  async function proxy() {
    const conns = new Set<net.Socket>();
    let connections = 0;
    const port = Number(new URL(srv.base).port);
    const server = net.createServer((client) => {
      connections++;
      const upstream = net.connect(port, '127.0.0.1');
      conns.add(client).add(upstream);
      client.on('data', (d) => upstream.write(d));
      upstream.on('data', (d) => client.write(d));
      const end = () => {
        client.destroy();
        upstream.destroy();
        conns.delete(client);
        conns.delete(upstream);
      };
      client.on('close', end).on('error', end);
      upstream.on('close', end).on('error', end);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
      connections: () => connections,
      cut: () => {
        for (const c of conns) c.destroy();
      },
      close: () => {
        for (const c of conns) c.destroy();
        server.close();
      },
    };
  }

  test('a dropped connection reconnects from its checkedAt; decisions and notes come once, across restarts too', async () => {
    const p = await proxy();
    try {
      const r = await setup('relay-drop', { base: p.base });
      await srv.publish('relay-drop-lane', { group: r.group });
      const asked = await srv.call('POST', '/api/escalations', AGENT, { laneId: 'relay-drop-lane', question: 'Ship it?' });
      assert.equal(asked.status, 201);
      assert.equal((await srv.call('POST', `/api/escalations/${asked.body.id}/decide`, ALICE, { decision: 'yes' })).status, 200);
      const serve = r.serve();
      await note(r.group, 'first');
      await until(() => notesIn(r.events()), (n) => n.includes('first'), 10_000, 'the first note');
      p.cut();
      await until(p.connections, (n) => n >= 2, 10_000, 'a reconnect');
      await until(() => socketState(r.group, r.session), (s) => s === 'listening', 10_000, 'listening again');
      await note(r.group, 'second');
      await until(() => notesIn(r.events()), (n) => n.includes('second'), 10_000, 'the second note');
      // Restarted, it knows what it wrote.
      serve.child.kill('SIGTERM');
      await serve.exited;
      r.serve();
      await note(r.group, 'third');
      await until(() => notesIn(r.events()), (n) => n.includes('third'), 10_000, 'the third note');
      assert.deepEqual(notesIn(r.events()), ['first', 'second', 'third']);
      assert.equal(r.events().filter((l) => l.kind === 'decided').length, 1);
    } finally {
      p.close();
    }
  });

  /** A socket server of our own: `onConnection` gets each connection after hello (pings every 0.1s, 2 missed). */
  async function fakeSocket(onConnection: (ws: import('ws').WebSocket) => void) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const at: number[] = [];
    wss.on('connection', (ws) => {
      at.push(Date.now());
      ws.send(JSON.stringify({ type: 'hello', group: 'g', session: 's', checkedAt: new Date().toISOString(), pingSeconds: 0.1, missedPings: 2 }));
      onConnection(ws);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
      at,
      close() {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.closeAllConnections();
        server.close();
      },
    };
  }

  test('silence past pingSeconds × missedPings (and slack) makes it reconnect', { timeout: 30_000 }, async () => {
    // A server that greets, then says nothing (and doesn't drop the connection itself).
    const fake = await fakeSocket(() => {});
    try {
      const r = await setup('relay-silent', { base: fake.base, register: false });
      r.serve();
      await until(() => fake.at.length, (n) => n >= 2, 15_000, 'a reconnect after silence');
      // 0.1s × 2 + 5s of slack, checked every 2s.
      const gap = fake.at[1] - fake.at[0];
      assert.ok(gap >= 5000 && gap < 9000, `reconnected after ${gap}ms`);
    } finally {
      fake.close();
    }
  });

  test('a takeover (4409) writes a final line, which ends the follower too, and serve exits 1', async () => {
    const r = await setup('relay-take');
    const serve = r.serve();
    const f = r.follow();
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 10_000, 'listening');
    assert.equal((await srv.call('PUT', `/api/groups/${r.group}`, REVIEWER, {})).status, 200);
    assert.equal(await serve.exited, 1);
    const last = r.events().at(-1);
    assert.equal(last.type, 'relay_stopped');
    assert.equal(last.code, 4409);
    assert.equal(last.reason, 'taken_over');
    assert.equal(await f.exited, 0);
    assert.equal(f.lines().at(-1).reason, 'taken_over');
    assert.equal(r.read('relay.pid'), '');
  });

  test('a refused key (4401) stops it', async () => {
    const r = await setup('relay-key', { key: 'not-a-real-key-0123456789' });
    const serve = r.serve();
    assert.equal(await serve.exited, 1);
    assert.deepEqual(
      (({ type, code, reason }) => ({ type, code, reason }))(r.events().at(-1)),
      { type: 'relay_stopped', code: 4401, reason: 'unauthorized' },
    );
  });

  test('a LaneSignal without the socket stops it at once, to fall back to the background wait', async () => {
    const off = await startServer({ LANESIGNAL_DECISIONS: 'false' });
    try {
      const r = await setup('relay-nosocket', { base: off.base });
      const serve = r.serve();
      assert.equal(await serve.exited, 1);
      const last = r.events().at(-1);
      assert.equal(last.reason, 'unreachable');
      assert.match(last.detail, /no agent socket/);
    } finally {
      off.close();
    }
  });

  test('a server it never reaches stops it quickly', async () => {
    const r = await setup('relay-nowhere', { base: `http://127.0.0.1:${await closedPort()}`, register: false });
    const serve = r.serve();
    assert.equal(await serve.exited, 1);
    const last = r.events().at(-1);
    assert.equal(last.reason, 'unreachable');
    assert.match(last.detail, /can't reach|never connected/);
  });

  test('a proxy variable covering the server gives up at the first failure, saying why; NO_PROXY exempts it', async () => {
    const r = await setup('relay-proxy', { base: `http://127.0.0.1:${await closedPort()}`, register: false, env: { HTTP_PROXY: 'http://127.0.0.1:9' } });
    const serve = r.serve();
    assert.equal(await serve.exited, 1);
    assert.match(r.events().at(-1).detail, /HTTP_PROXY/);

    const ok = await setup('relay-noproxy', { env: { HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' } });
    ok.serve();
    await until(() => socketState(ok.group, ok.session), (s) => s === 'listening', 10_000, 'listening');
  });

  test('a 404 that is not LaneSignal JSON keeps it trying', async () => {
    const other = http.createServer((_req, res) => res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not here</h1>'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const r = await setup('relay-html404', { base: `http://127.0.0.1:${(other.address() as net.AddressInfo).port}`, register: false });
      const serve = r.serve();
      assert.equal(await serve.exited, 1);
      const last = r.events().at(-1);
      assert.equal(last.reason, 'unreachable');
      assert.match(last.detail, /never connected/, 'gave up after its tries, not on the 404');
    } finally {
      other.closeAllConnections();
      other.close();
    }
  });

  test('a connection that ends right after hello keeps backing off', { timeout: 30_000 }, async () => {
    const fake = await fakeSocket((ws) => ws.close(1011, 'internal error'));
    try {
      const r = await setup('relay-flaky', { base: fake.base, register: false });
      r.serve();
      const { at } = fake;
      await until(() => at.length, (n) => n >= 4, 15_000, 'four connections');
      // Backoff with jitter: 0.5–1s, 1–2s, then 2–4s. Had hello reset it, every gap would be under a second.
      assert.ok(at[3] - at[2] >= 1900, `third gap ${at[3] - at[2]}ms`);
    } finally {
      fake.close();
    }
  });
});

describe('relay: shipping', () => {
  test('GET /api/skill/relay.mjs serves the relay, publicly, as JavaScript', async () => {
    const res = await fetch(`${srv.base}/api/skill/relay.mjs`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await res.text(), readFileSync(RELAY, 'utf8'));
  });

  test('the plugin carries the same relay (build-plugin-skill --check)', () => {
    const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-plugin-skill.mjs'), '--check'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(readFileSync(path.join(ROOT, 'plugin/skills/lanesignal/relay.mjs'), 'utf8'), readFileSync(RELAY, 'utf8'));
  });

  test('usage errors exit 2 without touching anything', () => {
    const res = spawnSync(process.execPath, [RELAY, 'serve', '--session', 'x'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--parent/);
  });
});
