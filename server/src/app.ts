import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { toNodeHandler } from 'better-auth/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { accessFor, pub, q, requirementInputFor, waitScopeFor, type Access } from './access.ts';
import { CLIENT_IP_HEADER, type Accounts } from './accounts.ts';
import { createAuth, principalOf, stillValidOf, watchRevocationOf } from './auth.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { mcpHandler } from './mcp.ts';
import * as s from './schemas.ts';
import { datasetCsvAsync, datasetRowsAsync, exportZip } from './export.ts';
import {
  ConflictError,
  EXPORT_DATASETS,
  ForbiddenError,
  localId,
  NotFoundError,
  ValidationError,
  type ExportDataset,
  type RecordResult,
  type Store,
} from './store.ts';
import {
  LANE_STATUSES,
  type EscalationState,
  type ProjectAccess,
  type ProjectMember,
  type PublicConfig,
  type Requirement,
  type StreamEvent,
} from './types.ts';

export interface AppOptions {
  config: Config;
  store: Store;
  accounts: Accounts;
  push: { fcm: boolean; ntfy: boolean };
  /** Directory of the compiled web frontend; served when present. */
  webDir?: string;
  /** The Claude Code skill (SKILL.md) served at /api/skill, when present. */
  skillFile?: string;
}

const parse = <T>(schema: ZodType<T>, value: unknown): T => schema.parse(value);

// Express 5 forwards rejected promises to the error handler, but keep handlers sync where possible.
type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function createApp({ config, store, accounts, push, webDir, skillFile }: AppOptions) {
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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

  // The agent skill: public (no secrets in it), so installing is one curl.
  app.get('/api/skill', (_req, res) => {
    if (!skillFile || !existsSync(skillFile)) {
      res.status(404).json({ error: 'skill not bundled with this server' });
      return;
    }
    // dotfiles: allow, so a configured path under a dot-directory (~/.config/...) still works.
    res.set('cache-control', 'no-cache').sendFile(skillFile, { dotfiles: 'allow', headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  });

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

  /** What the caller may see across projects; worked out once per request. */
  const acc = (res: Response): Access => (res.locals.access ??= accessFor(store, principalOf(res)));
  const projectQuery = (req: Request) => (typeof req.query.project === 'string' ? req.query.project : undefined);
  /** Fires when project memberships change, so open event streams reconnect with what they may now see. */
  const membershipChanges = new EventEmitter<{ changed: [] }>();
  membershipChanges.setMaxListeners(0);
  const pubRecord = (r: RecordResult) => ({
    ...r,
    requirement: pub.requirement(r.requirement),
    similar: r.similar.map(pub.requirement),
  });

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

  /** Everything a client needs on (re)connect, across the caller's projects (or `?project=`). */
  app.get('/api/snapshot', any, (req, res) => {
    const projects = acc(res).scope(projectQuery(req));
    res.json({
      projects: projectList(res),
      groups: store.listGroups(projects).map(pub.group),
      lanes: store.listLanes(projects).map(pub.lane),
      escalations: store.listEscalations({ projects }).map(pub.escalation),
      serverTime: new Date().toISOString(),
    });
  });

  // ---- projects ----

  /** Projects the caller can see, with their role and notification choice in each. */
  const projectList = (res: Response): ProjectAccess[] => {
    const a = acc(res);
    const p = principalOf(res);
    const mine = p.userId ? store.membershipsOf(p.userId) : new Map();
    return store
      .listProjects()
      .filter((pr) => a.projects.includes(pr.id))
      .map((pr) => ({
        ...pr,
        role: a.roleIn(pr.id) ?? 'member',
        notify: mine.get(pr.id)?.notify ?? (!p.userId || !!p.superuser),
      }));
  };

  app.get('/api/projects', any, (_req, res) => {
    res.json(projectList(res));
  });

  /** Instance admins create projects; the creator becomes the project's admin. */
  app.post('/api/projects', human, (req, res) => {
    const p = principalOf(res);
    if (!p.superuser && !(p.admin && !p.userId)) throw new ForbiddenError('Only instance admins create projects');
    const project = store.createProject(parse(s.projectInput, req.body), p.userId ?? null);
    membershipChanges.emit('changed');
    res.status(201).json(project);
  });

  const requireProjectAdmin = (res: Response, id: string) => {
    const project = acc(res).pick(id);
    if (!acc(res).isAdmin(project)) throw new ForbiddenError('Only project admins manage this project');
    return project;
  };

  app.patch('/api/projects/:id', human, (req, res) => {
    const project = requireProjectAdmin(res, String(req.params.id));
    const updated = store.updateProject(project, parse(s.projectPatch, req.body));
    // Keys appear in codes on every client: have them reload.
    membershipChanges.emit('changed');
    res.json(updated);
  });

  app.get('/api/projects/:id/members', human, (req, res) => {
    const project = acc(res).pick(String(req.params.id));
    const users = new Map(accounts.listUsers().map((u) => [u.id, u]));
    const members: ProjectMember[] = store
      .projectMembers(project)
      .filter((m) => users.has(m.userId))
      .map((m) => ({ ...m, name: users.get(m.userId)!.name, email: users.get(m.userId)!.email }));
    res.json(members);
  });

  app.put('/api/projects/:id/members/:userId', human, (req, res) => {
    const project = requireProjectAdmin(res, String(req.params.id));
    const userId = String(req.params.userId);
    if (!accounts.listUsers().some((u) => u.id === userId)) throw new NotFoundError('No such person');
    store.setMember(project, userId, parse(s.memberInput, req.body).role);
    membershipChanges.emit('changed');
    res.sendStatus(204);
  });

  app.delete('/api/projects/:id/members/:userId', human, (req, res) => {
    const project = requireProjectAdmin(res, String(req.params.id));
    store.removeMember(project, String(req.params.userId));
    membershipChanges.emit('changed');
    res.sendStatus(204);
  });

  /** Each person turns push on or off per project, for their own phones. */
  app.put('/api/projects/:id/notifications', human, (req, res) => {
    const p = principalOf(res);
    if (!p.userId) throw new ValidationError('Config tokens have no notification settings');
    store.setNotify(acc(res).pick(String(req.params.id)), p.userId, parse(s.notifyInput, req.body).enabled);
    res.sendStatus(204);
  });

  /** People, for project admins choosing members. */
  app.get('/api/people', human, (_req, res) => {
    const a = acc(res);
    if (!a.projects.some((pr) => a.isAdmin(pr))) throw new ForbiddenError('Only project admins list people');
    res.json(accounts.listUsers().map((u) => ({ id: u.id, name: u.name, email: u.email })));
  });

  // ---- groups (epic / train / overseer) ----

  app.get('/api/groups', any, (req, res) => {
    res.json(store.listGroups(acc(res).scope(projectQuery(req))).map(pub.group));
  });

  app.put('/api/groups/:id', agent, (req, res) => {
    const project = acc(res).pick(projectQuery(req));
    const id = parse(s.groupId, req.params.id);
    res.json(pub.group(store.upsertGroup(q(project, id), parse(s.groupPatch, req.body), principalOf(res).name)));
  });

  app.delete('/api/groups/:id', human, (req, res) => {
    const project = acc(res).pick(projectQuery(req));
    store.deleteGroup(q(project, String(req.params.id)), principalOf(res).name);
    res.sendStatus(204);
  });

  // ---- lanes ----

  /** A lane patch from a client, with its group qualified to the lane's project. */
  const lanePatchOf = (project: string, body: unknown) => {
    const patch = parse(s.lanePatch, body);
    return { ...patch, group: patch.group ? q(project, patch.group) : patch.group };
  };

  app.get('/api/lanes', any, (req, res) => {
    res.json(store.listLanes(acc(res).scope(projectQuery(req))).map(pub.lane));
  });

  app.get('/api/lanes/:id', any, (req, res) => {
    const project = acc(res).pick(projectQuery(req));
    const lane = store.getLane(q(project, String(req.params.id)));
    if (!lane) throw new NotFoundError('Lane not found');
    res.json({
      lane: pub.lane(lane),
      escalations: store
        .listEscalations({ laneId: lane.id, states: ['open', 'decided', 'acknowledged', 'withdrawn'], limit: 50 })
        .map(pub.escalation),
      events: store.laneEvents(lane.id, 100).map((e) => ({ ...e, laneId: localId(e.laneId) })),
    });
  });

  app.put('/api/lanes/:id', agent, (req, res) => {
    const project = acc(res).pick(projectQuery(req));
    const id = parse(s.laneId, req.params.id);
    res.json(pub.lane(store.upsertLane(q(project, id), lanePatchOf(project, req.body), principalOf(res).name)));
  });

  // Humans remove lanes from the dashboard; overseers remove lanes whose work is over.
  app.delete('/api/lanes/:id', any, (req, res) => {
    const project = acc(res).pick(projectQuery(req));
    store.deleteLane(q(project, String(req.params.id)), principalOf(res).name);
    res.sendStatus(204);
  });

  // ---- escalations ----

  app.get('/api/escalations', any, (req, res) => {
    const states =
      typeof req.query.state === 'string' ? (req.query.state.split(',') as EscalationState[]) : undefined;
    const lane = typeof req.query.lane === 'string' ? req.query.lane : undefined;
    const a = acc(res);
    res.json(
      store
        .listEscalations({
          states,
          laneId: lane ? q(a.pick(projectQuery(req)), lane) : undefined,
          projects: a.scope(projectQuery(req)),
        })
        .map(pub.escalation),
    );
  });

  /** 201 when created; 200 with `duplicate: true` when the same open question already exists (a retry). */
  app.post('/api/escalations', agent, (req, res) => {
    const project = acc(res).pick(projectQuery(req));
    const input = parse(s.escalationInput, req.body);
    const escalation = store.createEscalation({ ...input, laneId: q(project, input.laneId) }, principalOf(res).name);
    res.status(escalation.duplicate ? 200 : 201).json(pub.escalation(escalation));
  });

  /**
   * Waits on a group, lanes and/or escalations until something needs the agent
   * (see Store.waitForDecisions). Up to 24 hours: once it has to wait, it sends
   * the 200 at once and a space every 20s, so proxies see a live response and
   * the JSON body (leading whitespace is valid JSON) follows when it's ready.
   */
  app.get(
    '/api/wait',
    any,
    h(async (req, res) => {
      const query = parse(s.waitQuery, req.query);
      const scope = waitScopeFor(
        acc(res),
        parse(s.waitScope, { ids: query.ids, laneIds: query.lane, groupId: query.group, since: query.since }),
        query.project,
      );
      const now = store.decisionsFor(scope);
      const timeout = query.timeout ?? 300;
      if (now.ready || timeout === 0) {
        res.json(pub.wait(now));
        return;
      }
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      let revoked = false;
      const unwatch = watchRevocationOf(res)(() => {
        revoked = true;
        abort.abort();
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.write(' ');
      const stillValid = stillValidOf(res);
      const keepalive = setInterval(() => {
        res.write(' ');
        void stillValid().then((ok) => ok || ((revoked = true), abort.abort()));
      }, 20_000);
      try {
        const result = await store.waitForDecisions(scope, timeout * 1000, abort.signal);
        res.end(JSON.stringify(revoked ? { error: 'unauthorized', ready: false } : pub.wait(result)));
      } catch (err) {
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error', ready: false }));
      } finally {
        clearInterval(keepalive);
        unwatch();
      }
    }),
  );

  /** `?wait=N` long-polls up to N seconds (max 300) for the escalation to leave `open`. */
  app.get(
    '/api/escalations/:id',
    any,
    h(async (req, res) => {
      const target = acc(res).escalation(String(req.params.id), projectQuery(req));
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
        escalation = await store.waitForDecision(target.id, wait * 1000, abort.signal);
      } finally {
        unwatch();
      }
      if (revoked || (wait > 0 && !(await stillValidOf(res)()))) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.json(pub.escalation(escalation));
    }),
  );

  const escalationOf = (req: Request, res: Response) => acc(res).escalation(String(req.params.id), projectQuery(req)).id;

  /** Agents record agreement/disagreement with the recommendation. */
  app.post('/api/escalations/:id/positions', agent, (req, res) => {
    const body = parse(s.position, req.body);
    res.json(
      pub.escalation(
        store.addPosition(escalationOf(req, res), { ...body, agent: body.agent ?? principalOf(res).name }, principalOf(res).name),
      ),
    );
  });

  app.post('/api/escalations/:id/decide', human, (req, res) => {
    const body = parse(s.decision, req.body);
    res.json(
      pub.escalation(
        store.decideEscalation(escalationOf(req, res), body.decision, body.note ?? null, principalOf(res).name, body.change ?? false),
      ),
    );
  });

  /** Repeating an acknowledgement returns the same result. `status`/`activity` publish the lane's next state. */
  app.post('/api/escalations/:id/ack', agent, (req, res) => {
    const body = parse(s.acknowledgement, req.body ?? {});
    res.json(
      pub.escalation(
        store.acknowledgeEscalation(escalationOf(req, res), body.note ?? null, principalOf(res).name, {
          status: body.status,
          activity: body.activity,
        }),
      ),
    );
  });

  // Agents withdraw (answered elsewhere / moot); humans may dismiss stale ones.
  app.post('/api/escalations/:id/withdraw', any, (req, res) => {
    const body = parse(s.resolution, req.body ?? {});
    res.json(pub.escalation(store.withdrawEscalation(escalationOf(req, res), body.note ?? null, principalOf(res).name)));
  });

  // ---- requirements (owner decisions about the product) ----

  app.get('/api/requirements', any, (req, res) => {
    const query = parse(s.requirementQuery, req.query);
    const a = acc(res);
    const projects = a.scope(query.project);
    const group = query.group ? q(a.pick(query.project), query.group) : undefined;
    res.json(
      store
        .findRequirements({ query: query.q, tags: query.tag, group, projects, statuses: query.status, limit: query.limit })
        .map(pub.requirement),
    );
  });

  app.get('/api/requirements/tags', any, (req, res) => {
    const a = acc(res);
    const group = typeof req.query.group === 'string' ? q(a.pick(projectQuery(req)), parse(s.groupId, req.query.group)) : undefined;
    res.json(store.requirementTags(group, a.scope(projectQuery(req))));
  });

  /** A requirement the caller may see: one for all projects, or one of the caller's projects. */
  const visibleRequirement = (res: Response, id: string) => {
    const found = store.getRequirement(id);
    if (!found || (found.project !== null && !acc(res).projects.includes(found.project))) {
      throw new NotFoundError('Requirement not found');
    }
    return found;
  };

  app.get('/api/requirements/:id', any, (req, res) => {
    res.json(pub.requirement(visibleRequirement(res, String(req.params.id))));
  });

  const requirementBody = (req: Request, res: Response, current?: Requirement) =>
    requirementInputFor(acc(res), parse(s.requirementInput, req.body), projectQuery(req), current);

  app.post('/api/requirements', any, (req, res) => {
    const result = store.recordRequirement(requirementBody(req, res), principalOf(res).name, principalOf(res).role === 'human');
    res.status(201).json(pubRecord(result));
  });

  app.post('/api/requirements/:id/supersede', any, (req, res) => {
    const current = visibleRequirement(res, String(req.params.id));
    const result = store.supersedeRequirement(
      current.id,
      requirementBody(req, res, current),
      principalOf(res).name,
      principalOf(res).role === 'human',
    );
    res.status(201).json(pubRecord(result));
  });

  app.patch('/api/requirements/:id', human, (req, res) => {
    const current = visibleRequirement(res, String(req.params.id));
    res.json(pub.requirement(store.editRequirement(current.id, parse(s.requirementEdit, req.body))));
  });

  app.post('/api/requirements/:id/retire', human, (req, res) => {
    const current = visibleRequirement(res, String(req.params.id));
    res.json(pub.requirement(store.retireRequirement(current.id)));
  });

  // ---- export (CSV / JSON / zip for analysis) ----

  const exportFilterOf = (req: Request, res: Response) => {
    const query = parse(s.exportFilter, req.query);
    const a = acc(res);
    return {
      from: query.from,
      to: query.to,
      laneId: query.lane ? q(a.pick(query.project), query.lane) : undefined,
      projects: a.scope(query.project),
    };
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
    const body = await exportZip(store, exportFilterOf(req, res), new Date());
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
    const filter = exportFilterOf(req, res);
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
    store.addPushToken(body.token, body.platform, principalOf(res).name, principalOf(res).userId ?? null);
    res.sendStatus(204);
  });

  app.post('/api/push/unregister', human, (req, res) => {
    const body = parse(s.pushRegistration.pick({ token: true }), req.body);
    store.removePushToken(body.token);
    res.sendStatus(204);
  });

  // ---- real-time stream (SSE) ----

  /** Events for the caller's projects (or `?project=`), as the client knows the ids. */
  app.get('/api/events', any, (req, res) => {
    const projects = acc(res).scope(projectQuery(req));
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = (e: StreamEvent) => {
      const visible = pub.event(e, projects);
      if (visible) res.write(`event: ${visible.type}\ndata: ${JSON.stringify(visible)}\n\n`);
    };
    // Close the stream as soon as its credential stops being valid: checked on every heartbeat
    // and immediately whenever sessions or keys are revoked (or memberships change, so the
    // client reconnects with what it may now see).
    const stillValid = stillValidOf(res);
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
      void stillValid().then((ok) => ok || res.end());
    }, 25_000);
    store.events.on('change', send);
    const unwatch = watchRevocationOf(res)(() => res.end());
    const onMembership = () => res.end();
    membershipChanges.on('changed', onMembership);
    req.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('change', send);
      membershipChanges.off('changed', onMembership);
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
    } else if (err instanceof ForbiddenError) {
      res.status(403).json({ error: err.message });
    } else if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
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
