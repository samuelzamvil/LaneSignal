#!/usr/bin/env node
// LaneSignal relay: holds an overseer session's agent socket (GET /api/agent/socket) for the whole agent session and
// writes what arrives to a local file that Claude Code's Monitor tool follows. Node 22.13+, built-ins only.
//
//   node relay.mjs serve --session <id> --parent <pid>   hold the socket (start once, in the background)
//   node relay.mjs follow --session <id>                 print new events, one JSON line each (the Monitor command)
//
// Environment: LANESIGNAL_URL (a trailing /mcp is fine), LANESIGNAL_KEY, LANESIGNAL_GROUP, and LANESIGNAL_PROJECT if
// the key reaches several projects. Optional: LANESIGNAL_CF_ACCESS_CLIENT_ID and LANESIGNAL_CF_ACCESS_CLIENT_SECRET
// (a Cloudflare Access service token), LANESIGNAL_RELAY_IDLE_MINUTES (30: serve exits after this long with nothing
// following it), LANESIGNAL_RELAY_GIVE_UP_SECONDS (600: how long serve keeps trying once a connection has worked),
// LANESIGNAL_RELAY_DIR (where state goes; by default .claude/lanesignal in the project: the nearest folder up from
// here holding .claude or .git).
//
// State, in <dir>/<group>/<first 16 hex of sha256(session)>/, private to the user (and git-ignored): events.jsonl
// (each item as one line), offset (how far follow has printed, in bytes), since (the last checkedAt, to reconnect
// from), and relay.pid and follower.pid, which their processes touch every few seconds: one not touched for a while
// counts as gone even if its pid now belongs to another process.
//
// Lines in events.jsonl are the socket's digest items as they come (each has a `kind`), and at most one last line
// {"type":"relay_stopped","code","reason","detail","message"} when serve stops for good (it then exits 1). `reason`:
//   taken_over    another overseer took the group over (4409): stop overseeing it
//   unauthorized  the key was refused or revoked (4401): tell the person
//   forbidden     not this group's overseer, or not an agent key (4403): tell the person
//   not_found     the group (or project) doesn't exist or was removed (4404): tell the person
//   bad_request   the server refused the query (4400): check LANESIGNAL_GROUP and --session
//   unreachable   it can't connect or stay connected, or the server has no socket: use the background wait
//   unsupported   this Node has no WebSocket client (22.13+ needed): use the background wait
//   crashed       the relay failed: start it again (and if it fails again, use the background wait)
// follow also prints {"type":"relay_stopped","reason":"not_running"} (not written to the file) when serve isn't
// running: start it again.
//
// Connecting: a serve that has never connected gives up after 3 failures or a minute (at the first failure when a
// proxy variable covers the server: Node's WebSocket doesn't use proxies). Once a connection has worked, it keeps
// trying for LANESIGNAL_RELAY_GIVE_UP_SECONDS, backing off up to 30 seconds. It reconnects when nothing has come for
// hello's pingSeconds × missedPings (at least 2) plus 5 seconds; the server pings every 20 seconds by default.
//
// Delivery is at least once. A reconnect sends what's still pending again: decisions (by code and words) and group
// notes (by id) already written aren't written again; other items are. Acknowledging goes through MCP, so a repeat
// is harmless.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FINAL_CODES = {
  4400: 'bad_request',
  4401: 'unauthorized',
  4403: 'forbidden',
  4404: 'not_found',
  4409: 'taken_over',
};
const MESSAGES = {
  taken_over: 'Another overseer took the group over: stop overseeing it.',
  unauthorized: 'The key was refused or revoked: tell the person.',
  forbidden: "This key isn't the group's overseer, or isn't an agent key: tell the person.",
  not_found: "The group doesn't exist or was removed: tell the person.",
  bad_request: 'The server refused the query: check LANESIGNAL_GROUP and --session.',
  unreachable: "The relay can't connect or stay connected: use the background wait instead.",
  unsupported: 'This Node has no WebSocket client (22.13 or later is needed): use the background wait instead.',
  crashed: 'The relay failed: start it again, and if it fails again, use the background wait instead.',
  not_running: 'The relay (serve) is not running: start it again, then follow again.',
};
const CHECK_MS = 2000; // serve's checks (parent, follower, liveness) and its beat on relay.pid
const FOLLOW_BEAT_MS = 1000; // follow's beat on follower.pid
const STALE_RELAY_MS = 3 * CHECK_MS + 1000; // a pid file not touched for this long is gone
const STALE_FOLLOWER_MS = 3 * FOLLOW_BEAT_MS + 1000;
const DEFAULT_SILENCE_MS = 45_000; // when hello doesn't say how often the server pings
const SILENCE_SLACK_MS = 5000;
const HEALTHY_MS = 30_000; // a connection that lived this long (or got a ping) resets the backoff
const BACKOFF_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const FIRST_TRIES = 3; // never connected: give up after this many failures…
const FIRST_GIVE_UP_MS = 60_000; // …or this long
const GIVE_UP_MS = Number(process.env.LANESIGNAL_RELAY_GIVE_UP_SECONDS || 600) * 1000;
const FOLLOWER_GRACE_MS = 15_000; // how long follow waits for serve to (re)appear before saying it's not running
const REMEMBERED = 5000; // item keys serve remembers, so a reconnect doesn't write a decision or note twice

// ---- shared ----

function args(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) usage(`unexpected argument: ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, opts };
}

function usage(problem) {
  console.error(`relay: ${problem}\nusage: node relay.mjs serve --session <id> --parent <pid>\n       node relay.mjs follow --session <id>`);
  process.exit(2);
}

function env(name) {
  const value = process.env[name]?.trim();
  if (!value) usage(`${name} is not set`);
  return value;
}

/** Where state goes: LANESIGNAL_RELAY_DIR, or .claude/lanesignal in the nearest folder up holding .claude or .git. */
function stateRoot() {
  if (process.env.LANESIGNAL_RELAY_DIR) return path.resolve(process.env.LANESIGNAL_RELAY_DIR);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, '.git'))) return path.join(dir, '.claude', 'lanesignal');
    if (path.dirname(dir) === dir) return path.resolve('.claude', 'lanesignal');
  }
}

/** The state folder for this group and session, private to the user; the root keeps itself out of git. */
function stateDir(group, session) {
  const root = stateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', { mode: 0o600 });
  const hash = createHash('sha256').update(session).digest('hex').slice(0, 16);
  const dir = path.join(root, group.replace(/[^A-Za-z0-9._-]/g, '_'), hash);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Whether a process is alive (EPERM: it is, but not ours). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Replaces a small file in one step, so a reader never sees half of it. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// A pid file holds {pid, token, started}; its process touches it as a heartbeat.
const TOKEN = randomBytes(8).toString('hex');
const pidText = () => JSON.stringify({ pid: process.pid, token: TOKEN, started: new Date().toISOString() });

function readPidFile(file) {
  try {
    const { mtimeMs } = fs.statSync(file);
    const { pid, token } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { pid, token, mtimeMs };
  } catch {
    return null;
  }
}

/** Whether a pid file's process is running: touched lately and its pid alive (a reused pid alone isn't enough). */
function live(file, staleMs) {
  const p = readPidFile(file);
  return !!p && Date.now() - p.mtimeMs < staleMs && alive(p.pid);
}

const ours = (file) => readPidFile(file)?.token === TOKEN;

/** Touches our pid file; false if it isn't ours any more. */
function beat(file) {
  if (!ours(file)) return false;
  const now = new Date();
  try {
    fs.utimesSync(file, now, now);
  } catch {}
  return true;
}

/** Removes a pid file if it's still ours. */
function releasePid(file) {
  if (ours(file)) fs.rmSync(file, { force: true });
}

/** The proxy variable that covers this URL, if any (Node's WebSocket ignores it). */
function proxied(url) {
  const u = new URL(url);
  const secure = u.protocol === 'wss:';
  const proxy = secure ? process.env.HTTPS_PROXY || process.env.https_proxy : process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  for (let entry of (process.env.NO_PROXY || process.env.no_proxy || '').split(/[\s,]+/)) {
    entry = entry.trim().toLowerCase().replace(/:\d+$/, '');
    if (!entry) continue;
    if (entry === '*') return null;
    const bare = entry.replace(/^\*?\./, '');
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }
  return secure ? 'HTTPS_PROXY' : 'HTTP_PROXY';
}

function atLeast(version, [major, minor]) {
  const [a, b] = version.split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

/** ws(s)://host/api/agent/socket from LANESIGNAL_URL: a trailing /mcp and slashes go, http becomes ws. */
function socketUrl(raw) {
  let base = raw.replace(/\/+$/, '').replace(/\/mcp$/, '').replace(/\/+$/, '');
  const u = new URL(base);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('expected an http(s) URL');
  base = u.toString().replace(/\/+$/, '');
  return `${base}/api/agent/socket`;
}

// ---- serve ----

function serve(opts) {
  const session = opts.session?.trim() || usage('serve needs --session');
  let parent = Number.parseInt(opts.parent ?? '', 10);
  if (!(parent > 0)) usage('serve needs --parent <pid>');
  const group = env('LANESIGNAL_GROUP');
  let url;
  try {
    url = socketUrl(env('LANESIGNAL_URL'));
  } catch (err) {
    usage(`LANESIGNAL_URL: ${err.message}`);
  }
  const headers = { authorization: `Bearer ${env('LANESIGNAL_KEY')}` };
  const cfId = process.env.LANESIGNAL_CF_ACCESS_CLIENT_ID?.trim();
  const cfSecret = process.env.LANESIGNAL_CF_ACCESS_CLIENT_SECRET?.trim();
  if (cfId && cfSecret) Object.assign(headers, { 'CF-Access-Client-Id': cfId, 'CF-Access-Client-Secret': cfSecret });
  const project = process.env.LANESIGNAL_PROJECT?.trim();
  const idleMs = Number(process.env.LANESIGNAL_RELAY_IDLE_MINUTES || 30) * 60_000;
  const proxyVar = proxied(url);

  const dir = stateDir(group, session);
  const file = (name) => path.join(dir, name);
  const pidFile = file('relay.pid');
  const eventsFile = file('events.jsonl');

  // One serve per state folder. The pid file appears whole and at once (a link to a written temp file), so of two
  // starting together one wins; one left by a dead or silent process is taken over.
  const tmp = `${pidFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, pidText(), { mode: 0o600 });
  try {
    for (;;) {
      try {
        fs.linkSync(tmp, pidFile);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (live(pidFile, STALE_RELAY_MS)) {
          console.error(`relay: already serving this session (pid ${readPidFile(pidFile)?.pid})`);
          process.exit(0);
        }
        fs.rmSync(pidFile, { force: true });
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  const events = fs.openSync(eventsFile, 'a+', 0o600);
  let done = false;
  let checks = null; // the periodic checks' timer
  let ws = null;
  let drop = null; // ends the current connection as lost
  let retry = null; // the reconnect timer
  let attempts = 0; // failed connections since the last healthy one, for backoff
  const startedAt = Date.now();
  let failingSince = startedAt; // since when there's been no healthy connection (Infinity while there is one)
  let everConnected = false; // a hello came, ever
  let silenceMs = DEFAULT_SILENCE_MS;
  let lastFrameAt = 0;
  let armed = false;
  let unarmedSince = Date.now();

  /** Appends lines to events.jsonl, all in one write, and flushes them to disk. */
  const append = (objects) => {
    if (!objects.length) return;
    fs.writeSync(events, objects.map((o) => `${JSON.stringify(o)}\n`).join(''));
    fs.fsyncSync(events);
  };

  /** Stops for good, with a last line for the agent. */
  function stopFor(reason, code, detail) {
    if (done) return;
    try {
      append([{ type: 'relay_stopped', code: code ?? null, reason, detail: detail || undefined, message: MESSAGES[reason] }]);
    } catch {}
    console.error(`relay: stopped (${reason}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''})`);
    exit(1);
  }

  function exit(code = 0, { release = true } = {}) {
    if (done) return;
    done = true;
    clearInterval(checks);
    clearTimeout(retry);
    try {
      ws?.close(1000, 'relay exiting');
    } catch {}
    if (release) releasePid(pidFile);
    process.exitCode = code;
    // Let the close frame go out, but don't wait on a dead server.
    setTimeout(() => process.exit(code), 200).unref();
  }

  const crashed = (err) => {
    if (done) process.exit(1);
    stopFor('crashed', null, String(err?.stack || err).slice(0, 500));
  };
  process.on('uncaughtException', crashed);
  process.on('unhandledRejection', crashed);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => exit(0));

  if (typeof globalThis.WebSocket !== 'function' || !atLeast(process.versions.node, [22, 13])) {
    return stopFor('unsupported', null, `Node ${process.versions.node}`);
  }
  if (!alive(parent)) {
    // Some shells and sandboxes hand out a pid this process can't see (Git Bash on Windows, pid namespaces).
    console.error(`relay: --parent ${parent} isn't visible from here; relying on the idle timeout instead`);
    parent = null;
  }

  // A line cut short (a crash mid-write) mustn't swallow the next one.
  const size = fs.fstatSync(events).size;
  if (size > 0) {
    const last = Buffer.alloc(1);
    fs.readSync(events, last, 0, 1, size - 1);
    if (last[0] !== 10) fs.writeSync(events, '\n');
  }

  // Decisions and notes already written aren't written again when a reconnect (or a restart) sends them again.
  const written = new Set();
  const dedupeKey = (item) =>
    item?.kind === 'decided' ? `decided ${item.code} ${item.text}` : item?.kind === 'group_note' ? `group_note ${item.id}` : null;
  const remember = (k) => {
    written.add(k);
    if (written.size > REMEMBERED) written.delete(written.values().next().value);
  };
  for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
    try {
      const k = dedupeKey(JSON.parse(line));
      if (k) remember(k);
    } catch {}
  }

  function connect() {
    retry = null;
    if (done) return;
    const since = readText(file('since'));
    const query = new URLSearchParams({ group, session });
    if (project) query.set('project', project);
    if (since) query.set('since', since);
    const socket = new WebSocket(`${url}?${query}`, { headers });
    ws = socket;
    let down = false;
    let opened = false;
    let greeted = false;
    let healthyTimer = null;
    const connectTimer = setTimeout(() => lost(1006, 'connect timed out'), CONNECT_TIMEOUT_MS);
    drop = () => lost(1006, 'no frames from the server');

    /** The connection has proved itself (a ping, or a while): the backoff starts over. */
    const healthy = () => {
      clearTimeout(healthyTimer);
      attempts = 0;
      failingSince = Infinity;
    };

    /** The connection is over (once): stop, or reconnect as its close code says. */
    function lost(code, reason) {
      if (down) return;
      down = true;
      clearTimeout(connectTimer);
      clearTimeout(healthyTimer);
      if (ws === socket) ws = drop = null;
      try {
        socket.close();
      } catch {}
      if (done) return;
      if (failingSince === Infinity) failingSince = Date.now();
      if (FINAL_CODES[code]) return stopFor(FINAL_CODES[code], code, reason);
      // Access changed: work it out again soon (spread out: every socket of the key closes at once).
      if (code === 4100 && greeted) return schedule(Math.random() * 2000);
      attempts++;
      if (!everConnected) {
        if (proxyVar) return stopFor('unreachable', code, `${proxyVar} is set, and Node's WebSocket doesn't use a proxy`);
        if (attempts === 1) void probe();
        if (attempts >= FIRST_TRIES || Date.now() - startedAt >= FIRST_GIVE_UP_MS) {
          return stopFor('unreachable', code, `never connected (${reason || 'connection failed'})`);
        }
      } else if (Date.now() - failingSince >= GIVE_UP_MS) {
        return stopFor('unreachable', code, reason || 'connection failed');
      }
      const wait = Math.min(BACKOFF_CAP_MS, BACKOFF_MS * 2 ** Math.min(attempts - 1, 10));
      schedule(wait / 2 + Math.random() * (wait / 2)); // jitter, so relays don't all come back at once
    }

    socket.addEventListener('open', () => {
      opened = true;
      lastFrameAt = Date.now();
    });
    socket.addEventListener('message', (e) => {
      if (down || typeof e.data !== 'string') return;
      lastFrameAt = Date.now();
      let frame;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        clearTimeout(connectTimer);
        greeted = everConnected = true;
        const pingMs = frame.pingSeconds > 0 ? frame.pingSeconds * 1000 : 0;
        silenceMs = pingMs ? pingMs * Math.max(frame.missedPings || 0, 2) + SILENCE_SLACK_MS : DEFAULT_SILENCE_MS;
        healthyTimer = setTimeout(healthy, HEALTHY_MS);
        send({ type: 'armed', armed }); // on every (re)connect: the server counts a new connection as armed
      } else if (frame.type === 'ping') {
        if (greeted) healthy();
      } else if (frame.type === 'items' && Array.isArray(frame.items)) {
        const fresh = frame.items.filter((item) => {
          const k = dedupeKey(item);
          if (k === null) return true;
          if (written.has(k)) return false;
          remember(k);
          return true;
        });
        append(fresh);
        // Only once its items are on disk: reconnecting from here loses nothing.
        if (typeof frame.checkedAt === 'string') writeAtomic(file('since'), frame.checkedAt);
      }
    });
    socket.addEventListener('close', (e) => lost(e.code, e.reason));
    // Node's client may report a failed handshake with an error and no close.
    socket.addEventListener('error', () => {
      if (!opened) lost(1006, 'connection failed');
      else setTimeout(() => lost(1006, 'connection error'), 1000);
    });
  }

  function schedule(ms) {
    if (!done && !retry) retry = setTimeout(connect, ms);
  }

  /**
   * After a first failure, before any connection worked: a plain GET of the socket's path is 426 on a server with
   * the socket, and a JSON 404 on a LaneSignal without one. Not reaching the server at all means the network is in
   * the way.
   */
  async function probe() {
    let res;
    try {
      res = await fetch(url.replace(/^ws/, 'http'), { headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      if (!everConnected && err?.name !== 'TimeoutError') stopFor('unreachable', null, `can't reach the server (${err?.cause?.code || err?.message})`);
      return;
    }
    if (res.status !== 404 || !(res.headers.get('content-type') ?? '').includes('application/json')) return;
    const body = await res.json().catch(() => null);
    if (body && typeof body.error === 'string' && !everConnected) stopFor('unreachable', null, 'this server has no agent socket');
  }

  function send(frame) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  checks = setInterval(() => {
    // Another serve took the state folder over (this one stalled): it's theirs now.
    if (!beat(pidFile)) {
      console.error('relay: another relay took this session over; exiting');
      return exit(0, { release: false });
    }
    if (parent && !alive(parent)) {
      console.error('relay: the agent is gone; exiting');
      return exit(0);
    }
    const now = Date.now();
    // Armed while a follower (Monitor's command) is running.
    const following = live(file('follower.pid'), STALE_FOLLOWER_MS);
    if (following !== armed) {
      armed = following;
      unarmedSince = armed ? null : now;
      send({ type: 'armed', armed });
    }
    if (!armed && now - unarmedSince >= idleMs) {
      console.error('relay: nothing has followed it for a while; exiting');
      return exit(0);
    }
    // Nothing from the server for longer than its pings allow: it, or the way to it, is gone.
    if (ws?.readyState === WebSocket.OPEN && now - lastFrameAt > silenceMs) drop?.();
  }, CHECK_MS);

  connect();
}

// ---- follow ----

function follow(opts) {
  const session = opts.session?.trim() || usage('follow needs --session');
  const dir = stateDir(env('LANESIGNAL_GROUP'), session);
  const file = (name) => path.join(dir, name);
  const pidFile = file('follower.pid');
  const eventsFile = file('events.jsonl');
  // The newest follower wins: an older one sees another token here and exits.
  writeAtomic(pidFile, pidText());

  let offset = Number.parseInt(readText(file('offset')), 10) || 0;
  let busy = false;
  let again = false;
  let stopping = false;
  let relaySeenAt = Date.now();
  let watcher = null;

  const exit = (code = 0) => {
    releasePid(pidFile);
    process.exit(code);
  };
  const failed = (err) => {
    console.error(`relay: follow failed: ${err?.stack || err}`);
    exit(1);
  };
  process.on('uncaughtException', failed);
  process.on('unhandledRejection', failed);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => exit(0));
  // Monitor went away: nothing reads us any more.
  process.stdout.on('error', () => exit(0));

  const write = (line) => new Promise((resolve, reject) => process.stdout.write(`${line}\n`, (err) => (err ? reject(err) : resolve())));
  const typeOf = (line) => {
    try {
      return JSON.parse(line).type;
    } catch {
      return undefined;
    }
  };

  /** Prints every complete line after the offset, saving the offset after each one is written out. */
  async function drain() {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        let size;
        try {
          size = fs.statSync(eventsFile).size;
        } catch {
          continue; // not there yet
        }
        if (size < offset) offset = 0; // the file was replaced
        if (size === offset) continue;
        const buf = Buffer.alloc(size - offset);
        const fd = fs.openSync(eventsFile, 'r');
        let got = 0;
        try {
          while (got < buf.length) {
            const n = fs.readSync(fd, buf, got, buf.length - got, offset + got);
            if (!n) break;
            got += n;
          }
        } finally {
          fs.closeSync(fd);
        }
        // Only whole lines: a line still being appended waits for its newline.
        let start = 0;
        for (let nl = buf.indexOf(10, 0); nl !== -1 && nl < got; nl = buf.indexOf(10, start)) {
          const line = buf.subarray(start, nl).toString('utf8');
          const bytes = nl + 1 - start;
          start = nl + 1;
          if (!ours(pidFile)) exit(0);
          if (line.trim()) await write(line);
          offset += bytes;
          writeAtomic(file('offset'), String(offset));
          if (line.includes('"relay_stopped"') && typeOf(line) === 'relay_stopped') exit(0);
        }
      } while (again);
    } catch {
      exit(0); // stdout is gone
    } finally {
      busy = false;
    }
  }

  function watch() {
    if (watcher) return;
    try {
      watcher = fs.watch(dir, (_event, name) => {
        if (!name || name === 'events.jsonl') void drain();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null; // polling below still works
    }
  }

  watch();
  setInterval(() => {
    if (!beat(pidFile)) exit(0); // a newer follower took over
    watch();
    void drain();
  }, FOLLOW_BEAT_MS);
  setInterval(async () => {
    if (stopping) return;
    if (live(file('relay.pid'), STALE_RELAY_MS)) {
      relaySeenAt = Date.now();
      return;
    }
    if (Date.now() - relaySeenAt < FOLLOWER_GRACE_MS) return;
    stopping = true;
    // Anything serve wrote before it went comes first (its own last line, if any, ends this process there).
    while (busy) await new Promise((r) => setTimeout(r, 50));
    await drain();
    try {
      await write(JSON.stringify({ type: 'relay_stopped', code: null, reason: 'not_running', message: MESSAGES.not_running }));
    } catch {}
    exit(0);
  }, CHECK_MS);
  void drain();
}

// ---- main ----

const { command, opts } = args(process.argv.slice(2));
if (command === 'serve') serve(opts);
else if (command === 'follow') follow(opts);
else usage(command ? `unknown command: ${command}` : 'no command');
