// The skill's relay (skills/lanesignal/relay.mjs) run against a test server: `serve` holds the agent socket and
// writes items to events.jsonl, `follow` prints them for Monitor, and the close codes, liveness and exits behave.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

const RELAY = fileURLToPath(new URL('../../skills/lanesignal/relay.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer({}, { presence: { quietMs: 200, offlineMs: 600 }, agentSocket: { pingMs: 100, missedPings: 2 } });
});
after(() => srv.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 8000, what = 'condition'): Promise<T> {
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

function run(args: string[], env: Record<string, string>): Run {
  const child = spawn(process.execPath, [RELAY, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** A group registered by AGENT, a session and the relay's environment and state folder for them. */
async function setup(group: string, opts: { base?: string; key?: string; env?: Record<string, string> } = {}) {
  const res = await srv.call('PUT', `/api/groups/${group}`, AGENT, {});
  assert.equal(res.status, 200);
  const root = mkdtempSync(path.join(tmpdir(), 'relay-'));
  dirs.push(root);
  const session = `session-${group}`;
  const env = {
    LANESIGNAL_URL: `${opts.base ?? srv.base}/mcp/`,
    LANESIGNAL_KEY: opts.key ?? AGENT,
    LANESIGNAL_GROUP: group,
    LANESIGNAL_RELAY_DIR: root,
    ...opts.env,
  };
  const dir = path.join(root, group, createHash('sha256').update(session).digest('hex').slice(0, 16));
  const file = (name: string) => path.join(dir, name);
  const read = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '');
  const events = () =>
    read('events.jsonl')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return {
    group,
    session,
    env,
    file,
    read,
    events,
    serve: (parent = process.pid) => run(['serve', '--session', session, '--parent', String(parent)], env),
    follow: () => run(['follow', '--session', session], env),
  };
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

// ---- tests ----

describe('relay: serve and follow', () => {
  test('items reach events.jsonl; follow prints from its offset and resumes without repeats or gaps', async () => {
    const r = await setup('relay-items');
    await note(r.group, 'before the relay');
    const serve = r.serve();
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 8000, 'a socket session');
    await until(() => notesIn(r.events()), (n) => n.includes('before the relay'), 8000, 'the pending note');
    await note(r.group, 'one');
    await until(() => notesIn(r.events()), (n) => n.includes('one'), 8000, 'note one in events.jsonl');
    assert.ok(r.read('since'), 'the last checkedAt is kept');

    const f1 = r.follow();
    await until(() => notesIn(f1.lines()), (n) => n.includes('one'), 8000, 'follow printing note one');
    assert.deepEqual(notesIn(f1.lines()), ['before the relay', 'one']);
    // The offset is everything printed.
    await until(() => Number(r.read('offset')), (o) => o === statSync(r.file('events.jsonl')).size, 4000, 'the offset');
    f1.child.kill('SIGTERM');
    await f1.exited;

    // Written while nobody follows: the next follower starts there.
    await note(r.group, 'two');
    await until(() => notesIn(r.events()), (n) => n.includes('two'), 8000, 'note two in events.jsonl');
    const f2 = r.follow();
    await until(() => notesIn(f2.lines()), (n) => n.includes('two'), 8000, 'follow printing note two');
    await note(r.group, 'three');
    await until(() => notesIn(f2.lines()), (n) => n.includes('three'), 8000, 'follow printing note three');
    assert.deepEqual(notesIn(f2.lines()), ['two', 'three']);
    // Each item went into the file once.
    assert.deepEqual(notesIn(r.events()), ['before the relay', 'one', 'two', 'three']);

    // A newer follower takes over: the older one exits.
    const f3 = r.follow();
    assert.equal(await f2.exited, 0);
    await until(() => Number(r.read('follower.pid')), (p) => p === f3.child.pid, 4000, 'the newest follower');
    serve.child.kill('SIGTERM');
    assert.equal(await serve.exited, 0);
    assert.equal(r.read('relay.pid'), '', 'serve removes its pid file');
  });

  test('a stopped follower reports armed: false (not responding), and a new one armed again', async () => {
    const r = await setup('relay-armed');
    r.serve();
    const f1 = r.follow();
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 8000, 'listening');
    // Killed outright, its pid file stays behind: the relay checks the process itself.
    f1.child.kill('SIGKILL');
    await f1.exited;
    await until(() => socketState(r.group, r.session), (s) => s === 'not_responding', 8000, 'not responding');
    r.follow();
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 8000, 'listening again');
  });

  test('a second serve for the same session exits, leaving the first', async () => {
    const r = await setup('relay-single');
    const first = r.serve();
    await until(() => r.read('relay.pid'), (p) => p === String(first.child.pid), 4000, 'the pid file');
    const second = r.serve();
    assert.equal(await second.exited, 0);
    assert.match(second.err(), /already serving/);
    assert.equal(first.child.exitCode, null);
    assert.equal(r.read('relay.pid'), String(first.child.pid));
  });

  test('serve exits when --parent is gone', async () => {
    const r = await setup('relay-parent');
    const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    children.add(parent);
    const serve = r.serve(parent.pid);
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 8000, 'listening');
    parent.kill('SIGKILL');
    assert.equal(await serve.exited, 0);
    assert.match(serve.err(), /agent is gone/);
  });

  test('serve exits after the idle timeout with nothing following it', async () => {
    const r = await setup('relay-idle', { env: { LANESIGNAL_RELAY_IDLE_MINUTES: '0.01' } });
    const serve = r.serve();
    assert.equal(await serve.exited, 0);
    assert.match(serve.err(), /nothing has followed/);
  });
});

describe('relay: connections', () => {
  /** A TCP proxy in front of the server that can cut its connections, or go silent. */
  async function proxy() {
    const conns = new Set<net.Socket>();
    let silent = false;
    let connections = 0;
    const port = Number(new URL(srv.base).port);
    const server = net.createServer((client) => {
      connections++;
      const upstream = net.connect(port, '127.0.0.1');
      conns.add(client).add(upstream);
      client.on('data', (d) => upstream.write(d));
      upstream.on('data', (d) => silent || client.write(d));
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
      silence: (on: boolean) => {
        silent = on;
      },
      close: () => {
        for (const c of conns) c.destroy();
        server.close();
      },
    };
  }

  test('a dropped connection reconnects from its checkedAt', async () => {
    const p = await proxy();
    try {
      const r = await setup('relay-drop', { base: p.base });
      r.serve();
      await note(r.group, 'first');
      await until(() => notesIn(r.events()), (n) => n.includes('first'), 8000, 'the first note');
      p.cut();
      await until(p.connections, (n) => n >= 2, 8000, 'a reconnect');
      await until(() => socketState(r.group, r.session), (s) => s === 'listening', 8000, 'listening again');
      await note(r.group, 'second');
      await until(() => notesIn(r.events()), (n) => n.includes('second'), 8000, 'the second note');
      // At least once: an unacknowledged note may come again after a reconnect, but nothing is lost or reordered.
      const seen = notesIn(r.events());
      assert.equal(seen[0], 'first');
      assert.equal(seen.at(-1), 'second');
    } finally {
      p.close();
    }
  });

  test('two ping intervals without a frame make it reconnect', async () => {
    const p = await proxy();
    try {
      const r = await setup('relay-silent', { base: p.base });
      r.serve();
      await until(() => socketState(r.group, r.session), (s) => s === 'listening', 8000, 'listening');
      await sleep(400); // a few pings, to learn the interval
      p.silence(true);
      await until(p.connections, (n) => n >= 2, 8000, 'a reconnect after silence');
      p.silence(false);
      await note(r.group, 'after the silence');
      await until(() => notesIn(r.events()), (n) => n.includes('after the silence'), 8000, 'the note');
    } finally {
      p.close();
    }
  });

  test('a takeover (4409) writes a final line, which ends the follower too, and serve exits', async () => {
    const r = await setup('relay-take');
    const serve = r.serve();
    const f = r.follow();
    await until(() => socketState(r.group, r.session), (s) => s === 'listening', 8000, 'listening');
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

  test('a server without the socket stops it at once, to fall back to the background wait', async () => {
    const off = await startServer({ LANESIGNAL_DECISIONS: 'false' });
    try {
      const r = await setup('relay-nosocket', { base: off.base });
      const serve = r.serve();
      assert.equal(await serve.exited, 1);
      assert.equal(r.events().at(-1).reason, 'unreachable');
    } finally {
      off.close();
    }
  });

  test('follow says so when serve is not running', { timeout: 30_000 }, async () => {
    const r = await setup('relay-absent');
    const f = r.follow();
    assert.equal(await f.exited, 0);
    assert.equal(f.lines().at(-1).reason, 'not_running');
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
