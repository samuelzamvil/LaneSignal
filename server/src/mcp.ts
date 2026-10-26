import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import {
  accessFor,
  approvesRequirements,
  brief,
  briefLane,
  briefRequirement,
  briefTicket,
  briefWait,
  digestWait,
  briefEpic,
  briefMessages,
  escalationTarget,
  updateEpicFor,
  compact,
  ownerOf,
  pub,
  q,
  requireRaiser,
  requirementInputFor,
  waitScopeFor,
  type Access,
} from './access.ts';
import { principalOf, stillValidOf, watchRevocationOf } from './auth.ts';
import { log } from './log.ts';
import * as s from './schemas.ts';
import { toCsv } from './export.ts';
import {
  AGENT_MESSAGE_MAX,
  ConflictError,
  EXPORT_COLUMNS,
  EXPORT_DATASETS,
  REQUIREMENT_DATASETS,
  localId,
  NotFoundError,
  ValidationError,
  type ExportDataset,
  type RecordResult,
  type Store,
} from './store.ts';
import { LANE_STATUSES, TICKET_STATES, type Requirement, type Ticket } from './types.ts';

// Compact JSON: agents pay for every character.
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

/** Field names as the tools spell them, for validation messages. */
const SNAKE: Record<string, string> = {
  laneId: 'lane_id',
  recommendedOption: 'recommended_option',
  groupId: 'group_id',
  group: 'group_id',
  sourceEscalation: 'source_escalation',
  decidedBy: 'decided_by',
};

const fail = (err: unknown) => {
  if (err instanceof ZodError) {
    const text = err.issues
      .map((i) => {
        const field = i.path.map((p) => SNAKE[String(p)] ?? String(p)).join('.');
        return field ? `${field}: ${i.message}` : i.message;
      })
      .join('; ');
    return { isError: true, content: [{ type: 'text' as const, text: `Invalid input: ${text}` }] };
  }
  if (err instanceof NotFoundError || err instanceof ConflictError || err instanceof Error) {
    return { isError: true, content: [{ type: 'text' as const, text: err.message }] };
  }
  throw err;
};

const STATUS_HELP =
  'active = working; pending_ci = waiting on CI; awaiting_agent = waiting on another agent; ' +
  'blocked_human = waiting on the owner; idle = nothing to do; completed = done.';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * While a tool waits, sends a notification every 20s on the request's stream
 * (progress when the client asked for it, otherwise a debug log line), so
 * proxies and clients see the call is alive. Returns the stop function.
 */
function keepAlive(extra: Extra) {
  const token = extra._meta?.progressToken;
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    const note =
      token !== undefined
        ? { method: 'notifications/progress' as const, params: { progressToken: token, progress: n, message: 'Waiting for a human decision' } }
        : { method: 'notifications/message' as const, params: { level: 'debug' as const, logger: 'lanesignal', data: 'waiting for a human decision' } };
    extra.sendNotification(note).catch(() => {});
  }, 20_000);
  return () => clearInterval(timer);
}

/** Ends `fn`'s wait early when the request is cancelled or its credential revoked. */
async function cancellable<T>(
  extra: Extra,
  watchRevocation: (onInvalid: () => void) => () => void,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; revoked: boolean }> {
  const ctrl = new AbortController();
  extra.signal.addEventListener('abort', () => ctrl.abort());
  let revoked = false;
  const unwatch = watchRevocation(() => {
    revoked = true;
    ctrl.abort();
  });
  const stop = keepAlive(extra);
  try {
    return { value: await fn(ctrl.signal), revoked };
  } finally {
    stop();
    unwatch();
  }
}

/**
 * Some tools historically say `group`, others `group_id`: both work everywhere. Only `group_id`
 * is advertised (see slimToolList); the alias still validates and works.
 */
const GROUP_FILTER = z.string().max(64).optional().describe('Group (epic/train) id.');
const GROUP_ALIAS = z.string().max(64).optional();

/** Every tool takes it; only keys and people with several projects need it (the server instructions say so, once). */
const PROJECT = {
  project: z.string().max(40).optional(),
};
const PROJECT_WRITE = PROJECT;

/** Short, since the instructions say it too; for clients that don't pass instructions on to the model. */
const ESCALATION_ID = z.string().describe('Code ("967A") or id.');

/**
 * Said once per session (MCP server instructions) rather than in every tool's parameters: agents
 * read every tool definition on connecting, so a repeated description costs tokens each time.
 */
const INSTRUCTIONS =
  'LaneSignal conventions for every tool: `project` (id or key) is needed only when your key reaches several ' +
  'projects. Wherever a tool takes an escalation id, its code works too ("967A"; "LS-967A" names the project). ' +
  '`group` and `group_id` are the same. Unknown groups and lanes are errors, never empty results.';

/**
 * Trims what tools/list advertises, without changing what the tools accept: the JSON Schema
 * `$schema` URL on every tool, length limits that are only validation (ids, and text far beyond
 * what anyone writes), `minLength: 1`, `anyOf [x, null]` written as one nullable type, and the
 * `group` alias where `group_id` is listed. The server still validates every argument in full.
 */
export function slimSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slimSchema);
  if (!node || typeof node !== 'object') return node;
  const o = { ...(node as Record<string, unknown>) };
  delete o.$schema;
  delete o.minLength;
  // Limits on text an agent writes (a question, a requirement, an activity) help it; ids' and huge fields' don't.
  if (typeof o.maxLength === 'number' && (o.maxLength < 200 || o.maxLength > 5000)) delete o.maxLength;
  if (typeof o.maxItems === 'number' && o.maxItems >= 10) delete o.maxItems;
  if (Array.isArray(o.anyOf) && o.anyOf.length === 2) {
    const [x, y] = o.anyOf as Record<string, unknown>[];
    const nul = (v: Record<string, unknown>) => v && v.type === 'null' && Object.keys(v).length === 1;
    const one = nul(y) ? x : nul(x) ? y : null;
    // Only a plain type: with enum or const, a type array would still refuse null.
    const plain = one && typeof one.type === 'string' && !['enum', 'const', 'anyOf', 'oneOf', 'allOf'].some((k) => k in one);
    if (one && plain) {
      const { anyOf: _anyOf, ...outer } = o;
      // The outer node's own keys (its description) win over the inner branch's.
      for (const k of Object.keys(o)) delete o[k];
      Object.assign(o, slimSchema(one) as object, outer, { type: [one.type, 'null'] });
    }
  }
  if (o.properties && typeof o.properties === 'object') {
    const props = { ...(o.properties as Record<string, unknown>) };
    if ('group' in props && 'group_id' in props) delete props.group;
    o.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, slimSchema(v)]));
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties']) {
    if (key in o && typeof o[key] === 'object') o[key] = slimSchema(o[key]);
  }
  return o;
}

/** Optional parts of LaneSignal, switched on and off in the server's environment. */
export interface Features {
  /** People answer in LaneSignal; agents wait for and acknowledge decisions. */
  decisions: boolean;
  requirements: boolean;
}

/** Builds an MCP server whose tools act as the authenticated principal, within the projects it may see. */
function buildServer(
  store: Store,
  features: Features,
  a: Access,
  stillValid: () => Promise<boolean>,
  watchRevocation: (onInvalid: () => void) => () => void,
) {
  const who = a.principal;
  const listJson = <T>(items: T[]) => json(items);
  /** A group filter must name a real group: an empty result would read as "your lanes were removed". */
  const checkGroup = (group: string | undefined, project?: string) => {
    if (group && !a.scope(project).some((p) => store.groupExists(q(p, group)))) {
      throw new NotFoundError(`Group "${group}" not found (list_groups shows the ids)`);
    }
    return group;
  };
  /** fill_lane's `epic`: its number in the lane's project (null clears, undefined leaves it). */
  const epicNumber = (epic: string | null | undefined, project: string) => {
    if (epic === undefined || epic === null) return epic;
    const e = a.epic(epic, project);
    if (!e) throw new NotFoundError(`Epic "${epic}" not found (list_epics shows them)`);
    return e.id;
  };
  /** A ticket by any form of its ref, in the project given or the only one of the caller's that has it. */
  const findTicket = (ref: string, project?: string): Ticket => {
    const hits = a.scope(project).flatMap((p) => store.getTicket(p, ref) ?? []);
    if (hits.length > 1) throw new ValidationError(`"${ref}" is a ticket in several projects: say which (project)`);
    if (!hits.length) throw new NotFoundError(`Ticket "${ref}" not found (list_tickets shows them)`);
    return hits[0];
  };
  const server = new McpServer({ name: 'lanesignal', version: '0.1.0' }, { capabilities: { logging: {} }, instructions: INSTRUCTIONS });

  server.registerTool(
    'list_lanes',
    {
      description: 'List lanes (status, ticket, activity, open escalation counts), optionally for one group.',
      inputSchema: { status: z.enum(LANE_STATUSES).optional(), group_id: GROUP_FILTER, group: GROUP_ALIAS, ...PROJECT },
      annotations: { readOnlyHint: true },
    },
    async ({ status, group_id, group: alias, project }) => {
      try {
        const group = checkGroup(group_id ?? alias, project);
        return listJson(
          store
            .listLanes(a.scope(project))
            .map(pub.lane)
            .filter((l) => (!status || l.status === status) && (!group || l.group === group))
            .map((l) => briefLane(l, features.decisions, a.projects.length === 1)),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_tickets',
    {
      description:
        'List tickets: by default the ones lanes hold and the parked ones (set aside to pick up again, with why), ' +
        'optionally for one group. A ticket\'s state here only says whether a lane holds it, not its status in its tracker. ' +
        'After a restart, look for tickets still `in_lane` that nobody is working.',
      inputSchema: {
        group_id: GROUP_FILTER,
        group: GROUP_ALIAS,
        state: z.array(z.enum(TICKET_STATES)).max(4).optional().describe('Default ["in_lane", "parked"].'),
        ...PROJECT,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ group_id, group: alias, state, project }) => {
      try {
        const group = checkGroup(group_id ?? alias, project);
        const projects = a.scope(project);
        const tickets = group
          ? projects.flatMap((p) => store.listTickets({ projects: [p], groupId: q(p, group), states: state }))
          : store.listTickets({ projects, states: state });
        return listJson(tickets.map((t) => briefTicket(pub.ticket(t))));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_ticket',
    {
      description:
        'One ticket, by any form of its ref ("967", "#967", "redmine:967", its URL): where it is, its escalations, ' +
        'its status history and the lanes it passed through.',
      inputSchema: { ticket: z.string().min(1).max(300), ...PROJECT },
      annotations: { readOnlyHint: true },
    },
    async ({ ticket, project }) => {
      try {
        const t = findTicket(ticket, project);
        return json({
          ...briefTicket(pub.ticket(t)),
          escalations: store.listEscalations({ ticketId: t.id, states: ['open', 'decided', 'acknowledged', 'withdrawn'], limit: 100 }).map((e) =>
            brief(pub.escalation(e)),
          ),
          lanes: store.ticketLanes(t.id).map(localId),
          history: store.ticketEvents(t.id, 50).map((e) => compact({ at: e.at, lane: localId(e.laneId), kind: e.kind, message: e.message, by: e.actor })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_epics',
    {
      description:
        'List epics: the long-lived tickets groups steer their work by, each with its status line, open questions and ' +
        'notes people left on its board. Every group has one; a group with none of its own stands in as its epic ' +
        '(`standIn`, named by the group\'s id). `epic` is how to name one in other tools.',
      inputSchema: { group_id: GROUP_FILTER, group: GROUP_ALIAS, ...PROJECT },
      annotations: { readOnlyHint: true },
    },
    async ({ group_id, group: alias, project }) => {
      try {
        const group = checkGroup(group_id ?? alias, project);
        const projects = a.scope(project);
        const epics = group
          ? projects.flatMap((p) => (store.groupExists(q(p, group)) ? store.listEpics({ projects: [p], groupId: q(p, group) }) : []))
          : store.listEpics({ projects });
        return listJson(epics.map((e) => briefEpic(pub.epic(e))));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_projects',
    {
      description:
        'List the projects your key reaches (id, key, name). Pass `project` to other tools when it reaches several.',
      annotations: { readOnlyHint: true },
    },
    async () => listJson(store.listProjects().filter((p) => a.projects.includes(p.id))),
  );

  server.registerTool(
    'list_groups',
    {
      description: 'List groups (the epic/train each overseer runs) with their ticket and links.',
      inputSchema: { ...PROJECT },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      try {
        return listJson(store.listGroups(a.scope(project)).map(pub.group));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_escalations',
    {
      description:
        features.decisions
          ? 'List escalations in brief, newest last (get_escalation has everything). Defaults to unresolved ones (open, ' +
            'and decided but not acknowledged) and the latest 50.'
          : 'List escalations in brief, newest last (get_escalation has everything). Defaults to open ones and the latest 50.',
      inputSchema: {
        group_id: GROUP_FILTER,
        group: GROUP_ALIAS,
        lane_id: z.string().optional(),
        states: features.decisions
          ? z.array(z.enum(['open', 'decided', 'acknowledged', 'withdrawn'])).optional()
          : z.array(z.enum(['open', 'withdrawn'])).optional().describe('"withdrawn" = dismissed.'),
        limit: z.number().int().min(1).max(500).optional(),
        ...PROJECT,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ group_id, group: alias, lane_id, states, limit, project }) => {
      try {
        const group = checkGroup(group_id ?? alias, project);
        const laneId = lane_id ? q(a.pick(project, { lane: lane_id }), lane_id) : undefined;
        const groupId = group ? q(a.pick(project, { group }), group) : undefined;
        return listJson(
          store
            .listEscalations({ laneId, groupId, states: states ?? (features.decisions ? undefined : ['open']), projects: a.scope(project), limit: limit ?? 50 })
            .map((e) => brief(pub.escalation(e))),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_escalation',
    {
      description:
        features.decisions
          ? 'Get one escalation in full, with its conversation. Pass wait_seconds to block until a human decides or ' +
            'answers Other (long-poll, max 300). ' +
            'To wait on several escalations, lanes or your whole group at once, use wait_for_decisions.'
          : 'Get one escalation in full.',
      inputSchema: {
        id: ESCALATION_ID,
        ...(features.decisions ? { wait_seconds: z.number().int().min(0).max(300).optional() } : {}),
        ...PROJECT,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, wait_seconds, project }: { id: string; wait_seconds?: number; project?: string }, extra) => {
      try {
        const target = a.escalation(id, project);
        const { value, revoked } = await cancellable(extra, watchRevocation, (signal) =>
          store.waitForDecision(target.id, (wait_seconds ?? 0) * 1000, signal),
        );
        if (revoked || (wait_seconds && !(await stillValid()))) return fail(new Error('Credential revoked'));
        if (wait_seconds && !accessFor(store, a.principal).projects.includes(value.project)) {
          return fail(new NotFoundError(`Escalation "${id}" not found`));
        }
        return json(pub.escalation({ ...value, messages: store.messagesOf(value.id) }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (features.decisions) {
    const waitInput = {
      group_id: s.groupId.optional().describe('Wait on every lane in this group (your epic/train).'),
      group: s.groupId.optional(),
      lane_ids: z.array(s.laneId).max(100).optional(),
      ids: z.array(z.string()).max(100).optional().describe('Escalation ids or codes such as "967A" or "A12".'),
      since: z
        .string()
        .optional()
        .describe('Pass the previous result\'s `checkedAt`: what changed since then comes back, again if you repeat it.'),
      ...PROJECT,
    };

    server.registerTool(
      'wait_for_decisions',
      {
        description:
          'Wait for what needs you in your group, some lanes or escalations; it waits even when nothing is open. Returns ' +
          '`items`: `{code, kind, text}` for an escalation, `{kind, id, text}` for a lane, ticket or epic (the owner\'s words, or what happened). Kinds: `decided` (acknowledge, then act), `reply` (the owner answered Other), ' +
          '`closed`, `lane_removed`, `lane_note`, `board_note`, `ticket_moved`. `decided` and `reply` repeat until handled; ' +
          'the rest come once per `since`. `counts` (left out when all zero): `open`, `decidedUnacknowledged`, `waitingOnYou`. `ready: false` means ' +
          'it timed out: call again with `since` = `checkedAt`. Holds your session while it waits (default 300s, max 3600; ' +
          '0 for a quick check). `format: "full"`: the older shape.',
        inputSchema: {
          ...waitInput,
          wait_seconds: z.number().int().min(0).max(3600).optional(),
          format: z.enum(['digest', 'full']).optional().describe('Default `digest`. `full` is kept for older agents.'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ group_id, group, lane_ids, ids, wait_seconds, since, format, project }, extra) => {
        try {
          const scope = {
            ...waitScopeFor(a, s.waitScope.parse({ groupId: group_id ?? group, laneIds: lane_ids, ids, since }), project),
            mode: format ?? 'digest',
          };
          const timeout = wait_seconds ?? 300;
          const { value, revoked } = await cancellable(extra, watchRevocation, (signal) =>
            store.waitForDecisions(scope, timeout * 1000, signal),
          );
          if (revoked || (timeout && !(await stillValid()))) return fail(new Error('Credential revoked'));
          const visible = timeout ? accessFor(store, a.principal).projects : a.projects;
          // A cancelled call never reaches the agent: its notes stay unread.
          if (!extra.signal.aborted) store.handOver(value, visible);
          const result = pub.wait(value, timeout ? visible : undefined);
          return json(format === 'full' ? briefWait(result) : digestWait(result, a.projects.length > 1));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'get_updates',
      {
        description:
          'Everything in scope that involves you, without waiting: `decided`, `replies`, `open`, unread `laneMessages` and ' +
          '`boardMessages`, and with `since`, what was withdrawn or removed since. For restarts, or when you lost track.',
        inputSchema: waitInput,
        annotations: { readOnlyHint: true },
      },
      async ({ group_id, group, lane_ids, ids, since, project }) => {
        try {
          const scope = waitScopeFor(a, s.waitScope.parse({ groupId: group_id ?? group, laneIds: lane_ids, ids, since }), project);
          // Digest rules (notes since `since` included), the full shape.
          const value = store.decisionsFor(scope);
          store.handOver(value, a.projects);
          const { ready: _ready, ...all } = briefWait(pub.wait(value));
          return json(all);
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  // People's own Claude sessions can export; agents don't need it in every session's tool list.
  if (who.role === 'human') {
    server.registerTool(
      'export_data',
      {
        description:
          'Export LaneSignal data for analysis, including closed escalations and archived lanes. Datasets: ' +
          'escalations (one row each), positions, messages (escalation conversations), lane_messages (lane conversations), ' +
          'lanes, groups, tickets, epics, epic_messages (epic boards), events (status changes and escalation history)' +
          (features.requirements ? ', requirements, products, requirement_changes (scope changes). ' : '. ') +
          '`from`/`to` (YYYY-MM-DD or ISO) filter ' +
          'escalations, positions, messages, lane_messages, epic_messages, events and requirements by creation time. Results come in pages (default 100 rows, and cut short to stay under ' +
          'about 60 KB); the first line says which rows you got and the offset for the next page. For everything at ' +
          'once as files, the HTTP API serves a zip at GET /api/export.',
        inputSchema: {
          dataset: z.enum(EXPORT_DATASETS.filter((d) => !REQUIREMENT_DATASETS.includes(d) || features.requirements) as [ExportDataset, ...ExportDataset[]]),
          format: z.enum(['csv', 'json']).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          lane_id: z.string().optional(),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(1000).optional(),
          ...PROJECT,
        },
        annotations: { readOnlyHint: true },
      },
      async ({ dataset, format, from, to, lane_id, offset, limit, project }) => {
        try {
          const f = s.exportFilter.parse({ from, to, lane: lane_id });
          const rows = store.exportRows(dataset, {
            from: f.from,
            to: f.to,
            laneId: f.lane ? q(a.pick(project, { lane: f.lane }), f.lane) : undefined,
            projects: a.scope(project),
            includeRejected: approvesRequirements(who),
          });
          const start = offset ?? 0;
          let page = rows.slice(start, start + (limit ?? 100));
          const render = (p: typeof page) =>
            format === 'json' ? JSON.stringify(p) : toCsv(p, [...EXPORT_COLUMNS[dataset]]);
          // Keep each response within what MCP clients accept.
          let body = render(page);
          while (body.length > 60_000 && page.length > 1) {
            page = page.slice(0, Math.ceil(page.length / 2));
            body = render(page);
          }
          const range = page.length ? `${start + 1}-${start + page.length}` : 'none';
          const more = start + page.length < rows.length ? `; call again with offset ${start + page.length} for more` : '';
          return {
            content: [
              { type: 'text' as const, text: `${dataset}: rows ${range} of ${rows.length}${more}` },
              { type: 'text' as const, text: body },
            ],
          };
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  if (features.requirements) {
    // ---- requirements: the owner's product decisions, for every role ----

    const REQ_ID_HELP = 'Requirement id, e.g. "R14".';
    const SCOPE_HELP =
      'Where it applies: "products" (with `products`), "project" (every product in the project) or "global" (every project; ' +
      'only when the owner said so). list_products shows the products.';
    const requirementFields = {
      requirement: s.requirementInput.shape.requirement.describe('One normative statement, e.g. "Payouts retry at most 5 times."'),
      justification: s.requirementInput.shape.justification.describe('Why the owner decided it, and where.'),
      scope: z.enum(s.REQUIREMENT_SCOPES).describe(SCOPE_HELP),
      products: z.array(s.productId).min(1).max(20).optional().describe('Product ids it concerns, with scope "products".'),
      group_id: s.groupId.nullable().optional().describe('Your train/epic, to cite an escalation from its lanes. Not where it applies.'),
      source_escalation: z.string().optional().describe('The escalation code it answered, e.g. "967A".'),
      decided_by: z
        .string()
        .max(100)
        .optional()
        .describe(
          features.decisions
            ? 'Who decided, e.g. "Sam (Remote Control, 2026-10-23)"; leave out for an escalation answered on the dashboard.'
            : 'Who decided, e.g. "Sam (Remote Control, 2026-10-23)". Required.',
        ),
    };
    /** The same fields without descriptions, for supersede (described once, on record); scope is optional there. */
    const supersedeFields = {
      requirement: s.requirementInput.shape.requirement,
      justification: s.requirementInput.shape.justification,
      scope: z.enum(s.REQUIREMENT_SCOPES).optional(),
      products: z.array(s.productId).min(1).max(20).optional(),
      group_id: s.groupId.nullable().optional(),
      source_escalation: z.string().optional(),
      decided_by: z.string().max(100).optional(),
    };
    const toInput = (
      args: {
        requirement: string;
        justification: string;
        scope?: (typeof s.REQUIREMENT_SCOPES)[number];
        products?: string[];
        group_id?: string | null;
        source_escalation?: string;
        decided_by?: string;
        project?: string;
      },
      current?: Requirement,
    ) =>
      requirementInputFor(
        a,
        s.requirementInput.parse({
          requirement: args.requirement,
          justification: args.justification,
          scope: args.scope,
          products: args.products,
          group: args.group_id,
          sourceEscalation: args.source_escalation,
          decidedBy: args.decided_by,
        }),
        args.project,
        current,
      );
    /** A requirement the caller may see: one for all projects, or one of the caller's projects. Rejected ones are hidden from agents. */
    const visibleRequirement = (id: string) => {
      const found = store.getRequirement(id);
      if (!found || found.status === 'rejected' || (found.project !== null && !a.projects.includes(found.project))) {
        throw new NotFoundError(`Requirement "${id}" not found`);
      }
      return found;
    };
    /** Similar requirements are only those the caller may see. */
    const pubRecord = (a: Access, r: RecordResult) =>
      compact({
        requirement: briefRequirement(pub.requirement(r.requirement)),
        duplicate: r.duplicate,
        // Enough to tell whether one is the same decision; get_requirement has the rest.
        similar: r.similar.some(a.sees) ? r.similar.filter(a.sees).map((x) => ({ id: x.id, requirement: x.requirement })) : undefined,
      });

    server.registerTool(
      'find_requirements',
      {
        description:
          'Everything that applies to your work, in one call: the requirements of the `products` you name, plus the ' +
          'project-wide and global ones. Work not tied to a product: `project_only: true` (project-wide and global only). ' +
          'One of the two is required; list_products shows the products. Follow what comes back and cite ids ("per R14"); ' +
          'check here before escalating a product or scope question. The response names the scope it used. Justification ' +
          'isn\'t included: get_requirement with include_justification has it. `query` narrows by free text (or finds an id ' +
          'like "R14"). Pending and active ones unless you set `statuses`; `status: "pending"` means the owner hasn\'t ' +
          'approved the record yet: follow it, but it may still be corrected. A requirement in force with `supersededBy` ' +
          'has a replacement waiting for approval: both come back, the current one then the pending change, even when ' +
          'the partner is scoped to another product (each says its scope). Up to `limit` (default and most 200); ' +
          '`truncated: true` means there are more: narrow with `query`. ' +
          '`needsRegrouping: true` marks an older one whose scope the owner hasn\'t set yet (it counts as project-wide).',
        inputSchema: {
          products: z.array(s.productId).min(1).max(20).optional(),
          project_only: z.boolean().optional(),
          query: z.string().max(500).optional(),
          statuses: z.array(z.enum(s.AGENT_REQUIREMENT_STATUSES)).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          ...PROJECT,
        },
        annotations: { readOnlyHint: true },
      },
      async ({ products, project_only, query, statuses, limit, project }) => {
        try {
          // A key that sees every project but has none yet still reads the global ones.
          if (project_only && !project && !a.projects.length && a.global) {
            const found = store.findRequirements({ query, projects: [], statuses, scope: { global: true }, limit: limit ?? 200 });
            return json(compact({ scope: { global: true }, requirements: found.map((x) => briefRequirement(pub.requirement(x))), truncated: found.length >= (limit ?? 200) || undefined }));
          }
          const pr = a.pick(project);
          const known = () => store.listProducts([pr]).map((p) => p.id);
          if (products && project_only) throw new ValidationError('Give either products or project_only, not both');
          if (!products && !project_only) {
            const names = known();
            throw new ValidationError(
              'Say what you work on: `products` (' +
                (names.length ? names.join(', ') : 'this project has no products yet') +
                '), or `project_only: true` for work not tied to a product.',
            );
          }
          if (products) store.requireProducts(pr, products);
          const scope = products ? { project: pr, products: [...new Set(products)].sort() } : { project: pr, projectOnly: true as const };
          const found = store.findRequirements({
            query,
            projects: [pr],
            statuses,
            scope: { project: pr, products, projectWide: true, global: true },
            limit: limit ?? 200,
          });
          return json(
            compact({ scope, requirements: found.map((x) => briefRequirement(pub.requirement(x))), truncated: found.length >= (limit ?? 200) || undefined }),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'get_requirement',
      {
        description:
          'Read one requirement, including what superseded it if it is no longer active. `include_justification: true` adds ' +
          'why the owner decided it, who decided and where.',
        inputSchema: { id: z.string().describe(REQ_ID_HELP), include_justification: z.boolean().optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ id, include_justification }) => {
        try {
          return json(briefRequirement(pub.requirement(visibleRequirement(id)), !!include_justification));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'list_products',
      {
        description:
          'The products requirements are scoped to, with whether each is locked (a locked product refuses agents\' changes ' +
          'to its requirements) and how many requirements it has. Only the owner adds products.',
        inputSchema: { ...PROJECT },
        annotations: { readOnlyHint: true },
      },
      async ({ project }) => {
        try {
          return listJson(
            store
              .listProducts(a.scope(project))
              .map((p) => compact({ id: p.id, name: p.name, project: p.project, locked: p.locked || undefined, requirements: p.requirements })),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'record_requirement',
      {
        description:
          'Record a product decision the owner made (never your own design choice), one per requirement, scoped to where ' +
          'it applies: the products it concerns, the whole project, or (only when the owner said so) every project. ' +
          (features.decisions
            ? 'Cite `source_escalation` alone if it was answered on the dashboard; otherwise say who decided (`decided_by`), ' +
              'plus `source_escalation` when it answered an escalation in your session. '
            : 'Say who decided (`decided_by`), plus `source_escalation` when it answered an escalation. ') +
          'Search first so you don\'t ' +
          'record it twice; the same requirement from the same escalation returns the first (`duplicate: true`). ' +
          '`similar` lists ones that read alike: if the owner changed their mind, supersede_requirement the old one. ' +
          'A locked product refuses new requirements from agents.' +
          (approvesRequirements(who) ? '' : ' What you record is `pending` until a person approves it, whatever its scope.'),
        inputSchema: { ...requirementFields, ...PROJECT_WRITE },
      },
      async (args) => {
        try {
          return json(
            pubRecord(a, store.recordRequirement(toInput(args), who.name, who.role === 'human', ownerOf(who), approvesRequirements(who))),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'supersede_requirement',
      {
        description:
          'The owner changed a decision: record the new one and mark the old one superseded (kept for history). ' +
          'Fields as in record_requirement; scope defaults to the old one\'s. Refused for a requirement in a locked product.' +
          (approvesRequirements(who)
            ? ''
            : ' The new one is `pending`; the old one stays in force, its `supersededBy` naming the replacement, until a person approves it.'),
        inputSchema: { id: z.string().describe(REQ_ID_HELP), ...supersedeFields, ...PROJECT_WRITE },
      },
      async ({ id, ...args }) => {
        try {
          const current = visibleRequirement(id);
          return json(
            pubRecord(
              a,
              store.supersedeRequirement(current.id, toInput(args, current), who.name, who.role === 'human', ownerOf(who), approvesRequirements(who)),
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  if (who.role === 'agent') {
    server.registerTool(
      'update_group',
      {
        description:
          'Register or update your group (the train you oversee): `name`, and your Remote Control session in `links` ' +
          'with kind "session", so the dashboard links people straight to you. Its epic\'s ticket goes in update_epic.',
        inputSchema: {
          group_id: s.groupId,
          ...s.groupPatch.shape,
          ticket: s.groupPatch.shape.ticket.describe('Ignored: name the epic with update_epic.'),
          ...PROJECT_WRITE,
        },
      },
      async ({ group_id, project, ticket, ...patch }) => {
        try {
          const group = store.upsertGroup(q(a.pick(project, { group: group_id }), group_id), patch, who.name, ownerOf(who));
          return json(
            compact({
              id: localId(group.id),
              project: group.project,
              warning: ticket?.trim()
                ? `A group's ticket is now its epic's: update_epic with epic "${ticket.trim()}" and group "${group_id}" adds it.`
                : undefined,
            }),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    /** What publishing a lane returns: where it stands, not everything echoed (the most frequent call). */
    const published = (laneId: string, requested: string | undefined, lane: ReturnType<typeof store.upsertLane>) => {
      const unread = store.takeUnreadForAgent(laneId);
      const pubLane = pub.lane(lane);
      // Say so when the status was kept, rather than letting it look accepted.
      const kept =
        requested && pubLane.status !== requested && pubLane.status === 'blocked_human'
          ? `Kept blocked_human: ${pubLane.blockingEscalations} blocking escalation(s) still open; dismiss them first.`
          : undefined;
      return json(
        compact({
          id: pubLane.id,
          project: pubLane.project,
          letter: pubLane.letter,
          status: pubLane.status,
          blockingEscalations: pubLane.blockingEscalations || undefined,
          warning: [kept, lane.warning].filter(Boolean).join(' ') || undefined,
          // The owner wrote on the lane since you last heard: read and act on it (reply with notify_owner).
          ownerMessages: unread.length ? briefMessages(unread) : undefined,
        }),
      );
    };
    const WAITING_ON = z
      .string()
      .max(300)
      .nullable()
      .optional()
      .describe('Another ticket the lane\'s ticket waits on (e.g. "945"); null clears it. Cleared by itself once that ticket is done.');

    server.registerTool(
      'update_lane',
      {
        description:
          `Publish a lane's state when it changes. Creates it on first call (pass your \`group_id\`); omitted fields ` +
          `are unchanged. ${STATUS_HELP} \`completed\` finishes its ticket and empties the lane. To change tickets use fill_lane ` +
          '(a different `ticket` here parks the one it held). PRs go in `links`, never `ticket`.' +
          (features.decisions ? ' `ownerMessages`: the owner\'s notes on the lane.' : ''),
        inputSchema: {
          lane_id: s.laneId,
          ...s.lanePatch.shape,
          group_id: s.lanePatch.shape.group,
          waiting_on: WAITING_ON,
          ...PROJECT_WRITE,
        },
      },
      async ({ lane_id, project, group_id, waiting_on, ...rest }) => {
        try {
          const patch = { ...rest, group: rest.group !== undefined ? rest.group : group_id };
          const pr = a.pick(project, { lane: lane_id, group: patch.group ?? undefined });
          const qualified = { ...patch, group: patch.group ? q(pr, patch.group) : patch.group };
          const lane = store.upsertLane(q(pr, lane_id), qualified, who.name, { waitingOn: waiting_on });
          return published(q(pr, lane_id), patch.status, lane);
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'fill_lane',
      {
        description:
          'Move a lane to another ticket. `previous` (required when the lane holds a different ticket): `park` (with ' +
          '`reason`), `done` or `drop`. `ticket` moves in (created on first use; a parked or done one comes back with ' +
          'its questions); leave it out to empty the lane. A ticket is in one lane at a time. `epic`: the epic the ' +
          'ticket is for. Takes update_lane\'s fields too, applied after the switch.',
        inputSchema: {
          lane_id: s.laneId,
          ticket: z.string().max(300).nullable().optional().describe('The ticket to work next; leave out or null to empty the lane.'),
          previous: s.ticketRelease.optional(),
          reason: z.string().max(500).nullable().optional(),
          waiting_on: WAITING_ON,
          epic: s.epicName.nullable().optional().describe('The epic the ticket is for: its ref, or the group\'s id. null clears it.'),
          ...s.lanePatch.omit({ ticket: true }).shape,
          group_id: s.lanePatch.shape.group,
          ...PROJECT_WRITE,
        },
      },
      async ({ lane_id, project, group_id, ticket, previous, reason, waiting_on, epic, ...rest }) => {
        try {
          const patch = { ...rest, group: rest.group !== undefined ? rest.group : group_id };
          const pr = a.pick(project, { lane: lane_id, group: patch.group ?? undefined });
          const qualified = { ...patch, group: patch.group ? q(pr, patch.group) : patch.group, ticket: ticket ?? null };
          const lane = store.upsertLane(q(pr, lane_id), qualified, who.name, {
            previous,
            reason,
            waitingOn: waiting_on,
            epic: epicNumber(epic, pr),
            strict: true,
          });
          return published(q(pr, lane_id), patch.status, lane);
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'remove_lane',
      {
        description:
          'Take a lane off the dashboard. Its ticket goes as `previous` says (default: done if completed, else parked); ' +
          'questions stay open with their ticket or epic. Publishing the lane again brings it back.',
        inputSchema: { lane_id: s.laneId, previous: s.ticketRelease.optional(), reason: z.string().max(500).nullable().optional(), ...PROJECT_WRITE },
      },
      async ({ lane_id, previous, reason, project }) => {
        try {
          store.deleteLane(q(a.pick(project, { lane: lane_id }), lane_id), who.name, { previous, reason });
          return { content: [{ type: 'text' as const, text: `Lane "${lane_id}" removed` }] };
        } catch (err) {
          return fail(err);
        }
      },
    );

    const EPIC = s.epicName.describe('The epic: its ticket ref ("680"), or a group\'s id for that group\'s epic.');

    server.registerTool(
      'update_epic',
      {
        description:
          'Set an epic\'s `status_line` (one line on its card, e.g. "3 of 5 lanes busy; next up #966"), name, ref or ' +
          'links. A ref no epic has yet, with `group`, adds that epic to the group. Returns `ownerMessages` from its board.',
        inputSchema: {
          epic: EPIC,
          group: s.groupId.optional().describe('To add a new epic: the group it belongs to.'),
          name: z.string().min(1).max(200).optional(),
          ref: z.string().max(300).optional(),
          links: s.epicPatch.shape.links,
          status_line: s.statusLine,
          ...PROJECT_WRITE,
        },
      },
      async ({ epic, group, name, ref, links, status_line, project }) => {
        try {
          const e = updateEpicFor(store, a, { epic, group, name, ref, links, statusLine: status_line }, project, who.name);
          const unread = store.takeUnreadEpicForAgent(e.id);
          return json(compact({ ...briefEpic(pub.epic(store.getEpic(e.id)!)), ownerMessages: unread.length ? briefMessages(unread) : undefined }));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'notify_epic',
      {
        description:
          'Write on an epic\'s board (direction, scope, which tickets next), with a quiet push. One per epic per minute. ' +
          'Returns `ownerMessages`: notes on the board you hadn\'t seen.',
        inputSchema: {
          epic: EPIC,
          message: s.notice.shape.message,
          attachments: s.notice.shape.attachments.describe('Ids from POST /api/attachments.'),
          ...PROJECT_WRITE,
        },
      },
      async ({ epic, message, attachments, project }) => {
        try {
          const e = a.epic(epic, project);
          if (!e) throw new NotFoundError(`Epic "${epic}" not found (list_epics shows them)`);
          const m = store.postEpicMessage(e.id, { from: 'agent', author: who.name, body: message, attachments }, ownerOf(who));
          const unread = store.takeUnreadEpicForAgent(e.id);
          return json(compact({ epic: e.displayRef ?? localId(e.group), at: m.at, ownerMessages: unread.length ? briefMessages(unread) : undefined }));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'request_epic_close',
      {
        description:
          'Ask a person to close an epic whose work is over; they approve or decline in the app. Refused while any of its ' +
          'questions is open or unacknowledged, and for a group standing in as its epic.',
        inputSchema: { epic: EPIC, reason: s.closeRequest.shape.reason, ...PROJECT_WRITE },
      },
      async ({ epic, reason, project }) => {
        try {
          const e = a.epic(epic, project);
          if (!e) throw new NotFoundError(`Epic "${epic}" not found (list_epics shows them)`);
          return json(briefEpic(pub.epic(store.requestEpicClose(e.id, reason, who.name))));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'notify_owner',
      {
        description:
          'Write to the owner in the lane\'s conversation, with a quiet phone notification that opens the lane: a ' +
          'milestone ("Merged PR #311", "Starting gh:42"). One per lane per minute. Not for routine progress, and not ' +
          'for questions (create_escalation).' +
          (features.decisions ? ' May return `ownerMessages`, as update_lane does.' : ''),
        inputSchema: {
          lane_id: s.laneId,
          message: s.notice.shape.message,
          attachments: s.notice.shape.attachments.describe('Screenshots or detail: ids from POST /api/attachments.'),
          ...PROJECT_WRITE,
        },
      },
      async ({ lane_id, message, attachments, project }) => {
        try {
          const laneId = q(a.pick(project, { lane: lane_id }), lane_id);
          const r = store.postNotice(laneId, message.trim(), who.name, attachments, ownerOf(who));
          const unread = store.takeUnreadForAgent(laneId);
          return json(compact({ laneId: localId(r.laneId), at: r.at, ownerMessages: unread.length ? briefMessages(unread) : undefined }));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'create_escalation',
      {
        description:
          'Ask the owner, one decision per call: notifies their phone and blocks the lane holding its ticket ' +
          '(`blocking: false` for an FYI). Raised on a lane (published first), it\'s the lane\'s ticket\'s, or its ' +
          'group\'s epic\'s if it holds none; `epic` with no `lane_id` raises it on the epic (blocks no lane). ' +
          'Returns its code (`ref`, e.g. "967A"). The same open question again returns the first (`duplicate: true`); ' +
          'an open FYI asked again without `blocking: false` becomes blocking (`upgraded: true`), taking the fields you give.',
        inputSchema: {
          lane_id: s.laneId.optional().describe('The lane it\'s raised in; leave out to raise it on `epic`.'),
          epic: s.epicName.optional().describe('The epic it\'s for: its ref, or the group\'s id.'),
          question: s.escalationFields.question,
          context: s.escalationFields.context,
          recommendation: s.escalationFields.recommendation,
          cost: s.escalationFields.cost,
          alternatives: s.escalationFields.alternatives,
          ticket: s.escalationFields.ticket,
          positions: s.escalationFields.positions,
          ...(features.decisions
            ? {
                accept_means: s.escalationFields.acceptMeans.describe('One line: what you do if the owner accepts.'),
                reject_means: s.escalationFields.rejectMeans.describe('One line: what you do if they reject.'),
                allow_reject: s.escalationFields.allowReject.describe('false when Reject makes no sense (default true).'),
              }
            : {}),
          attachments: s.escalationFields.attachments.describe('Ids returned by POST /api/attachments (curl -F file=@plan.md).'),
          links: s.escalationFields.links,
          blocking: s.escalationFields.blocking,
          ...PROJECT_WRITE,
        },
      },
      async ({ lane_id, accept_means, reject_means, allow_reject, project, ...rest }) => {
        try {
          const { epic, ...input } = s.escalationInput.parse({
            laneId: lane_id,
            acceptMeans: accept_means,
            rejectMeans: reject_means,
            allowReject: allow_reject,
            ...rest,
          });
          const target = escalationTarget(store, a, { laneId: input.laneId, epic }, project);
          return json(brief(pub.escalation(store.createEscalation({ ...input, ...target }, who.name, ownerOf(who)))));
        } catch (err) {
          return fail(err);
        }
      },
    );

  if (features.decisions) {
      server.registerTool(
        'add_position',
        {
          description:
            'Record whether you agree or disagree with an open escalation\'s recommendation, with a short reason. ' +
            'One position per agent; calling again replaces yours. Use `agent` to name yourself if you share a token.',
          inputSchema: { id: ESCALATION_ID, ...s.position.shape, ...PROJECT },
        },
        async ({ id, agent, project, ...rest }) => {
          try {
            const target = a.escalation(id, project).id;
            return json(brief(pub.escalation(store.addPosition(target, { ...rest, agent: agent ?? who.name }, who.name))));
          } catch (err) {
            return fail(err);
          }
        },
      );

      server.registerTool(
        'acknowledge_escalation',
        {
          description:
            'Call as soon as an escalation is decided, before acting: it closes the escalation and returns the final ' +
            '`decision` and `decisionNote` to act on. On one the owner answered Other, it takes their latest messages as ' +
            'the decision (`Other`). To act on them, acknowledge instead of replying; reply only to ask or object. If you did ' +
            'reply and their instructions still stand, acknowledging takes them. ' +
            'A human may correct a mis-tap until you acknowledge. ' +
            'Pass `status` and `activity` to publish what the lane does next in the same call; otherwise the lane ' +
            'keeps its current status (usually awaiting_agent). Repeating it returns the same result. Only the agent that ' +
            'raised it, the overseer of the group its ticket or epic is in, or a person, can acknowledge it.',
          inputSchema: {
            id: ESCALATION_ID,
            note: z.string().max(5000).optional(),
            status: z.enum(LANE_STATUSES).optional(),
            activity: z.string().max(2000).optional(),
            ...PROJECT,
          },
        },
        async ({ id, note, status, activity, project }) => {
          try {
            const target = a.escalation(id, project);
            requireRaiser(store, a, target, 'acknowledge');
            return json(brief(pub.escalation(store.acknowledgeEscalation(target.id, note ?? null, who.name, { status, activity }))));
          } catch (err) {
            return fail(err);
          }
        },
      );

      server.registerTool(
        'reply_to_escalation',
        {
          description:
            `Write in an open escalation's conversation: a short reply after the owner answered Other (a question back, ` +
            `or what you'll do), or a short update while they decide, only when something changed. At most ` +
            `${AGENT_MESSAGE_MAX} characters, plain and to the point: put anything longer in a file and pass its id in ` +
            '`attachments`. Notifies the owner. Only the agent that raised it can reply, or the overseer of the group its ticket or epic is in.',
          inputSchema: {
            id: ESCALATION_ID,
            message: z.string().min(1).max(5000),
            attachments: s.escalationFields.attachments.describe('Ids returned by POST /api/attachments.'),
            ...PROJECT,
          },
        },
        async ({ id, message, attachments, project }) => {
          try {
            const target = a.escalation(id, project);
            requireRaiser(store, a, target, 'reply to');
            return json(
              brief(pub.escalation(store.postMessage(target.id, { from: 'agent', author: who.name, body: message, attachments }, ownerOf(who)))),
            );
          } catch (err) {
            return fail(err);
          }
        },
      );
  }

    server.registerTool(
      'dismiss_escalation',
      {
        description:
          (features.decisions
            ? 'Close an escalation without a dashboard decision: it was answered in your session (Remote Control) or became moot. '
            : 'Close an alert once it is dealt with: the owner answered in your session, or it became moot. ') +
          '`justification` says what was decided and where, for the record (e.g. "Sam: drop the column, in the session"). ' +
          'Pass `status` and `activity` to publish what the lane does next; a lane this unblocks goes back to active. ' +
          'Only the agent that raised it can dismiss it, or the overseer of the group its ticket or epic is in.',
        inputSchema: {
          id: ESCALATION_ID,
          justification: z.string().trim().min(1).max(2000),
          status: z.enum(LANE_STATUSES).optional(),
          activity: z.string().max(2000).optional(),
          ...PROJECT,
        },
      },
      async ({ id, justification, status, activity, project }) => {
        try {
          const target = a.escalation(id, project);
          requireRaiser(store, a, target, 'dismiss');
          return json(brief(pub.escalation(store.dismissEscalation(target.id, justification, who.name, { status, activity }))));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  if (who.role === 'human') {
  if (features.decisions) {
      server.registerTool(
        'decide_escalation',
        {
          description:
            'Record a human decision on an open escalation: "Accept", "Reject" (if offered) or "Other" with instructions in ' +
            '`note` (older escalations may list `options`). With `change: true`, replace the decision on one that is ' +
            'decided but not yet acknowledged by its agent.',
          inputSchema: {
            id: ESCALATION_ID,
            decision: z.string().min(1).max(2000),
            note: z.string().max(5000).optional(),
            change: z.boolean().optional(),
            ...PROJECT,
          },
        },
        async ({ id, decision, note, change, project }) => {
          try {
            const target = a.escalation(id, project).id;
            return json(pub.escalation(store.decideEscalation(target, decision, note ?? null, who.name, change ?? false)));
          } catch (err) {
            return fail(err);
          }
        },
      );
  }

    server.registerTool(
      'dismiss_escalation',
      {
        description: 'Dismiss an escalation that no longer needs an answer, e.g. its agent\'s session ended.',
        inputSchema: { id: ESCALATION_ID, justification: z.string().max(2000).optional(), ...PROJECT },
      },
      async ({ id, justification, project }) => {
        try {
          return json(brief(pub.escalation(store.dismissEscalation(a.escalation(id, project).id, justification?.trim() || null, who.name, {}, false))));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  // tools/list as the SDK builds it, then trimmed (slimSchema). The SDK keeps its handlers in a
  // private map; wrapping the one it registered keeps every other part of the listing its own.
  type Handler = (request: unknown, extra: unknown) => Promise<{ tools: { inputSchema?: unknown }[] }>;
  // If a later SDK keeps them elsewhere, the listing is simply left as the SDK builds it.
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  const list = handlers instanceof Map ? (handlers.get('tools/list') as Handler | undefined) : undefined;
  if (handlers instanceof Map && list) {
    handlers.set('tools/list', async (request: unknown, extra: unknown) => {
      const result = await list(request, extra);
      return { ...result, tools: result.tools.map((t) => ({ ...t, inputSchema: slimSchema(t.inputSchema) })) };
    });
  }
  return server;
}

/** Stateless Streamable HTTP endpoint: a fresh server + transport per request. */
export function mcpHandler(store: Store, features: Features) {
  return async (req: Request, res: Response) => {
    const server = buildServer(store, features, accessFor(store, principalOf(res)), stillValidOf(res), watchRevocationOf(res));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('mcp request failed', { error: String(err) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
}
