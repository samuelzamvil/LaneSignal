import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import {
  accessFor,
  brief,
  briefLane,
  briefRequirement,
  briefWait,
  briefMessages,
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
import { AGENT_MESSAGE_MAX, ConflictError, EXPORT_COLUMNS, EXPORT_DATASETS, localId, NotFoundError, type ExportDataset, type RecordResult, type Store } from './store.ts';
import { LANE_STATUSES, type Requirement } from './types.ts';

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

/** Some tools historically say `group`, others `group_id`: both work everywhere. */
const GROUP_FILTER = z.string().max(64).optional().describe('Group (epic/train) id.');
const GROUP_ALIAS = z.string().max(64).optional();

const ID_HELP = 'Escalation id, or its code such as "A12" (or "LS-A12" to name the project too).';

/** Every tool takes it; only keys and people with several projects need it. */
const PROJECT = {
  project: z.string().max(40).optional().describe('Project id/key; only if your key reaches several.'),
};
const PROJECT_WRITE = {
  project: z
    .string()
    .max(40)
    .optional()
    .describe('Project id/key; only if your key reaches several.'),
};

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
  const server = new McpServer({ name: 'lanesignal', version: '0.1.0' }, { capabilities: { logging: {} } });

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
            .map((l) => briefLane(l, features.decisions)),
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
        id: z.string().describe(ID_HELP),
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
    server.registerTool(
      'wait_for_decisions',
      {
        description:
          'Wait for human answers across your group, some lanes, or specific escalations, and return as soon as ' +
          'any of them needs you. Returns `decided` (answered, not yet acknowledged: act on each), `replies` ' +
          '(the owner answered Other: their new messages; act on them and acknowledge, or reply_to_escalation), `closed` ' +
          '(withdrawn by someone else, e.g. "Lane removed by …": the lane was taken off the dashboard, stop work on it; or named ones already ' +
          'acknowledged), `removedLanes` (taken off the dashboard by someone else: stop work on them), `laneMessages` ' +
          '(the owner wrote on lanes in scope, outside any escalation: act on them, answer with notify_owner if useful), `open` (still ' +
          'waiting) and `checkedAt` (pass it as `since` next time). ' +
          '`ready` is false only when the wait ran out with nothing new; call again. Returns at once if something is ' +
          'already decided or nothing is open. Decisions can take hours: loop on this tool, or for long waits in ' +
          'Claude Code run the HTTP version (GET /api/wait) as a background shell command so your session stays free. ' +
          'Default wait 300s; up to 3600s if your MCP client allows calls that long.',
        inputSchema: {
          group_id: s.groupId.optional().describe('Wait on every lane in this group (your epic/train).'),
          group: s.groupId.optional().describe('Same as group_id.'),
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
      async ({ group_id, group, lane_ids, ids, wait_seconds, since, project }, extra) => {
        try {
          const scope = waitScopeFor(a, s.waitScope.parse({ groupId: group_id ?? group, laneIds: lane_ids, ids, since }), project);
          const timeout = wait_seconds ?? 300;
          const { value, revoked } = await cancellable(extra, watchRevocation, (signal) =>
            store.waitForDecisions(scope, timeout * 1000, signal),
          );
          if (revoked || (timeout && !(await stillValid()))) return fail(new Error('Credential revoked'));
          const visible = timeout ? accessFor(store, a.principal).projects : a.projects;
          // A cancelled call never reaches the agent: its notes stay unread.
          if (!extra.signal.aborted) store.handOver(value, visible);
          return json(briefWait(pub.wait(value, timeout ? visible : undefined)));
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
          'lanes, groups, events (status changes and escalation history)' +
          (features.requirements ? ', requirements. ' : '. ') +
          '`from`/`to` (YYYY-MM-DD or ISO) filter ' +
          'escalations, positions, messages, lane_messages, events and requirements by creation time. Results come in pages (default 100 rows, and cut short to stay under ' +
          'about 60 KB); the first line says which rows you got and the offset for the next page. For everything at ' +
          'once as files, the HTTP API serves a zip at GET /api/export.',
        inputSchema: {
          dataset: z.enum(EXPORT_DATASETS.filter((d) => d !== 'requirements' || features.requirements) as [ExportDataset, ...ExportDataset[]]),
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
    const requirementFields = {
      requirement: s.requirementInput.shape.requirement.describe('One normative statement, e.g. "Payouts retry at most 5 times."'),
      justification: s.requirementInput.shape.justification.describe('Why the owner decided it, and where.'),
      tags: s.requirementInput.shape.tags.describe('1-3 specific kebab-case tags, e.g. "payout-retries"; reuse existing ones.'),
      group_id: s.groupId.nullable().optional().describe('Your train/epic; omit for the whole project.'),
      group: s.groupId.nullable().optional(),
      all_projects: z.boolean().optional().describe('Only when the owner said it covers all their projects.'),
      source_escalation: z.string().optional().describe('The escalation code it answered, e.g. "A12".'),
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
    /** The same fields without descriptions, for supersede (described once, on record). */
    const supersedeFields = {
      requirement: s.requirementInput.shape.requirement,
      justification: s.requirementInput.shape.justification,
      tags: s.requirementInput.shape.tags,
      group_id: s.groupId.nullable().optional(),
      group: s.groupId.nullable().optional(),
      all_projects: z.boolean().optional(),
      source_escalation: z.string().optional(),
      decided_by: z.string().max(100).optional(),
    };
    const toInput = (
      args: {
        requirement: string;
        justification: string;
        tags: string[];
        group_id?: string | null;
        group?: string | null;
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
          group: args.group_id !== undefined ? args.group_id : args.group,
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
    const pubRecord = (a: Access, r: RecordResult) =>
      compact({
        requirement: briefRequirement(pub.requirement(r.requirement)),
        duplicate: r.duplicate,
        // Enough to tell whether one is the same decision; get_requirement has the rest.
        similar: r.similar.some(a.sees) ? r.similar.filter(a.sees).map((x) => ({ id: x.id, requirement: x.requirement })) : undefined,
        warnings: r.warnings.length ? r.warnings : undefined,
      });

    server.registerTool(
      'find_requirements',
      {
        description:
          'Search the owner\'s past decisions. Check before escalating a product or scope question; if one answers it, ' +
          'follow it and cite its id. `query` is free text; `tags` must all match; `group_id` adds the train/epic\'s ' +
          'requirements to the project-wide ones. Returns pending and active ones unless you set `statuses`. ' +
          '`status: "pending"` means the owner hasn\'t approved the record yet: follow it, but it may still be corrected.',
        inputSchema: {
          query: z.string().max(500).optional(),
          tags: z.array(s.requirementTag).max(5).optional(),
          group_id: s.groupId.optional(),
          group: GROUP_ALIAS,
          statuses: z.array(z.enum(s.REQUIREMENT_STATUSES)).optional(),
          limit: z.number().int().min(1).max(100).optional(),
          ...PROJECT,
        },
        annotations: { readOnlyHint: true },
      },
      async ({ query, tags, group_id: gid, group: alias, statuses, limit, project }) => {
        try {
          const group_id = checkGroup(gid ?? alias, project);
          const group = group_id ? q(a.pick(project, { group: group_id }), group_id) : undefined;
          return listJson(
            store
              .findRequirements({ query, tags, group, projects: a.scope(project), statuses, limit: limit ?? 20 })
              .map((x) => briefRequirement(pub.requirement(x))),
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
          return json(briefRequirement(pub.requirement(visibleRequirement(id))));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'list_requirement_tags',
      {
        description: 'Tags in use on pending and active requirements, with counts, so you reuse them instead of inventing near-synonyms.',
        inputSchema: { group_id: s.groupId.optional(), group: GROUP_ALIAS, ...PROJECT },
        annotations: { readOnlyHint: true },
      },
      async ({ group_id: gid, group: alias, project }) => {
        try {
          const group_id = checkGroup(gid ?? alias, project);
          return listJson(
            store.requirementTags(group_id ? q(a.pick(project, { group: group_id }), group_id) : undefined, a.scope(project)),
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
          'Record a product decision the owner made (never your own design choice), one per requirement. ' +
          (features.decisions
            ? 'Cite `source_escalation` alone if it was answered on the dashboard; otherwise say who decided (`decided_by`), ' +
              'plus `source_escalation` when it answered an escalation in your session. '
            : 'Say who decided (`decided_by`), plus `source_escalation` when it answered an escalation. ') +
          'Search first so you don\'t ' +
          'record it twice; the same requirement from the same escalation returns the first (`duplicate: true`). ' +
          '`similar` lists ones that read alike: if the owner changed their mind, supersede_requirement the old one. ' +
          'What you record is `pending` until a person approves it.',
        inputSchema: { ...requirementFields, ...PROJECT_WRITE },
      },
      async (args) => {
        try {
          return json(pubRecord(a, store.recordRequirement(toInput(args), who.name, who.role === 'human', ownerOf(who))));
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
          'Fields as in record_requirement; scope defaults to the old one\'s.',
        inputSchema: { id: z.string().describe(REQ_ID_HELP), ...supersedeFields, ...PROJECT_WRITE },
      },
      async ({ id, ...args }) => {
        try {
          const current = visibleRequirement(id);
          return json(pubRecord(a, store.supersedeRequirement(current.id, toInput(args, current), who.name, who.role === 'human', ownerOf(who))));
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
          'Register or update your group (the epic/train you oversee): `name`, `ticket`, and your Remote Control ' +
          'session in `links` with kind "session", so the dashboard links people straight to you.',
        inputSchema: { group_id: s.groupId, ...s.groupPatch.shape, ...PROJECT_WRITE },
      },
      async ({ group_id, project, ...patch }) => {
        try {
          const group = store.upsertGroup(q(a.pick(project, { group: group_id }), group_id), patch, who.name);
          return json({ id: localId(group.id), project: group.project });
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'update_lane',
      {
        description:
          `Publish a lane's state on meaningful changes (not on a timer). Creates it on first call; omitted fields ` +
          `are unchanged. ${STATUS_HELP} \`group\`: your group, registered first with update_group. While a blocking ` +
          'escalation is open the lane stays blocked_human. Tickets look like "gh:42" or "redmine:1234".' +
          (features.decisions
            ? ' Result `ownerMessages`: the owner\'s notes on this lane; act on them.'
            : ''),
        inputSchema: { lane_id: s.laneId, ...s.lanePatch.shape, group_id: s.lanePatch.shape.group, ...PROJECT_WRITE },
      },
      async ({ lane_id, project, group_id, ...rest }) => {
        try {
          const patch = { ...rest, group: rest.group !== undefined ? rest.group : group_id };
          const pr = a.pick(project, { lane: lane_id, group: patch.group ?? undefined });
          const qualified = { ...patch, group: patch.group ? q(pr, patch.group) : patch.group };
          const lane = pub.lane(store.upsertLane(q(pr, lane_id), qualified, who.name));
          const unread = store.takeUnreadForAgent(q(pr, lane_id));
          // Say so when the status was kept, rather than letting it look accepted.
          const warning =
            patch.status && lane.status !== patch.status
              ? `Kept blocked_human: ${lane.blockingEscalations} blocking escalation(s) still open; dismiss them first.`
              : undefined;
          // Where the lane stands, not everything echoed back: this is the most frequent call.
          return json(
            compact({
              id: lane.id,
              project: lane.project,
              letter: lane.letter,
              status: lane.status,
              blockingEscalations: lane.blockingEscalations || undefined,
              warning,
              // The owner wrote on the lane since you last heard: read and act on it (reply with notify_owner).
              ownerMessages: unread.length ? briefMessages(unread) : undefined,
            }),
          );
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
          'it as done instead). Its open escalations are dismissed' +
          (features.decisions ? ' (decided ones can still be acknowledged)' : '') +
          '; its history is kept. Publishing to the same lane id brings it back.',
        inputSchema: { lane_id: s.laneId, ...PROJECT_WRITE },
      },
      async ({ lane_id, project }) => {
        try {
          store.deleteLane(q(a.pick(project, { lane: lane_id }), lane_id), who.name);
          return { content: [{ type: 'text' as const, text: `Lane "${lane_id}" removed` }] };
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
          'Ask the owner: notifies their phone and blocks the lane (`blocking: false` for an FYI). One per decision; ' +
          'the lane must be published first. Write it to be understood from a phone: `question`, `context`, ' +
          '`recommendation`, `cost`, `alternatives`' +
          (features.decisions
            ? '. The owner answers Accept, Reject or Other (with instructions): say in one line each what `accept_means` and ' +
              '`reject_means`, or `allow_reject: false` when rejecting makes no sense. '
            : '. ') +
          'Files (a plan, a screenshot) go in `attachments`: ids from uploading each to /api/attachments. ' +
          'Returns its code (`ref`, e.g. "A12"), usable in every tool. The same open question again returns the first ' +
          '(`duplicate: true`); the same `question` as an open FYI of yours, raised as blocking, makes it block and notifies the owner (`upgraded: true`; fields you give replace the FYI\'s, new attachments are added). ' +
          (features.decisions
            ? 'Then wait with wait_for_decisions and acknowledge_escalation as soon as one is decided.'
            : 'The owner answers in your session, quoting the code; then dismiss_escalation with what they decided.'),
        inputSchema: {
          lane_id: s.laneId,
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
          const input = s.escalationInput.parse({
            laneId: lane_id,
            acceptMeans: accept_means,
            rejectMeans: reject_means,
            allowReject: allow_reject,
            ...rest,
          });
          const pr = a.pick(project, { lane: input.laneId });
          return json(brief(pub.escalation(store.createEscalation({ ...input, laneId: q(pr, input.laneId) }, who.name, ownerOf(who)))));
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
          inputSchema: { id: z.string().describe(ID_HELP), ...s.position.shape, ...PROJECT },
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
            '`decision` and `decisionNote` to act on. On one the owner answered Other, it takes their latest message as ' +
            'the decision (`Other`). ' +
            'A human may correct a mis-tap until you acknowledge. ' +
            'Pass `status` and `activity` to publish what the lane does next in the same call; otherwise the lane ' +
            'keeps its current status (usually awaiting_agent). Repeating it returns the same result. Only the agent that ' +
            'raised the escalation (or a person) can acknowledge it.',
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
            '`attachments`. Notifies the owner. Only the agent that raised the escalation can reply.',
          inputSchema: {
            id: z.string().describe(ID_HELP),
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
          'Only the agent that raised it can dismiss it.',
        inputSchema: {
          id: z.string().describe(ID_HELP),
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
  }

    server.registerTool(
      'dismiss_escalation',
      {
        description: 'Dismiss an escalation that no longer needs an answer, e.g. its agent\'s session ended.',
        inputSchema: { id: z.string().describe(ID_HELP), justification: z.string().max(2000).optional(), ...PROJECT },
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
