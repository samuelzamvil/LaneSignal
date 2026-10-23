import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { accessFor, pub, q, requirementInputFor, waitScopeFor, type Access } from './access.ts';
import { principalOf, stillValidOf, watchRevocationOf } from './auth.ts';
import { log } from './log.ts';
import * as s from './schemas.ts';
import { toCsv } from './export.ts';
import { ConflictError, EXPORT_COLUMNS, EXPORT_DATASETS, NotFoundError, type RecordResult, type Store } from './store.ts';
import { LANE_STATUSES, type Requirement } from './types.ts';

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
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
  'blocked_human = needs a human decision; idle = nothing to do; completed = done.';

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

const ID_HELP = 'Escalation id, or its code such as "A12" (or "LS-A12" to name the project too).';

/** Every tool takes it; only keys and people with several projects need it. */
const PROJECT = {
  project: z
    .string()
    .max(40)
    .optional()
    .describe('Project id or key. Only needed when your credential reaches several projects; lists default to all of them.'),
};

/** Builds an MCP server whose tools act as the authenticated principal, within the projects it may see. */
function buildServer(
  store: Store,
  a: Access,
  stillValid: () => Promise<boolean>,
  watchRevocation: (onInvalid: () => void) => () => void,
) {
  const who = a.principal;
  const listJson = <T>(items: T[]) => json(items);
  const server = new McpServer({ name: 'lanesignal', version: '0.1.0' }, { capabilities: { logging: {} } });

  server.registerTool(
    'list_lanes',
    {
      description: 'List lanes with status, ticket, activity and open escalation counts, optionally for one group.',
      inputSchema: { status: z.enum(LANE_STATUSES).optional(), group: z.string().optional(), ...PROJECT },
      annotations: { readOnlyHint: true },
    },
    async ({ status, group, project }) => {
      try {
        return listJson(
          store
            .listLanes(a.scope(project))
            .map(pub.lane)
            .filter((l) => (!status || l.status === status) && (!group || l.group === group)),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_projects',
    {
      description:
        'List the projects your credential can reach (id, key, name). Each project has its own groups, lanes and ' +
        'escalations; pass `project` (id or key) to other tools when you can reach more than one.',
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
      description: 'List escalations. Defaults to unresolved ones (open and decided-but-unacknowledged).',
      inputSchema: {
        lane_id: z.string().optional(),
        states: z.array(z.enum(['open', 'decided', 'acknowledged', 'withdrawn'])).optional(),
        ...PROJECT,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ lane_id, states, project }) => {
      try {
        const laneId = lane_id ? q(a.pick(project), lane_id) : undefined;
        return listJson(store.listEscalations({ laneId, states, projects: a.scope(project) }).map(pub.escalation));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_escalation',
    {
      description:
        'Get one escalation. Pass wait_seconds to block until a human decides (long-poll, max 300). ' +
        'To wait on several escalations, lanes or your whole group at once, use wait_for_decisions.',
      inputSchema: { id: z.string().describe(ID_HELP), wait_seconds: z.number().int().min(0).max(300).optional(), ...PROJECT },
      annotations: { readOnlyHint: true },
    },
    async ({ id, wait_seconds, project }, extra) => {
      try {
        const target = a.escalation(id, project);
        const { value, revoked } = await cancellable(extra, watchRevocation, (signal) =>
          store.waitForDecision(target.id, (wait_seconds ?? 0) * 1000, signal),
        );
        if (revoked || (wait_seconds && !(await stillValid()))) return fail(new Error('Credential revoked'));
        if (wait_seconds && !accessFor(store, a.principal).projects.includes(value.project)) {
          return fail(new NotFoundError(`Escalation "${id}" not found`));
        }
        return json(pub.escalation(value));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'wait_for_decisions',
    {
      description:
        'Wait for human answers across your group, some lanes, or specific escalations, and return as soon as ' +
        'any of them needs you. Returns `decided` (answered, not yet acknowledged: act on each), `closed` ' +
        '(withdrawn by someone else, e.g. "Lane removed by …": the lane was taken off the dashboard, stop work on it; or named ones already ' +
        'acknowledged), `removedLanes` (taken off the dashboard by someone else: stop work on them), `open` (still ' +
        'waiting) and `checkedAt` (pass it as `since` next time). ' +
        '`ready` is false only when the wait ran out with nothing new; call again. Returns at once if something is ' +
        'already decided or nothing is open. Decisions can take hours: loop on this tool, or for long waits in ' +
        'Claude Code run the HTTP version (GET /api/wait) as a background shell command so your session stays free. ' +
        'Default wait 300s; up to 3600s if your MCP client allows calls that long.',
      inputSchema: {
        group_id: s.groupId.optional().describe('Wait on every lane in this group (your epic/train).'),
        lane_ids: z.array(s.laneId).max(100).optional(),
        ids: z.array(z.string()).max(100).optional().describe('Escalation ids or codes such as "A12".'),
        wait_seconds: z.number().int().min(0).max(3600).optional(),
        since: z
          .string()
          .optional()
          .describe('Pass the previous result\'s `checkedAt` so withdrawals between calls are still reported.'),
        ...PROJECT,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ group_id, lane_ids, ids, wait_seconds, since, project }, extra) => {
      try {
        const scope = waitScopeFor(a, s.waitScope.parse({ groupId: group_id, laneIds: lane_ids, ids, since }), project);
        const timeout = wait_seconds ?? 300;
        const { value, revoked } = await cancellable(extra, watchRevocation, (signal) =>
          store.waitForDecisions(scope, timeout * 1000, signal),
        );
        if (revoked || (timeout && !(await stillValid()))) return fail(new Error('Credential revoked'));
        return json(pub.wait(value, timeout ? accessFor(store, a.principal).projects : undefined));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'export_data',
    {
      description:
        'Export LaneSignal data for analysis, including closed escalations and archived lanes. Datasets: ' +
        'escalations (one row each, with decision timings and position counts), positions (agent stances), ' +
        'lanes, groups, events (status changes and escalation history), requirements (the owner\'s product decisions). ' +
        '`from`/`to` (YYYY-MM-DD or ISO) filter ' +
        'escalations, positions, events and requirements (by creation time). Results come in pages (default 100 rows, and cut short to stay under ' +
        'about 60 KB); the first line says which rows you got and the offset for the next page. For everything at ' +
        'once as files, the HTTP API serves a zip at GET /api/export.',
      inputSchema: {
        dataset: z.enum(EXPORT_DATASETS),
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
          laneId: f.lane ? q(a.pick(project), f.lane) : undefined,
          projects: a.scope(project),
        });
        const start = offset ?? 0;
        let page = rows.slice(start, start + (limit ?? 100));
        const render = (p: typeof page) =>
          format === 'json' ? JSON.stringify(p, null, 2) : toCsv(p, [...EXPORT_COLUMNS[dataset]]);
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

  // ---- requirements: the owner's product decisions, for every role ----

  const REQ_ID_HELP = 'Requirement id, e.g. "R14".';
  const requirementFields = {
    requirement: s.requirementInput.shape.requirement.describe(
      'One normative statement of what the product must (not) do, e.g. "Payout jobs retry at most 5 times, then go to the dead-letter queue."',
    ),
    justification: s.requirementInput.shape.justification.describe(
      'Why the owner decided it, and where (escalation, ticket, conversation), so nobody has to investigate later.',
    ),
    tags: s.requirementInput.shape.tags.describe(
      '1-3 specific kebab-case tags naming the capability, e.g. "payout-retries". Broad tags like "backend" are rejected. ' +
        'Reuse existing tags (list_requirement_tags) rather than inventing synonyms.',
    ),
    group_id: s.groupId
      .nullable()
      .optional()
      .describe('The train/epic it belongs to; omit for a requirement covering the whole project.'),
    all_projects: z
      .boolean()
      .optional()
      .describe('An owner-wide rule that applies to every project (e.g. "all apps store money as integers").'),
    source_escalation: z
      .string()
      .optional()
      .describe('The answered escalation the owner decided this in (e.g. "A12"); its decider is recorded.'),
    decided_by: z
      .string()
      .max(100)
      .optional()
      .describe('Without an escalation: the person who decided, e.g. "Sam (Remote Control, 2026-10-23)".'),
  };
  const toInput = (
    args: {
      requirement: string;
      justification: string;
      tags: string[];
      group_id?: string | null;
      source_escalation?: string;
      decided_by?: string;
      all_projects?: boolean;
      project?: string;
    },
    current?: Requirement,
  ) =>
    requirementInputFor(
      a,
      s.requirementInput.parse({
        requirement: args.requirement,
        justification: args.justification,
        tags: args.tags,
        group: args.group_id,
        sourceEscalation: args.source_escalation,
        decidedBy: args.decided_by,
        allProjects: args.all_projects,
      }),
      args.project,
      current,
    );
  /** A requirement the caller may see: one for all projects, or one of the caller's projects. */
  const visibleRequirement = (id: string) => {
    const found = store.getRequirement(id);
    if (!found || (found.project !== null && !a.projects.includes(found.project))) {
      throw new NotFoundError(`Requirement "${id}" not found`);
    }
    return found;
  };
  /** Similar requirements are only those the caller may see. */
  const pubRecord = (a: Access, r: RecordResult) => ({
    ...r,
    requirement: pub.requirement(r.requirement),
    similar: r.similar.filter(a.sees).map(pub.requirement),
  });

  server.registerTool(
    'find_requirements',
    {
      description:
        'Search the product requirements: decisions the owner already made, with why. Check here before escalating a ' +
        'product or scope question; if a requirement answers it, follow it and cite its id instead of asking again. ' +
        '`query` is free text (best matches first); `tags` must all match; `group_id` limits to that train/epic plus ' +
        'requirements for its whole project. Requirements for all projects are always included. Active ones only ' +
        'unless you set `statuses`.',
      inputSchema: {
        query: z.string().max(500).optional(),
        tags: z.array(s.requirementTag).max(5).optional(),
        group_id: s.groupId.optional(),
        statuses: z.array(z.enum(['active', 'superseded', 'retired'])).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        ...PROJECT,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, tags, group_id, statuses, limit, project }) => {
      try {
        const group = group_id ? q(a.pick(project), group_id) : undefined;
        return listJson(
          store
            .findRequirements({ query, tags, group, projects: a.scope(project), statuses, limit: limit ?? 20 })
            .map(pub.requirement),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_requirement',
    {
      description: 'Read one requirement, including what superseded it if it is no longer active.',
      inputSchema: { id: z.string().describe(REQ_ID_HELP) },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        return json(pub.requirement(visibleRequirement(id)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_requirement_tags',
    {
      description: 'Tags in use on active requirements, with counts, so you reuse them instead of inventing near-synonyms.',
      inputSchema: { group_id: s.groupId.optional(), ...PROJECT },
      annotations: { readOnlyHint: true },
    },
    async ({ group_id, project }) => {
      try {
        return listJson(store.requirementTags(group_id ? q(a.pick(project), group_id) : undefined, a.scope(project)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'record_requirement',
    {
      description:
        'Record a product decision the owner (a human) made, so it can be found later without digging through tickets. ' +
        'Only record decisions a person made: cite the answered escalation (`source_escalation`) or name who decided ' +
        '(`decided_by`). Never record your own design choices as requirements. One decision per requirement. ' +
        'The result lists `similar` active requirements: if one is the same decision, it was a duplicate; if the owner ' +
        'changed their mind, use supersede_requirement on the old one instead.',
      inputSchema: { ...requirementFields, ...PROJECT },
    },
    async (args) => {
      try {
        return json(pubRecord(a, store.recordRequirement(toInput(args), who.name, who.role === 'human')));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'supersede_requirement',
    {
      description:
        'The owner changed a decision: record the new requirement and mark the old one superseded (it stays, so the ' +
        'history of why is kept). Same fields as record_requirement; its scope (project, group) defaults to the old one\'s.',
      inputSchema: { id: z.string().describe(REQ_ID_HELP), ...requirementFields, ...PROJECT },
    },
    async ({ id, ...args }) => {
      try {
        const current = visibleRequirement(id);
        return json(pubRecord(a, store.supersedeRequirement(current.id, toInput(args, current), who.name, who.role === 'human')));
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (who.role === 'agent') {
    server.registerTool(
      'update_group',
      {
        description:
          'Overseers: describe the group (epic/train) whose lanes you run. One overseer session owns one group; ' +
          'name it after the epic or train, set `ticket` to its ticket, and put your Remote Control session in `links` ' +
          'with kind "session" so humans can reach you. Lanes join a group via update_lane(group).',
        inputSchema: { group_id: s.groupId, ...s.groupPatch.shape, ...PROJECT },
      },
      async ({ group_id, project, ...patch }) => {
        try {
          return json(pub.group(store.upsertGroup(q(a.pick(project), group_id), patch, who.name)));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'update_lane',
      {
        description:
          `Publish this lane's current state. Creates the lane on first call; omitted fields are unchanged. ${STATUS_HELP} ` +
          'Set `group` to the id of the epic/train group (your overseer) the lane belongs to. ' +
          'Ticket refs look like "redmine:1234", "gh:42" or a plain id for the default system. ' +
          'Call this on meaningful state changes, not on a timer.',
        inputSchema: { lane_id: s.laneId, ...s.lanePatch.shape, ...PROJECT },
      },
      async ({ lane_id, project, ...patch }) => {
        try {
          const pr = a.pick(project);
          const qualified = { ...patch, group: patch.group ? q(pr, patch.group) : patch.group };
          return json(pub.lane(store.upsertLane(q(pr, lane_id), qualified, who.name)));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'remove_lane',
      {
        description:
          'Take a lane off the dashboard when its work stream is over (use update_lane status "completed" to show ' +
          'it as done instead). Its unanswered escalations are withdrawn, decided ones can still be acknowledged, ' +
          'and its history stays for export. Publishing to the same lane id later brings it back.',
        inputSchema: { lane_id: s.laneId, ...PROJECT },
      },
      async ({ lane_id, project }) => {
        try {
          store.deleteLane(q(a.pick(project), lane_id), who.name);
          return { content: [{ type: 'text' as const, text: `Lane "${lane_id}" removed` }] };
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'create_escalation',
      {
        description:
          'Ask the humans for a decision. Shows prominently on the dashboard and sends a push notification. ' +
          'Structure: `question` (the decision, phrased as a question), `context` (what a human needs to know, without ' +
          'opening your session), `recommendation` (what you would do and why), `cost` (what the recommendation costs), ' +
          '`alternatives` (other paths, each with its tradeoff), and `positions` (other agents\' agreement/disagreement ' +
          'with the recommendation, e.g. a reviewer). Set `ticket` to what the question is about (e.g. "gh:921") when it ' +
          'differs from the lane ticket. Provide short `options` for one-tap answers and set `recommended_option` to the ' +
          'one you recommend. A lane may have several open escalations; raise one per decision. ' +
          'By default marks the lane blocked_human until all are decided; set `blocking: false` for FYI questions ' +
          'you can keep working around. Each escalation gets a code (`ref`, e.g. "A12": the lane\'s letter and a number) ' +
          'that you and the humans can use to refer to it, including in this server\'s tools. Retrying the same question on the same ' +
          'lane while it is open returns the existing escalation (`duplicate: true`). ' +
          'Then wait with wait_for_decisions and call acknowledge_escalation as soon as one is decided.',
        inputSchema: {
          lane_id: s.laneId,
          question: s.escalationFields.question,
          context: s.escalationFields.context,
          recommendation: s.escalationFields.recommendation,
          recommended_option: s.escalationFields.recommendedOption,
          cost: s.escalationFields.cost,
          alternatives: s.escalationFields.alternatives,
          ticket: s.escalationFields.ticket,
          positions: s.escalationFields.positions,
          options: s.escalationFields.options,
          links: s.escalationFields.links,
          blocking: s.escalationFields.blocking,
          ...PROJECT,
        },
      },
      async ({ lane_id, recommended_option, project, ...rest }) => {
        try {
          const input = s.escalationInput.parse({ laneId: lane_id, recommendedOption: recommended_option, ...rest });
          return json(pub.escalation(store.createEscalation({ ...input, laneId: q(a.pick(project), input.laneId) }, who.name)));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'add_position',
      {
        description:
          'Record whether you agree or disagree with an open escalation\'s recommendation, with a short reason. ' +
          'One position per agent; calling again replaces yours. Use `agent` to name yourself if you share a token.',
        inputSchema: { id: z.string().describe(ID_HELP), ...s.position.shape, ...PROJECT },
      },
      async ({ id, agent, project, ...rest }) => {
        try {
          const target = a.escalation(id, project).id;
          return json(pub.escalation(store.addPosition(target, { ...rest, agent: agent ?? who.name }, who.name)));
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
          '`decision` and `decisionNote` to act on (a human may correct a mis-tap until you acknowledge). ' +
          'Pass `status` and `activity` to publish what the lane does next in the same call; otherwise the lane ' +
          'keeps its current status (usually awaiting_agent). Repeating it returns the same result.',
        inputSchema: {
          id: z.string().describe(ID_HELP),
          note: z.string().max(5000).optional(),
          status: z.enum(LANE_STATUSES).optional(),
          activity: z.string().max(2000).optional(),
          ...PROJECT,
        },
      },
      async ({ id, note, status, activity, project }) => {
        try {
          const target = a.escalation(id, project).id;
          return json(pub.escalation(store.acknowledgeEscalation(target, note ?? null, who.name, { status, activity })));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'withdraw_escalation',
      {
        description:
          'Close an escalation that no longer needs a dashboard decision, e.g. it was answered in Remote Control or became moot.',
        inputSchema: { id: z.string().describe(ID_HELP), resolution: z.string().max(5000).optional(), ...PROJECT },
      },
      async ({ id, resolution, project }) => {
        try {
          return json(pub.escalation(store.withdrawEscalation(a.escalation(id, project).id, resolution ?? null, who.name)));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  if (who.role === 'human') {
    server.registerTool(
      'decide_escalation',
      {
        description:
          'Record a human decision on an open escalation. With `change: true`, replace the decision on one that is ' +
          'decided but not yet acknowledged by its agent.',
        inputSchema: {
          id: z.string().describe(ID_HELP),
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

    server.registerTool(
      'withdraw_escalation',
      {
        description: 'Dismiss an escalation that no longer needs an answer.',
        inputSchema: { id: z.string().describe(ID_HELP), resolution: z.string().max(5000).optional(), ...PROJECT },
      },
      async ({ id, resolution, project }) => {
        try {
          return json(pub.escalation(store.withdrawEscalation(a.escalation(id, project).id, resolution ?? null, who.name)));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  return server;
}

/** Stateless Streamable HTTP endpoint: a fresh server + transport per request. */
export function mcpHandler(store: Store) {
  return async (req: Request, res: Response) => {
    const server = buildServer(store, accessFor(store, principalOf(res)), stillValidOf(res), watchRevocationOf(res));
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
