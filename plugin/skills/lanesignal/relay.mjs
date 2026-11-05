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
// following it), LANESIGNAL_RELAY_DIR (where state folders go, default .claude/lanesignal).
//
// State, in <dir>/<group>/<first 16 hex of sha256(session)>/: events.jsonl (each item as one line), offset (how far
// follow has printed, in bytes), follower.pid, relay.pid and since (the last checkedAt, to reconnect from).
//
// Lines in events.jsonl are the socket's digest items as they come (each has a `kind`), and at most one last line
// {"type":"relay_stopped","code","reason","detail","message"} when serve stops for good. `reason` is one of:
//   taken_over    another overseer took the group over (4409): stop overseeing it
//   unauthorized  the key was refused or revoked (4401): tell the person
//   forbidden     not this group's overseer, or not an agent key (4403): tell the person
//   not_found     the group (or project) doesn't exist or was removed (4404)
//   bad_request   the server refused the query (4400): a relay bug or a bad LANESIGNAL_GROUP / --session
//   unreachable   it couldn't stay connected (or the server has no socket): fall back to the background wait
// follow also prints {"type":"relay_stopped","reason":"not_running"} (not written to the file) when serve isn't
// running: start it again.
//
// Liveness: the server sends a {"type":"ping"} frame every LANESIGNAL_AGENT_PING_SECONDS (20 by default), and says
// how often in hello's `pingSeconds`. The relay reconnects after two intervals (plus a little slack) without any
// frame. From a server that doesn't say, it learns the interval from the spacing of pings, and until it has seen two
// it allows 45 seconds.
//
// Delivery is at least once: every item received is appended, so after a reconnect something still pending may come
// again. Acknowledging goes through MCP, so a repeat is harmless.

import { createHash } from 'node:crypto';
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
  unreachable: "The relay can't stay connected: fall back to the background wait.",
  not_running: 'The relay (serve) is not running: start it again, then follow again.',
};
const CHECK_MS = 2000; // parent, follower and liveness checks
const DEFAULT_SILENCE_MS = 45_000; // before the ping interval is known
const BACKOFF_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const GIVE_UP_MS = Number(process.env.LANESIGNAL_RELAY_GIVE_UP_SECONDS || 600) * 1000; // 10 minutes of failures
const FOLLOWER_GRACE_MS = 15_000; // how long follow waits for serve to (re)appear before saying it's not running

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

/** The state folder for this group and session. */
function stateDir(group, session) {
  const root = process.env.LANESIGNAL_RELAY_DIR || path.join('.claude', 'lanesignal');
  const hash = createHash('sha256').update(session).digest('hex').slice(0, 16);
  const dir = path.resolve(root, group.replace(/[^A-Za-z0-9._-]/g, '_'), hash);
  fs.mkdirSync(dir, { recursive: true });
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

function readPid(file) {
  try {
    return Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
  } catch {
    return NaN;
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
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Removes a pid file if it still holds our pid. */
function releasePid(file) {
  if (readPid(file) === process.pid) fs.rmSync(file, { force: true });
}

// ---- serve ----

function serve(opts) {
  const session = opts.session?.trim() || usage('serve needs --session');
  const parent = Number.parseInt(opts.parent ?? '', 10);
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

  const dir = stateDir(group, session);
  const file = (name) => path.join(dir, name);

  // One serve per state folder: the pid file is created exclusively, and taken over only from a dead process.
  const pidFile = file('relay.pid');
  for (;;) {
    try {
      fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const other = readPid(pidFile);
      if (alive(other) && other !== process.pid) {
        console.error(`relay: already serving this session (pid ${other})`);
        process.exit(0);
      }
      fs.rmSync(pidFile, { force: true });
    }
  }

  const events = fs.openSync(file('events.jsonl'), 'a');
  let done = false;
  let checks = null; // the periodic checks' timer
  let ws = null;
  let drop = null; // ends the current connection as lost
  let retry = null; // the reconnect timer
  let attempts = 0; // failed connections in a row, for backoff
  let failingSince = Date.now(); // since when there's been no working connection (Infinity while connected)
  let lastFrameAt = 0;
  let lastPingAt = 0;
  let pingMs = 0; // the server's ping interval; 0 until known
  let statedPingMs = 0; // as hello stated it (pingSeconds)
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
    append([{ type: 'relay_stopped', code: code ?? null, reason, detail: detail || undefined, message: MESSAGES[reason] }]);
    console.error(`relay: stopped (${reason}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''})`);
    exit(1);
  }

  function exit(code = 0) {
    if (done) return;
    done = true;
    clearInterval(checks);
    clearTimeout(retry);
    try {
      ws?.close(1000, 'relay exiting');
    } catch {}
    releasePid(pidFile);
    process.exitCode = code;
    // Let the close frame go out, but don't wait on a dead server.
    setTimeout(() => process.exit(code), 200).unref();
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
    const connectTimer = setTimeout(() => lost(1006, 'connect timed out'), CONNECT_TIMEOUT_MS);
    drop = () => lost(1006, 'no frames from the server');

    /** The connection is over (once): stop, or reconnect as its close code says. */
    function lost(code, reason) {
      if (down) return;
      down = true;
      clearTimeout(connectTimer);
      if (ws === socket) ws = drop = null;
      try {
        socket.close();
      } catch {}
      if (done) return;
      if (failingSince === Infinity) failingSince = Date.now();
      if (FINAL_CODES[code]) return stopFor(FINAL_CODES[code], code, reason);
      if (code === 4100) return schedule(0); // access changed: work it out again at once
      if (!opened && attempts === 0) void probe();
      attempts++;
      if (Date.now() - failingSince >= GIVE_UP_MS) return stopFor('unreachable', code, reason || 'connection failed');
      const wait = Math.min(BACKOFF_CAP_MS, BACKOFF_MS * 2 ** Math.min(attempts - 1, 10));
      schedule(wait / 2 + Math.random() * (wait / 2)); // jitter, so relays don't all come back at once
    }

    socket.addEventListener('open', () => {
      opened = true;
      lastFrameAt = Date.now();
    });
    socket.addEventListener('message', (e) => {
      if (down || typeof e.data !== 'string') return;
      const now = Date.now();
      lastFrameAt = now;
      let frame;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        clearTimeout(connectTimer);
        attempts = 0;
        failingSince = Infinity;
        lastPingAt = 0;
        // The server says how often it pings; an older one doesn't, and then the spacing of its pings tells.
        statedPingMs = frame.pingSeconds > 0 ? frame.pingSeconds * 1000 : 0;
        if (statedPingMs) pingMs = statedPingMs;
        send({ type: 'armed', armed }); // on every (re)connect: the server counts a new connection as armed
      } else if (frame.type === 'ping') {
        if (lastPingAt && !statedPingMs) pingMs = now - lastPingAt;
        lastPingAt = now;
      } else if (frame.type === 'items' && Array.isArray(frame.items)) {
        // Every item as it comes: a repeat (after a reconnect, or the same words twice) is harmless, a lost one isn't.
        append(frame.items);
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

  /** After a first failure: a plain GET of the socket's path is 426 on a server with the socket, 404 without one. */
  async function probe() {
    try {
      const res = await fetch(url.replace(/^ws/, 'http'), { headers, signal: AbortSignal.timeout(10_000) });
      if (res.status === 404 && failingSince !== Infinity) stopFor('unreachable', null, 'this server has no agent socket');
    } catch {}
  }

  function send(frame) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  checks = setInterval(() => {
    if (!alive(parent)) {
      console.error('relay: the agent is gone; exiting');
      return exit(0);
    }
    const now = Date.now();
    // Armed while a follower (Monitor's command) is running.
    const following = alive(readPid(file('follower.pid')));
    if (following !== armed) {
      armed = following;
      unarmedSince = armed ? null : now;
      send({ type: 'armed', armed });
    }
    if (!armed && now - unarmedSince >= idleMs) {
      console.error('relay: nothing has followed it for a while; exiting');
      return exit(0);
    }
    // Two ping intervals (and some slack) without any frame: the server, or the way to it, is gone.
    const silence = pingMs ? 2 * pingMs + Math.max(1000, pingMs / 2) : DEFAULT_SILENCE_MS;
    if (ws?.readyState === WebSocket.OPEN && now - lastFrameAt > silence) drop?.();
  }, CHECK_MS);

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => exit(0));
  connect();
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

// ---- follow ----

function follow(opts) {
  const session = opts.session?.trim() || usage('follow needs --session');
  const dir = stateDir(env('LANESIGNAL_GROUP'), session);
  const file = (name) => path.join(dir, name);
  const pidFile = file('follower.pid');
  const eventsFile = file('events.jsonl');
  // The newest follower wins: an older one sees another pid here and exits.
  writeAtomic(pidFile, String(process.pid));

  let offset = Number.parseInt(readText(file('offset')), 10) || 0;
  let busy = false;
  let again = false;
  let relaySeenAt = Date.now();
  let watcher = null;

  const exit = (code = 0) => {
    releasePid(pidFile);
    process.exit(code);
  };
  const mine = () => readPid(pidFile) === process.pid;

  // Monitor went away: nothing reads us any more.
  process.stdout.on('error', () => exit(0));

  const write = (line) => new Promise((resolve, reject) => process.stdout.write(`${line}\n`, (err) => (err ? reject(err) : resolve())));

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
          if (!mine()) exit(0);
          if (line.trim()) await write(line);
          offset += bytes;
          writeAtomic(file('offset'), String(offset));
          if (line.includes('"relay_stopped"') && safeType(line) === 'relay_stopped') exit(0);
        }
      } while (again);
    } catch {
      exit(0); // stdout is gone
    } finally {
      busy = false;
    }
  }

  function safeType(line) {
    try {
      return JSON.parse(line).type;
    } catch {
      return undefined;
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
    if (!mine()) exit(0);
    watch();
    void drain();
  }, 1000);
  let stopping = false;
  setInterval(async () => {
    if (stopping) return;
    if (alive(readPid(file('relay.pid')))) {
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
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => exit(0));
  void drain();
}

// ---- main ----

const { command, opts } = args(process.argv.slice(2));
if (command === 'serve') serve(opts);
else if (command === 'follow') follow(opts);
else usage(command ? `unknown command: ${command}` : 'no command');
