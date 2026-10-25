import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { toNodeHandler } from 'better-auth/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError, type ZodType } from 'zod';
import { accessFor, approvesRequirements, briefMessages, briefWait, digestWait, ownerOf, pub, q, requireRaiser, requirementInputFor, waitScopeFor, type Access } from './access.ts';
import { oversizedImage, readUpload, sniff } from './attachments.ts';
import { CLIENT_IP_HEADER, type Accounts } from './accounts.ts';
import { createAuth, principalOf, stillValidOf, watchRevocationOf } from './auth.ts';
import type { Config } from './config.ts';
import { log } from './log.ts';
import { mcpHandler } from './mcp.ts';
import { buildPayload, checkWebhookUrl, maskWebhookUrl, pluginZip, type TrmnlPusher } from './trmnl.ts';
import * as s from './schemas.ts';
import { datasetCsvAsync, datasetRowsAsync, exportZip } from './export.ts';
import {
  ConflictError,
  EXPORT_DATASETS,
  ForbiddenError,
  localId,
  NotFoundError,
  projectOf,
  ValidationError,
  type ExportDataset,
  type RecordResult,
  type Store,
  type WaitResult,
} from './store.ts';
import {
  LANE_STATUSES,
  type EscalationState,
  type ProjectAccess,
  type ProjectMember,
  type PublicConfig,
  type Requirement,
  type StreamEvent,
  type TrmnlView,
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
  /** Pushes projects' TRMNL screens; without it, setups can be saved but nothing is sent. */
  trmnl?: TrmnlPusher;
  /** The TRMNL plugin's files (integrations/trmnl), zipped for download. */
  trmnlDir?: string;
}

const parse = <T>(schema: ZodType<T>, value: unknown): T => schema.parse(value);

// Express 5 forwards rejected promises to the error handler, but keep handlers sync where possible.
type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function createApp({ config, store, accounts, push, webDir, skillFile, trmnl, trmnlDir }: AppOptions) {
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
  /**
   * The skill, as this server is configured: the core, then how answers arrive (decisions.md when
   * people answer in LaneSignal, alerts.md when they answer in the agent's session), then the
   * requirements section when that's on. The parts sit next to SKILL.md.
   */
  app.get('/api/skill', (_req, res) => {
    if (!skillFile || !existsSync(skillFile)) {
      res.status(404).json({ error: 'skill not bundled with this server' });
      return;
    }
    const part = (name: string) => {
      const file = path.join(path.dirname(skillFile), name);
      return existsSync(file) ? `\n${readFileSync(file, 'utf8')}` : '';
    };
    const text =
      readFileSync(skillFile, 'utf8') +
      part(config.decisions ? 'decisions.md' : 'alerts.md') +
      (config.requirements ? part('requirements.md') : '');
    res.set({ 'cache-control': 'no-cache', 'content-type': 'text/markdown; charset=utf-8' }).send(text);
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
  /** Routes for answering in LaneSignal, on unless LANESIGNAL_DECISIONS=false. */
  const decisionsOnly = (_req: Request, _res: Response, next: NextFunction) => {
    if (config.decisions) return next();
    throw new NotFoundError(
      "Answering in LaneSignal is off on this server (LANESIGNAL_DECISIONS): people answer in the agent's session, and the agent dismisses the alert",
    );
  };
  const requirementsOnly = (_req: Request, _res: Response, next: NextFunction) => {
    if (config.requirements) return next();
    throw new NotFoundError('Requirements are off on this server (LANESIGNAL_REQUIREMENTS)');
  };
  const membershipChanges = new EventEmitter<{ changed: [] }>();
  membershipChanges.setMaxListeners(0);
  // On a one-project server a new person joins it, so they don't sign in to an empty dashboard.
  // With several projects, an admin chooses (Settings → Projects).
  // Account admins see every project anyway, so they aren't made members (which would outlast a demotion).
  accounts.people.on('added', (userId, admin) => {
    const projects = store.listProjects();
    if (projects.length === 1 && !admin) store.setMember(projects[0].id, userId, 'member');
  });
  /** Similar requirements are only those the caller may see. */
  const pubRecord = (a: Access, r: RecordResult) => ({
    ...r,
    requirement: pub.requirement(r.requirement),
    similar: r.similar.filter(a.sees).map(pub.requirement),
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
      decisions: config.decisions,
      requirements: config.requirements,
      quietAlerts: store.quietAlerts(),
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
        notify: mine.get(pr.id)?.notify ?? (p.userId ? (store.notifyChoice(pr.id, p.userId) ?? !!p.superuser) : true),
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
    // Instance admins see every project without being members: list them too, so members know who to ask.
    for (const u of users.values()) {
      if (u.admin && !u.banned && !members.some((m) => m.userId === u.id)) {
        const notify = store.notifyChoice(project, u.id) ?? true;
        members.push({ userId: u.id, name: u.name, email: u.email, role: 'admin', notify, instanceAdmin: true });
      }
    }
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

  // ---- TRMNL screen (one per project, managed by its admins) ----

  const trmnlView = (project: string): TrmnlView => {
    const t = store.trmnlSetup(project);
    if (!t) return { configured: false };
    return {
      configured: true,
      webhookUrl: maskWebhookUrl(t.webhookUrl),
      enabled: t.enabled,
      includeNotifications: t.includeNotifications,
      plus: t.plus,
      lastPushAt: t.lastPushAt,
      lastError: t.lastError,
      lastErrorAt: t.lastErrorAt,
      updatedAt: t.updatedAt,
    };
  };

  app.get('/api/projects/:id/trmnl', human, (req, res) => {
    res.json(trmnlView(requireProjectAdmin(res, String(req.params.id))));
  });

  app.put('/api/projects/:id/trmnl', human, (req, res) => {
    const project = requireProjectAdmin(res, String(req.params.id));
    const input = parse(s.trmnlInput, req.body);
    const webhookUrl = input.webhookUrl === undefined ? undefined : checkWebhookUrl(input.webhookUrl, config.trmnlHosts);
    const before = store.trmnlSetup(project)?.webhookUrl;
    const saved = store.saveTrmnlSetup(project, { ...input, webhookUrl });
    trmnl?.reset(project, saved.webhookUrl !== before);
    res.json(trmnlView(project));
  });

  app.delete('/api/projects/:id/trmnl', human, (req, res) => {
    store.deleteTrmnlSetup(requireProjectAdmin(res, String(req.params.id)));
    res.sendStatus(204);
  });

  /** Pushes the screen now, and says how TRMNL answered. */
  app.post('/api/projects/:id/trmnl/send', human, h(async (req, res) => {
    const project = requireProjectAdmin(res, String(req.params.id));
    if (!store.trmnlSetup(project)) throw new NotFoundError('This project has no TRMNL screen set up');
    if (!trmnl) throw new ConflictError('This server does not push to TRMNL');
    const result = await trmnl.sendNow(project);
    res.json({ ...result, setup: trmnlView(project) });
  }));

  /** The data the screen gets (what the next push sends). */
  app.get('/api/projects/:id/trmnl/preview', human, (req, res) => {
    const project = requireProjectAdmin(res, String(req.params.id));
    const setup = store.trmnlSetup(project);
    if (!setup) throw new NotFoundError('This project has no TRMNL screen set up');
    res.json({ merge_variables: buildPayload(store, setup, new Date()) });
  });

  /** The private plugin to import into TRMNL, named after the project. */
  app.get('/api/projects/:id/trmnl/plugin.zip', human, h(async (req, res) => {
    const project = requireProjectAdmin(res, String(req.params.id));
    if (!trmnlDir || !existsSync(path.join(trmnlDir, 'settings.yml'))) throw new NotFoundError('The TRMNL plugin files are not installed');
    const body = await pluginZip(trmnlDir, store.getProject(project)?.name ?? project, new Date());
    res
      .set({
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="lanesignal-trmnl-${project}.zip"`,
        'cache-control': 'no-store',
      })
      .send(body);
  }));

  /** Instance admins choose whether alerts arrive as high priority or as regular notifications. */
  app.put('/api/settings/push', human, (req, res) => {
    const p = principalOf(res);
    if (!p.superuser && !(p.admin && !p.userId)) throw new ForbiddenError('Only instance admins change push settings');
    store.setQuietAlerts(parse(s.pushSettings, req.body).quietAlerts);
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
    const id = parse(s.groupId, req.params.id);
    const project = acc(res).pick(projectQuery(req), { group: id });
    res.json(pub.group(store.upsertGroup(q(project, id), parse(s.groupPatch, req.body), principalOf(res).name)));
  });

  app.delete('/api/groups/:id', human, (req, res) => {
    const project = acc(res).pick(projectQuery(req), { group: String(req.params.id) });
    store.deleteGroup(q(project, String(req.params.id)), principalOf(res).name);
    res.sendStatus(204);
  });

  // ---- lanes ----

  /** A lane patch from a client, with its group qualified to the lane's project. */
  app.get('/api/lanes', any, (req, res) => {
    res.json(store.listLanes(acc(res).scope(projectQuery(req))).map(pub.lane));
  });

  app.get('/api/lanes/:id', any, (req, res) => {
    const project = acc(res).pick(projectQuery(req), { lane: String(req.params.id) });
    const lane = store.getLane(q(project, String(req.params.id)));
    if (!lane) throw new NotFoundError('Lane not found');
    res.json({
      lane: pub.lane(lane),
      // Every unresolved escalation, however many closed ones came after it, plus the latest 50 closed ones.
      escalations: [
        ...store.listEscalations({ laneId: lane.id }),
        ...store.listEscalations({ laneId: lane.id, states: ['acknowledged', 'withdrawn'], limit: 50 }),
      ]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(pub.escalation),
      events: store.laneEvents(lane.id, 100, false).map((e) => ({ ...e, laneId: localId(e.laneId) })),
      messages: store.laneMessages(lane.id),
    });
  });

  /** Publishes a lane (a different ticket parks the one it held) or, with `strict`, switches tickets (fill). */
  const publishLane = (req: Request, res: Response, strict: boolean) => {
    const id = parse(s.laneId, req.params.id);
    const group = typeof req.body?.group === 'string' ? req.body.group : undefined;
    const project = acc(res).pick(projectQuery(req), { lane: id, group });
    const { previous, reason, waitingOn, ...rest } = parse(s.laneFill, req.body ?? {});
    const patch = { ...rest, group: rest.group ? q(project, rest.group) : rest.group, ...(strict ? { ticket: rest.ticket ?? null } : {}) };
    // The dashboard's message bookkeeping is no use to the agent publishing.
    const { lastMessageId, lastAgentMessageId, unreadByAgent, ...lane } = pub.lane(
      store.upsertLane(q(project, id), patch, principalOf(res).name, { previous, reason, waitingOn, strict }),
    );
    // The owner's notes on the lane reach a working agent the next time it publishes.
    const unread = store.takeUnreadForAgent(q(project, id));
    res.json(unread.length ? { ...lane, ownerMessages: briefMessages(unread) } : lane);
  };
  app.put('/api/lanes/:id', agent, (req, res) => publishLane(req, res, false));
  app.put('/api/lanes/:id/fill', agent, (req, res) => publishLane(req, res, true));

  // Humans remove lanes from the dashboard; overseers remove lanes whose work is over.
  app.delete('/api/lanes/:id', any, (req, res) => {
    const project = acc(res).pick(projectQuery(req), { lane: String(req.params.id) });
    const release = parse(
      z.object({ previous: s.ticketRelease.optional(), reason: z.string().max(500).optional(), project: z.string().optional() }),
      req.query,
    );
    store.deleteLane(q(project, String(req.params.id)), principalOf(res).name, release);
    res.sendStatus(204);
  });

  // ---- tickets: held by lanes, parked, done ----

  app.get('/api/tickets', any, (req, res) => {
    const query = parse(s.ticketQuery, req.query);
    const projects = acc(res).scope(query.project);
    const tickets = query.group
      ? projects.flatMap((p) => store.listTickets({ projects: [p], groupId: q(p, query.group!), states: query.state }))
      : store.listTickets({ projects, states: query.state });
    res.json(tickets.map(pub.ticket));
  });

  /** One ticket by any form of its ref (URL-encode it), with its escalations, history and the lanes it passed through. */
  app.get('/api/tickets/:ref', any, (req, res) => {
    const ref = String(req.params.ref);
    const hits = acc(res)
      .scope(projectQuery(req))
      .flatMap((p) => store.getTicket(p, ref) ?? []);
    if (hits.length > 1) throw new ValidationError(`"${ref}" is a ticket in several projects: say which (?project=)`);
    const t = hits[0];
    if (!t) throw new NotFoundError(`Ticket "${ref}" not found`);
    res.json({
      ticket: pub.ticket(t),
      escalations: store.listEscalations({ ticketId: t.id, states: ['open', 'decided', 'acknowledged', 'withdrawn'], limit: 200 }).map(pub.escalation),
      events: store.ticketEvents(t.id, 200).map((e) => ({ ...e, laneId: localId(e.laneId) })),
      lanes: store.ticketLanes(t.id).map(localId),
    });
  });

  // ---- attachments: files on escalations (a plan to read, a UI preview) ----

  /** `curl -F file=@plan.md`: keeps the file until an escalation lists its id in `attachments`. */
  app.post(
    '/api/attachments',
    any,
    h(async (req, res) => {
      const p = principalOf(res);
      let file: Awaited<ReturnType<typeof readUpload>>;
      try {
        // Refuse before reading the body when there's no room for it anyway.
        store.checkUploadRoom(ownerOf(p));
        file = await readUpload(req, config.attachmentMaxBytes);
      } catch (err) {
        // Discard the rest of the upload, so the client gets the error instead of a stalled request.
        req.resume();
        throw err;
      }
      const type = sniff(file.data, file.name);
      if (!type) {
        throw new ValidationError('Attach Markdown (.md) or text (.txt) files, or PNG, JPEG, WebP or GIF images');
      }
      const tooBig = oversizedImage(file.data, type);
      if (tooBig) throw new ValidationError(tooBig);
      res.status(201).json(store.addAttachment({ ...file, type }, ownerOf(p), p.name));
    }),
  );

  /**
   * The file, for people and agents who can see its escalation (or its uploader, before it's
   * attached). Served so a browser can't run it: its own type, no sniffing, a sandbox.
   */
  app.get('/api/attachments/:id', any, (req, res) => {
    const file = store.getAttachment(String(req.params.id));
    const notFound = () => new NotFoundError(`Attachment ${req.params.id} not found`);
    if (!file) throw notFound();
    if (file.escalationId) acc(res).escalation(file.escalationId);
    else if (file.laneId) {
      if (!acc(res).projects.includes(projectOf(file.laneId))) throw notFound();
    } else if (file.owner !== ownerOf(principalOf(res))) throw notFound();
    res.set({
      'content-type': file.type.startsWith('text/') ? `${file.type}; charset=utf-8` : file.type,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'private, max-age=86400',
    });
    res.send(Buffer.from(file.data));
  });

  /**
   * A message in a lane's conversation. From the agent, a milestone with any files (a quiet push);
   * from a person, a note the agent gets the next time it publishes, writes on or waits on the lane.
   * The reply carries the owner's messages the agent hadn't seen.
   */
  app.post('/api/lanes/:id/messages', any, (req, res) => {
    const body = parse(s.message, req.body ?? {});
    const p = principalOf(res);
    if (p.role !== 'agent' && !config.decisions) {
      throw new NotFoundError("Writing to agents in LaneSignal is off on this server (LANESIGNAL_DECISIONS): write in the agent's session");
    }
    const project = acc(res).pick(projectQuery(req), { lane: String(req.params.id) });
    const laneId = q(project, String(req.params.id));
    const from = p.role === 'agent' ? 'agent' : 'owner';
    const message = store.postLaneMessage(laneId, { from, author: p.name, body: body.body, attachments: body.attachments }, ownerOf(p));
    if (from === 'owner') {
      res.status(201).json(message);
      return;
    }
    // Agents get what they need back, as from notify_owner.
    const unread = store.takeUnreadForAgent(laneId);
    res.status(201).json({ id: message.id, at: message.at, ...(unread.length ? { ownerMessages: briefMessages(unread) } : {}) });
  });

  // The agent's message on a lane, as notify_owner sends it: `message` and any `attachments`.
  app.post('/api/lanes/:id/notices', agent, (req, res) => {
    const body = parse(s.notice, req.body ?? {});
    const p = principalOf(res);
    const project = acc(res).pick(projectQuery(req), { lane: String(req.params.id) });
    const laneId = q(project, String(req.params.id));
    const r = store.postNotice(laneId, body.message, p.name, body.attachments, ownerOf(p));
    const unread = store.takeUnreadForAgent(laneId);
    res.status(201).json({ ...r, laneId: localId(r.laneId), ...(unread.length ? { ownerMessages: briefMessages(unread) } : {}) });
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
          laneId: lane ? q(a.pick(projectQuery(req), { lane }), lane) : undefined,
          projects: a.scope(projectQuery(req)),
        })
        .map(pub.escalation),
    );
  });

  /** Closed escalations for the History view: search, outcome and group filters, latest first, in pages. */
  app.get('/api/history', any, (req, res) => {
    const query = parse(s.historyQuery, req.query);
    const a = acc(res);
    const group = query.group ? q(a.pick(query.project, { group: query.group }), query.group) : undefined;
    if (group && !store.groupExists(group)) throw new NotFoundError(`Group "${query.group}" not found`);
    const states = query.outcome === 'answered' ? ['acknowledged' as const] : query.outcome === 'dismissed' ? ['withdrawn' as const] : undefined;
    const page = store.historyEscalations({
      projects: a.scope(query.project),
      query: query.q,
      groupId: group,
      states,
      before: query.before_at && query.before_id ? { at: query.before_at, id: query.before_id } : undefined,
      limit: query.limit,
    });
    res.json({ items: page.items.map(pub.escalation), next: page.next });
  });

  /** 201 when created; 200 with `duplicate: true` when the same open question already exists (a retry). */
  app.post('/api/escalations', agent, (req, res) => {
    const input = parse(s.escalationInput, req.body);
    const project = acc(res).pick(projectQuery(req), { lane: input.laneId });
    const escalation = store.createEscalation({ ...input, laneId: q(project, input.laneId) }, principalOf(res).name, ownerOf(principalOf(res)));
    res.status(escalation.duplicate ? 200 : 201).json(pub.escalation(escalation));
  });

  /** Everything in scope that involves the agent, without waiting (after a restart, or when it lost track). */
  app.get('/api/updates', any, decisionsOnly, (req, res) => {
    const query = parse(s.waitQuery, req.query);
    const scope = waitScopeFor(
      acc(res),
      parse(s.waitScope, { ids: query.ids, laneIds: query.lane, groupId: query.group, since: query.since }),
      query.project,
    );
    const { ready: _ready, ...all } = briefWait(pub.wait(store.handOver(store.decisionsFor(scope), acc(res).projects)));
    res.json(all);
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
    decisionsOnly,
    h(async (req, res) => {
      const query = parse(s.waitQuery, req.query);
      const scope = {
        ...waitScopeFor(
          acc(res),
          parse(s.waitScope, { ids: query.ids, laneIds: query.lane, groupId: query.group, since: query.since }),
          query.project,
        ),
        mode: query.format ?? 'digest',
      };
      const shape = (w: WaitResult) => (query.format === 'full' ? briefWait(w) : digestWait(w));
      const now = store.decisionsFor(scope);
      const timeout = query.timeout ?? 300;
      if (now.ready || timeout === 0) {
        res.json(shape(pub.wait(store.handOver(now, acc(res).projects))));
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
        const visible = accessFor(store, principalOf(res)).projects;
        // Notes are handed over only when they're actually sent: not to a revoked key or a client that left.
        if (!revoked && !abort.signal.aborted) store.handOver(result, visible);
        res.end(JSON.stringify(revoked ? { error: 'unauthorized', ready: false } : shape(pub.wait(result, visible))));
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
      const wait = config.decisions ? Math.min(Math.max(Number(req.query.wait ?? 0) || 0, 0), 300) : 0;
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
      if (wait > 0 && !accessFor(store, principalOf(res)).projects.includes(escalation.project)) {
        throw new NotFoundError(`Escalation "${String(req.params.id)}" not found`);
      }
      res.json(pub.escalation({ ...escalation, messages: store.messagesOf(escalation.id) }));
    }),
  );

  /**
   * A message in an escalation's conversation. From a person it's an answer of Other (the agent acts
   * on it or replies); from the agent that raised it, a short reply or update.
   */
  app.post('/api/escalations/:id/messages', any, decisionsOnly, (req, res) => {
    const body = parse(s.message, req.body ?? {});
    const a = acc(res);
    const target = a.escalation(String(req.params.id), projectQuery(req));
    const p = principalOf(res);
    if (p.role === 'agent') requireRaiser(store, a, target, 'reply to');
    const from = p.role === 'agent' ? 'agent' : 'owner';
    const escalation = store.postMessage(target.id, { from, author: p.name, body: body.body, attachments: body.attachments }, ownerOf(p));
    res.status(201).json(pub.escalation({ ...escalation, messages: store.messagesOf(escalation.id) }));
  });

  const escalationOf = (req: Request, res: Response) => acc(res).escalation(String(req.params.id), projectQuery(req)).id;

  /** Agents record agreement/disagreement with the recommendation. */
  app.post('/api/escalations/:id/positions', agent, decisionsOnly, (req, res) => {
    const body = parse(s.position, req.body);
    res.json(
      pub.escalation(
        store.addPosition(escalationOf(req, res), { ...body, agent: body.agent ?? principalOf(res).name }, principalOf(res).name),
      ),
    );
  });

  app.post('/api/escalations/:id/decide', human, decisionsOnly, (req, res) => {
    const body = parse(s.decision, req.body);
    res.json(
      pub.escalation(
        store.decideEscalation(escalationOf(req, res), body.decision, body.note ?? null, principalOf(res).name, body.change ?? false),
      ),
    );
  });

  /** Repeating an acknowledgement returns the same result. `status`/`activity` publish the lane's next state. */
  /** The agent that raised it, or a person on its behalf. */
  app.post('/api/escalations/:id/ack', any, decisionsOnly, (req, res) => {
    const body = parse(s.acknowledgement, req.body ?? {});
    const target = acc(res).escalation(String(req.params.id), projectQuery(req));
    requireRaiser(store, acc(res), target, 'acknowledge');
    res.json(
      pub.escalation(
        store.acknowledgeEscalation(target.id, body.note ?? null, principalOf(res).name, {
          status: body.status,
          activity: body.activity,
        }),
      ),
    );
  });

  /**
   * Agents dismiss an alert once it's dealt with (answered in their session, or moot), saying why;
   * people may dismiss stale ones. `status`/`activity` publish the lane's next state.
   */
  app.post('/api/escalations/:id/withdraw', any, (req, res) => {
    const body = parse(s.acknowledgement, req.body ?? {});
    const target = acc(res).escalation(String(req.params.id), projectQuery(req));
    requireRaiser(store, acc(res), target, 'dismiss');
    const p = principalOf(res);
    if (p.role === 'agent' && !body.note?.trim()) {
      throw new ValidationError('Say why in `note`: what was decided and where (e.g. "Sam: drop it, in the session")');
    }
    res.json(
      pub.escalation(
        store.dismissEscalation(
          target.id,
          body.note?.trim() || null,
          p.name,
          { status: body.status, activity: body.activity ?? undefined },
          p.role === 'agent',
        ),
      ),
    );
  });

  // ---- requirements (owner decisions about the product) ----

  app.get('/api/requirements', any, requirementsOnly, (req, res) => {
    const query = parse(s.requirementQuery, req.query);
    const a = acc(res);
    const projects = a.scope(query.project);
    const group = query.group ? q(a.pick(query.project, { group: query.group }), query.group) : undefined;
    if (group && !store.groupExists(group)) throw new NotFoundError(`Group "${query.group}" not found`);
    res.json(
      store
        .findRequirements({ query: query.q, tags: query.tag, group, projects, statuses: query.status, limit: query.limit })
        .map(pub.requirement),
    );
  });

  app.get('/api/requirements/tags', any, requirementsOnly, (req, res) => {
    const a = acc(res);
    const raw = typeof req.query.group === 'string' ? parse(s.groupId, req.query.group) : undefined;
    const group = raw ? q(a.pick(projectQuery(req), { group: raw }), raw) : undefined;
    if (group && !store.groupExists(group)) throw new NotFoundError(`Group "${raw}" not found`);
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

  app.get('/api/requirements/:id', any, requirementsOnly, (req, res) => {
    res.json(pub.requirement(visibleRequirement(res, String(req.params.id))));
  });

  const requirementBody = (req: Request, res: Response, current?: Requirement) =>
    requirementInputFor(acc(res), parse(s.requirementInput, req.body), projectQuery(req), current);

  app.post('/api/requirements', any, requirementsOnly, (req, res) => {
    const p = principalOf(res);
    const result = store.recordRequirement(requirementBody(req, res), p.name, p.role === 'human', ownerOf(p), approvesRequirements(p));
    res.status(result.duplicate ? 200 : 201).json(pubRecord(acc(res), result));
  });

  app.post('/api/requirements/:id/supersede', any, requirementsOnly, (req, res) => {
    const current = visibleRequirement(res, String(req.params.id));
    const result = store.supersedeRequirement(
      current.id,
      requirementBody(req, res, current),
      principalOf(res).name,
      principalOf(res).role === 'human',
      ownerOf(principalOf(res)),
      approvesRequirements(principalOf(res)),
    );
    res.status(201).json(pubRecord(acc(res), result));
  });

  app.patch('/api/requirements/:id', human, requirementsOnly, (req, res) => {
    const current = visibleRequirement(res, String(req.params.id));
    acc(res).requireWritable(current);
    res.json(pub.requirement(store.editRequirement(current.id, parse(s.requirementEdit, req.body))));
  });

  app.post('/api/requirements/:id/approve', human, requirementsOnly, (req, res) => {
    if (!approvesRequirements(principalOf(res))) throw new ForbiddenError('Approve requirements signed in, not with a personal key');
    const current = visibleRequirement(res, String(req.params.id));
    acc(res).requireWritable(current);
    res.json(pub.requirement(store.approveRequirement(current.id)));
  });

  app.post('/api/requirements/:id/restore', human, requirementsOnly, (req, res) => {
    const current = visibleRequirement(res, String(req.params.id));
    acc(res).requireWritable(current);
    res.json(pub.requirement(store.restoreRequirement(current.id)));
  });

  app.post('/api/requirements/:id/retire', human, requirementsOnly, (req, res) => {
    const current = visibleRequirement(res, String(req.params.id));
    acc(res).requireWritable(current);
    res.json(pub.requirement(store.retireRequirement(current.id)));
  });

  // ---- export (CSV / JSON / zip for analysis) ----

  const exportFilterOf = (req: Request, res: Response) => {
    const query = parse(s.exportFilter, req.query);
    const a = acc(res);
    return {
      from: query.from,
      to: query.to,
      laneId: query.lane ? q(a.pick(query.project, { lane: query.lane }), query.lane) : undefined,
      projects: a.scope(query.project),
    };
  };
  const stamp = () => new Date().toISOString().slice(0, 10);
  const datasets = EXPORT_DATASETS.filter((d) => d !== 'requirements' || config.requirements);
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
    const body = await exportZip(store, exportFilterOf(req, res), new Date(), datasets);
    res
      .set({
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="lanesignal-export-${stamp()}.zip"`,
        'cache-control': 'no-store',
      })
      .send(body);
  }));

  app.get('/api/export/:file', any, oneAtATime, h(async (req, res) => {
    const match = /^([a-z_]+)\.(csv|json)$/.exec(String(req.params.file));
    const dataset = match?.[1] as ExportDataset | undefined;
    if (!match || !dataset || !datasets.includes(dataset)) {
      throw new NotFoundError(`Unknown export; use one of ${datasets.map((d) => `${d}.csv`).join(', ')} (or .json)`);
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

  app.post('/mcp', any, mcpHandler(store, { decisions: config.decisions, requirements: config.requirements }));
  app.all('/mcp', (_req, res) => {
    res.status(405).set('allow', 'POST').json({ error: 'Stateless MCP endpoint: use POST' });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // ---- web frontend ----

  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get('/{*splat}', (req, res) => {
      // A mistyped API URL ("//api/wait", "/mcp/api/wait") must fail loudly, not answer 200 with the app.
      if (/\/(api|mcp)(\/|$)/.test(req.path)) {
        res.status(404).json({ error: `not found: ${req.path} (the API lives at /api/…, under the server's base URL)` });
        return;
      }
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
