import { existsSync } from 'node:fs';
import path from 'node:path';
import { toNodeHandler } from 'better-auth/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { CLIENT_IP_HEADER, type Accounts } from './accounts.ts';
import { createAuth, principalOf, stillValidOf, watchRevocationOf } from './auth.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { mcpHandler } from './mcp.ts';
import * as s from './schemas.ts';
import { datasetCsvAsync, datasetRowsAsync, exportZip } from './export.ts';
import { ConflictError, EXPORT_DATASETS, NotFoundError, type ExportDataset, type Store } from './store.ts';
import { LANE_STATUSES, type EscalationState, type PublicConfig, type StreamEvent } from './types.ts';

export interface AppOptions {
  config: Config;
  store: Store;
  accounts: Accounts;
  push: { fcm: boolean; ntfy: boolean };
  /** Directory of the compiled web frontend; served when present. */
  webDir?: string;
}

const parse = <T>(schema: ZodType<T>, value: unknown): T => schema.parse(value);

// Express 5 forwards rejected promises to the error handler, but keep handlers sync where possible.
type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function createApp({ config, store, accounts, push, webDir }: AppOptions) {
  const app = express();
  const auth = createAuth(config.tokens, accounts);
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Request log, skipping health checks and the long-lived event stream.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      log.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
        principal: res.locals.principal?.name,
      });
    });
    next();
  });

  // CORS for the Android app (Capacitor serves from https://localhost) and any configured origins.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-protocol-version');
      res.setHeader('Access-Control-Expose-Headers', 'set-auth-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Accounts, sessions and agent keys (Better Auth). Mounted before the JSON parser: it reads raw bodies.
  const authHandler = toNodeHandler(accounts.auth);
  app.all('/api/auth/{*splat}', (req, res) => {
    // Bearer only: ignore cookies Better Auth may have set, so a stale cookie can't stand in for the bearer.
    delete req.headers.cookie;
    // The rate limiter keys on this; derived from the socket or trusted proxies only, never the client.
    req.headers[CLIENT_IP_HEADER] = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    void authHandler(req, res);
  });

  app.use(express.json({ limit: '256kb' }));

  // First-run: with no accounts yet, anyone who can reach the server creates the admin account.
  app.get('/api/setup', (_req, res) => {
    res.json({ needsSetup: accounts.needsSetup() });
  });

  app.post(
    '/api/setup',
    h(async (req, res) => {
      // The setup code from the server log, or a static human token, proves control of the server.
      const header = req.headers.authorization;
      const caller = header?.startsWith('Bearer ') ? await auth.identify(header.slice(7).trim()) : null;
      const trusted = !!caller?.admin && !caller.userId;
      const user = await accounts.setup(parse(s.setupInput, req.body), trusted);
      if (!user) throw new ConflictError('Setup is already complete; sign in instead');
      res.status(201).json({ id: user.id, email: user.email, name: user.name });
    }),
  );

  app.get('/healthz', (_req, res) => {
    try {
      store.ping();
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: String(err) });
    }
  });

  const any = auth.require();
  const agent = auth.require('agent');
  const human = auth.require('human');

  // Break-glass people management for static human tokens (account admins use /api/auth/admin/*).
  const configAdmin = (_req: Request, res: Response, next: NextFunction) => {
    const p = principalOf(res);
    if (!p.admin || p.userId) {
      res.status(403).json({ error: 'requires a static human token from the server config' });
      return;
    }
    next();
  };

  app.post(
    '/api/admin/people',
    human,
    configAdmin,
    h(async (req, res) => {
      const user = await accounts.createPerson(parse(s.personInput, req.body));
      res.status(201).json({ id: user.id, email: user.email, name: user.name });
    }),
  );

  app.post(
    '/api/admin/people/password',
    human,
    configAdmin,
    h(async (req, res) => {
      const body = parse(s.passwordReset, req.body);
      if (!(await accounts.resetPassword(body.email, body.password))) throw new NotFoundError('No account with that email');
      res.sendStatus(204);
    }),
  );

  app.get('/api/me', any, (_req, res) => {
    res.json(principalOf(res));
  });

  app.get('/api/config', any, (_req, res) => {
    const body: PublicConfig = {
      name: config.name,
      groupLabel: config.groupLabel,
      statuses: LANE_STATUSES,
      ticketSystems: Object.keys(config.ticketTemplates),
      staleMinutes: config.staleMinutes,
      push,
    };
    res.json(body);
  });

  /** Everything a client needs on (re)connect. */
  app.get('/api/snapshot', any, (_req, res) => {
    res.json({
      groups: store.listGroups(),
      lanes: store.listLanes(),
      escalations: store.listEscalations(),
      serverTime: new Date().toISOString(),
    });
  });

  // ---- groups (epic / train / overseer) ----

  app.get('/api/groups', any, (_req, res) => {
    res.json(store.listGroups());
  });

  app.put('/api/groups/:id', agent, (req, res) => {
    const id = parse(s.groupId, req.params.id);
    res.json(store.upsertGroup(id, parse(s.groupPatch, req.body), principalOf(res).name));
  });

  app.delete('/api/groups/:id', human, (req, res) => {
    store.deleteGroup(String(req.params.id), principalOf(res).name);
    res.sendStatus(204);
  });

  // ---- lanes ----

  app.get('/api/lanes', any, (_req, res) => {
    res.json(store.listLanes());
  });

  app.get('/api/lanes/:id', any, (req, res) => {
    const lane = store.getLane(String(req.params.id));
    if (!lane) throw new NotFoundError('Lane not found');
    res.json({
      lane,
      escalations: store.listEscalations({
        laneId: lane.id,
        states: ['open', 'decided', 'acknowledged', 'withdrawn'],
        limit: 50,
      }),
      events: store.laneEvents(lane.id, 100),
    });
  });

  app.put('/api/lanes/:id', agent, (req, res) => {
    const id = parse(s.laneId, req.params.id);
    res.json(store.upsertLane(id, parse(s.lanePatch, req.body), principalOf(res).name));
  });

  app.delete('/api/lanes/:id', human, (req, res) => {
    store.deleteLane(String(req.params.id), principalOf(res).name);
    res.sendStatus(204);
  });

  // ---- escalations ----

  app.get('/api/escalations', any, (req, res) => {
    const states =
      typeof req.query.state === 'string' ? (req.query.state.split(',') as EscalationState[]) : undefined;
    const laneId = typeof req.query.lane === 'string' ? req.query.lane : undefined;
    res.json(store.listEscalations({ states, laneId }));
  });

  app.post('/api/escalations', agent, (req, res) => {
    res.status(201).json(store.createEscalation(parse(s.escalationInput, req.body), principalOf(res).name));
  });

  /** `?wait=N` long-polls up to N seconds (max 300) for the escalation to leave `open`. */
  app.get(
    '/api/escalations/:id',
    any,
    h(async (req, res) => {
      const wait = Math.min(Math.max(Number(req.query.wait ?? 0) || 0, 0), 300);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      // A revoked credential ends the wait at once instead of after `wait` seconds.
      let revoked = false;
      const unwatch = watchRevocationOf(res)(() => {
        revoked = true;
        abort.abort();
      });
      let escalation;
      try {
        escalation = await store.waitForDecision(String(req.params.id), wait * 1000, abort.signal);
      } finally {
        unwatch();
      }
      if (revoked || (wait > 0 && !(await stillValidOf(res)()))) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.json(escalation);
    }),
  );

  /** Agents record agreement/disagreement with the recommendation. */
  app.post('/api/escalations/:id/positions', agent, (req, res) => {
    const body = parse(s.position, req.body);
    res.json(
      store.addPosition(String(req.params.id), { ...body, agent: body.agent ?? principalOf(res).name }, principalOf(res).name),
    );
  });

  app.post('/api/escalations/:id/decide', human, (req, res) => {
    const body = parse(s.decision, req.body);
    res.json(store.decideEscalation(String(req.params.id), body.decision, body.note ?? null, principalOf(res).name));
  });

  app.post('/api/escalations/:id/ack', agent, (req, res) => {
    const body = parse(s.resolution, req.body ?? {});
    res.json(store.acknowledgeEscalation(String(req.params.id), body.note ?? null, principalOf(res).name));
  });

  // Agents withdraw (answered elsewhere / moot); humans may dismiss stale ones.
  app.post('/api/escalations/:id/withdraw', any, (req, res) => {
    const body = parse(s.resolution, req.body ?? {});
    res.json(store.withdrawEscalation(String(req.params.id), body.note ?? null, principalOf(res).name));
  });

  // ---- export (CSV / JSON / zip for analysis) ----

  const exportFilterOf = (req: Request) => {
    const q = parse(s.exportFilter, req.query);
    return { from: q.from, to: q.to, laneId: q.lane };
  };
  const stamp = () => new Date().toISOString().slice(0, 10);
  // Building an export reads everything; one at a time keeps the server responsive.
  let exporting = false;
  const oneAtATime = (_req: Request, res: Response, next: NextFunction) => {
    if (exporting) {
      res.status(429).set('retry-after', '5').json({ error: 'An export is already running; try again shortly' });
      return;
    }
    exporting = true;
    res.on('close', () => (exporting = false));
    next();
  };

  app.get('/api/export', any, oneAtATime, h(async (req, res) => {
    const body = await exportZip(store, exportFilterOf(req), new Date());
    res
      .set({
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="lanesignal-export-${stamp()}.zip"`,
        'cache-control': 'no-store',
      })
      .send(body);
  }));

  app.get('/api/export/:file', any, oneAtATime, h(async (req, res) => {
    const match = /^([a-z]+)\.(csv|json)$/.exec(String(req.params.file));
    const dataset = match?.[1] as ExportDataset | undefined;
    if (!match || !dataset || !EXPORT_DATASETS.includes(dataset)) {
      throw new NotFoundError(`Unknown export; use one of ${EXPORT_DATASETS.map((d) => `${d}.csv`).join(', ')} (or .json)`);
    }
    const filter = exportFilterOf(req);
    res.set('cache-control', 'no-store');
    if (match[2] === 'json') {
      res.json(await datasetRowsAsync(store, dataset, filter));
      return;
    }
    res
      .set({
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="lanesignal-${dataset}-${stamp()}.csv"`,
      })
      .send(await datasetCsvAsync(store, dataset, filter));
  }));

  // ---- push ----

  app.post('/api/push/register', human, (req, res) => {
    const body = parse(s.pushRegistration, req.body);
    store.addPushToken(body.token, body.platform, principalOf(res).name);
    res.sendStatus(204);
  });

  app.post('/api/push/unregister', human, (req, res) => {
    const body = parse(s.pushRegistration.pick({ token: true }), req.body);
    store.removePushToken(body.token);
    res.sendStatus(204);
  });

  // ---- real-time stream (SSE) ----

  app.get('/api/events', any, (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = (e: StreamEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    // Close the stream as soon as its credential stops being valid: checked on every heartbeat
    // and immediately whenever sessions or keys are revoked.
    const stillValid = stillValidOf(res);
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
      void stillValid().then((ok) => ok || res.end());
    }, 25_000);
    store.events.on('change', send);
    const unwatch = watchRevocationOf(res)(() => res.end());
    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('change', send);
      unwatch();
    });
  });

  // ---- MCP ----

  app.post('/mcp', any, mcpHandler(store));
  app.all('/mcp', (_req, res) => {
    res.status(405).set('allow', 'POST').json({ error: 'Stateless MCP endpoint: use POST' });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // ---- web frontend ----

  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('cache-control', 'no-cache');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'invalid request', issues: err.issues });
    } else if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof ConflictError) {
      res.status(409).json({ error: err.message });
    } else if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'invalid JSON' });
    } else if (
      typeof (err as { statusCode?: unknown })?.statusCode === 'number' &&
      (err as { statusCode: number }).statusCode < 500
    ) {
      // Better Auth APIError (e.g. password too long, wrong setup code)
      res.status((err as { statusCode: number }).statusCode).json({ error: (err as Error).message });
    } else if (typeof (err as { status?: unknown })?.status === 'number' && (err as { status: number }).status < 500) {
      // body-parser errors: payload too large, unsupported charset, ...
      res.status((err as { status: number }).status).json({ error: (err as Error).message });
    } else {
      log.error('unhandled error', { error: String(err), stack: (err as Error)?.stack });
      res.status(500).json({ error: 'internal error' });
    }
  });

  return app;
}
