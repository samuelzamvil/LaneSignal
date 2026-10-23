import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { principalOf } from './auth.ts';
import { log } from './log.ts';
import * as s from './schemas.ts';
import { ConflictError, NotFoundError, type Store } from './store.ts';
import { LANE_STATUSES, type Principal } from './types.ts';

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => {
  if (err instanceof NotFoundError || err instanceof ConflictError || err instanceof Error) {
    return { isError: true, content: [{ type: 'text' as const, text: err.message }] };
  }
  throw err;
};

const STATUS_HELP =
  'active = working; pending_ci = waiting on CI; awaiting_agent = waiting on another agent; ' +
  'blocked_human = needs a human decision; idle = nothing to do; completed = done.';

/** Builds an MCP server whose tools act as the authenticated principal. */
function buildServer(store: Store, who: Principal) {
  const server = new McpServer({ name: 'lanesignal', version: '0.1.0' });

  server.registerTool(
    'list_lanes',
    {
      description: 'List lanes with status, ticket, activity and open escalation counts.',
      inputSchema: { status: z.enum(LANE_STATUSES).optional(), category: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status, category }) =>
      json(store.listLanes().filter((l) => (!status || l.status === status) && (!category || l.category === category))),
  );

  server.registerTool(
    'list_escalations',
    {
      description: 'List escalations. Defaults to unresolved ones (open and decided-but-unacknowledged).',
      inputSchema: {
        lane_id: z.string().optional(),
        states: z.array(z.enum(['open', 'decided', 'acknowledged', 'withdrawn'])).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ lane_id, states }) => json(store.listEscalations({ laneId: lane_id, states })),
  );

  server.registerTool(
    'get_escalation',
    {
      description:
        'Get one escalation. Pass wait_seconds to block until a human decides (long-poll, max 300) instead of polling repeatedly.',
      inputSchema: { id: z.string(), wait_seconds: z.number().int().min(0).max(300).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ id, wait_seconds }, extra) => {
      try {
        return json(await store.waitForDecision(id, (wait_seconds ?? 0) * 1000, extra.signal));
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (who.role === 'agent') {
    server.registerTool(
      'update_lane',
      {
        description:
          `Publish this lane's current state. Creates the lane on first call; omitted fields are unchanged. ${STATUS_HELP} ` +
          'Ticket refs look like "redmine:1234", "gh:42" or a plain id for the default system. ' +
          'Call this on meaningful state changes, not on a timer.',
        inputSchema: { lane_id: s.laneId, ...s.lanePatch.shape },
      },
      async ({ lane_id, ...patch }) => {
        try {
          return json(store.upsertLane(lane_id, patch, who.name));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'create_escalation',
      {
        description:
          'Ask the human overseers for a decision. Shows prominently on the dashboard and sends a push notification. ' +
          'Structure: `context` (what a human needs to know, without opening your session), `question` (the decision, ' +
          'phrased as a question), `recommendation` (what you would do and why), and `positions` (other agents\' ' +
          'agreement/disagreement with the recommendation, if already known). Provide short `options` for one-tap answers ' +
          'and set `recommended_option` to the one you recommend. By default marks the lane blocked_human. ' +
          'Then wait with get_escalation(wait_seconds) and acknowledge_escalation once you act on the decision.',
        inputSchema: {
          lane_id: s.laneId,
          question: s.escalationFields.question,
          context: s.escalationFields.context,
          recommendation: s.escalationFields.recommendation,
          recommended_option: s.escalationFields.recommendedOption,
          positions: s.escalationFields.positions,
          options: s.escalationFields.options,
          links: s.escalationFields.links,
          blocking: s.escalationFields.blocking,
        },
      },
      async ({ lane_id, recommended_option, ...rest }) => {
        try {
          const input = s.escalationInput.parse({ laneId: lane_id, recommendedOption: recommended_option, ...rest });
          return json(store.createEscalation(input, who.name));
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
        inputSchema: { id: z.string(), ...s.position.shape },
      },
      async ({ id, agent, ...rest }) => {
        try {
          return json(store.addPosition(id, { ...rest, agent: agent ?? who.name }, who.name));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      'acknowledge_escalation',
      {
        description: 'Confirm you received and are acting on a decided escalation. Closes it.',
        inputSchema: { id: z.string(), note: z.string().max(5000).optional() },
      },
      async ({ id, note }) => {
        try {
          return json(store.acknowledgeEscalation(id, note ?? null, who.name));
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
        inputSchema: { id: z.string(), resolution: z.string().max(5000).optional() },
      },
      async ({ id, resolution }) => {
        try {
          return json(store.withdrawEscalation(id, resolution ?? null, who.name));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  if (who.role === 'overseer') {
    server.registerTool(
      'decide_escalation',
      {
        description: 'Record a human decision on an open escalation.',
        inputSchema: { id: z.string(), decision: z.string().min(1).max(2000), note: z.string().max(5000).optional() },
      },
      async ({ id, decision, note }) => {
        try {
          return json(store.decideEscalation(id, decision, note ?? null, who.name));
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
    const server = buildServer(store, principalOf(res));
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
