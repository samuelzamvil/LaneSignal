import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { createAuth, principalOf } from './auth.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { mcpHandler } from './mcp.ts';
import * as s from './schemas.ts';
import { ConflictError, NotFoundError, type Store } from './store.ts';
import { LANE_STATUSES, type EscalationState, type PublicConfig, type StreamEvent } from './types.ts';

export interface AppOptions {
  config: Config;
  store: Store;
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

export function createApp({ config, store, push, webDir }: AppOptions) {
  const app = express();
  const auth = createAuth(config.tokens);
  if (config.trustProxy) app.set('trust proxy', true);
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '256kb' }));

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
    store.deleteGroup(String(req.params.id));
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
    store.deleteLane(String(req.params.id));
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
      res.json(await store.waitForDecision(String(req.params.id), wait * 1000, abort.signal));
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
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    store.events.on('change', send);
    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('change', send);
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
    } else {
      log.error('unhandled error', { error: String(err), stack: (err as Error)?.stack });
      res.status(500).json({ error: 'internal error' });
    }
  });

  return app;
}
