import { z } from 'zod';
import { AGENT_MESSAGE_MAX } from './store.ts';
import { LANE_STATUSES, STANCES, TICKET_STATES } from './types.ts';

export const laneId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:-]+$/, 'lane ids may contain letters, digits, . _ : -');

export const link = z.object({
  label: z.string().min(1).max(100),
  url: z.url({ protocol: /^https?$/ }),
  kind: z.string().max(30).optional(),
});

/** Group ids follow the lane id format, e.g. "payments-epic" or "train-42". */
export const groupId = laneId;

export const groupPatch = z.object({
  name: z.string().min(1).max(200).optional(),
  ticket: z.string().max(300).nullable().optional(),
  links: z.array(link).max(20).optional(),
});

export const lanePatch = z.object({
  name: z.string().min(1).max(200).optional(),
  group: groupId.nullable().optional(),
  status: z.enum(LANE_STATUSES).optional(),
  ticket: z.string().max(300).nullable().optional(),
  activity: z.string().max(2000).nullable().optional(),
  links: z.array(link).max(20).optional(),
});

/** What happens to the ticket a lane lets go of. */
export const ticketRelease = z.enum(['park', 'done', 'drop']);

/** How a lane changes tickets, on top of a lane's fields (PUT /api/lanes/:id/fill). */
export const laneFill = lanePatch.extend({
  previous: ticketRelease.optional(),
  reason: z.string().max(500).nullable().optional(),
  waitingOn: z.string().max(300).nullable().optional(),
});

export const ticketQuery = z
  .object({
    group: groupId.optional(),
    state: z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(z.enum(TICKET_STATES)).max(4)).optional(),
    project: z.string().max(40).optional(),
  })
  .strict();

export const position = z.object({
  /** Defaults to the caller's token name. */
  agent: z.string().min(1).max(100).optional(),
  stance: z.enum(STANCES),
  note: z.string().max(5000).nullable().optional(),
});

export const escalationFields = {
  laneId,
  question: z.string().min(1).max(1000),
  context: z.string().max(20_000).nullable().optional(),
  recommendation: z.string().max(10_000).nullable().optional(),
  recommendedOption: z.string().max(200).nullable().optional(),
  cost: z.string().max(5000).nullable().optional(),
  alternatives: z.array(z.string().min(1).max(5000)).max(10).optional(),
  ticket: z.string().max(300).nullable().optional(),
  positions: z.array(position.required({ agent: true })).max(20).optional(),
  options: z.array(z.string().min(1).max(200)).max(10).optional(),
  acceptMeans: z.string().trim().min(1).max(200).nullable().optional(),
  rejectMeans: z.string().trim().min(1).max(200).nullable().optional(),
  allowReject: z.boolean().optional(),
  attachments: z.array(z.string().min(1).max(64)).max(20).optional(),
  links: z.array(link).max(20).optional(),
  blocking: z.boolean().optional(),
};

/** The agent's message on a lane: a quiet phone notification, with any files. */
export const notice = z.object({
  message: z.string().trim().min(1).max(AGENT_MESSAGE_MAX),
  attachments: z.array(z.string().min(1).max(64)).max(20).optional(),
});

export const escalationInput = z
  .object(escalationFields)
  .refine((e) => !e.recommendedOption || (e.options ?? []).includes(e.recommendedOption), {
    message: 'recommendedOption must be one of options',
    path: ['recommendedOption'],
  });

export const decision = z.object({
  decision: z.string().min(1).max(2000),
  note: z.string().max(5000).nullable().optional(),
  /** Replace the answer on a decided escalation the agent hasn't acknowledged yet. */
  change: z.boolean().optional(),
});

/** A message in an escalation's conversation (length limits depend on who writes it). */
export const message = z.object({
  body: z.string().max(5000),
  attachments: z.array(z.string().min(1).max(64)).max(20).optional(),
});

/** GET /api/history */
export const historyQuery = z.object({
  q: z.string().max(200).optional(),
  project: z.string().max(64).optional(),
  group: z.string().max(64).optional(),
  outcome: z.enum(['all', 'answered', 'dismissed']).optional(),
  before_at: z.string().max(40).optional(),
  before_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const resolution = z.object({
  note: z.string().max(5000).nullable().optional(),
});

/** Acknowledging can publish the lane's next state in the same call. */
export const acknowledgement = resolution.extend({
  status: z.enum(LANE_STATUSES).optional(),
  activity: z.string().max(2000).nullable().optional(),
});

const password = z.string().min(10).max(128);

export const setupInput = z.object({
  email: z.email(),
  name: z.string().min(1).max(100),
  password,
  /** One-time code from the server log; not needed with a static human token. */
  code: z.string().max(100).optional(),
});

export const personInput = z.object({
  email: z.email(),
  name: z.string().min(1).max(100),
  password,
  admin: z.boolean().optional(),
});

export const passwordReset = z.object({ email: z.email(), password });

/**
 * A date (2026-10-01, taken as 00:00 UTC) or an ISO timestamp with a zone
 * (Z or ±hh:mm), so nothing depends on the server's local time zone.
 */
const instant = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/,
    'use YYYY-MM-DD or an ISO timestamp with a zone, e.g. 2026-10-01T09:00:00Z',
  )
  .transform((v, ctx) => {
    const ms = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
    // Reject impossible dates (2026-13-01, 2026-02-30) instead of letting them roll over.
    if (Number.isNaN(ms) || (v.length === 10 && new Date(ms).toISOString().slice(0, 10) !== v)) {
      ctx.addIssue({ code: 'custom', message: 'not a valid date' });
      return z.NEVER;
    }
    return new Date(ms).toISOString();
  });

export const exportFilter = z
  .object({
    from: instant.optional(),
    to: instant.optional(),
    lane: z.string().max(100).optional(),
    project: z.string().max(40).optional(),
  })
  // Unknown parameters (e.g. a misspelt filter) are errors, not silently ignored.
  .strict()
  .refine((f) => !f.from || !f.to || f.from < f.to, { message: '`from` must be before `to`', path: ['from'] });

export const pushRegistration = z.object({
  token: z.string().min(10).max(4096),
  platform: z.enum(['android', 'ios', 'web']).default('android'),
});

/** Escalation ids or codes ("A12"). */
const idList = z.array(z.string().min(1).max(100)).max(100);

/** Longest single wait. The server sends keepalive bytes while it waits, so proxies don't cut it off. */
export const MAX_WAIT_SECONDS = 86_400;

export const waitScope = z
  .object({
    ids: idList.optional(),
    laneIds: z.array(laneId).max(100).optional(),
    groupId: groupId.optional(),
    since: instant.optional(),
  })
  .refine((w) => w.ids?.length || w.laneIds?.length || w.groupId, {
    message: 'say what to wait on: group_id (MCP; `group` over HTTP), lane_ids (`lane`) or ids',
  });

const csv = (v: unknown) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v);

/** GET /api/wait query: ?group=&lane=a,b&ids=1,2&timeout=seconds&since=iso */
export const waitQuery = z
  .object({
    group: groupId.optional(),
    lane: z.preprocess(csv, z.array(laneId).max(100)).optional(),
    ids: z.preprocess(csv, idList).optional(),
    timeout: z.coerce.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
    since: z.string().max(40).optional(),
    project: z.string().max(40).optional(),
    format: z.enum(['digest', 'full']).optional(),
  })
  .strict();

// ---- requirements ----

/** Specific, kebab-case: "payout-retries", not "backend". */
export const requirementTag = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/, 'tags are kebab-case words, e.g. "payout-retries"');

/** Lowercased and de-duplicated before the 1-3 limit applies. */
const requirementTags = z.preprocess(
  (v) => (Array.isArray(v) ? [...new Set(v.map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : t)))] : v),
  z.array(requirementTag).min(1).max(3),
);

/** Requirements are read by agents again and again: short ones keep that cheap. */
export const REQUIREMENT_MAX = 300;
export const JUSTIFICATION_MAX = 800;

export const requirementInput = z.object({
  requirement: z.string().trim().min(1).max(REQUIREMENT_MAX),
  justification: z.string().trim().min(1).max(JUSTIFICATION_MAX),
  tags: requirementTags,
  /** Group (train/epic) id; omit or null for a product-wide requirement. */
  group: groupId.nullable().optional(),
  /** Answered escalation the owner decided this in (id or code like "A12"). */
  sourceEscalation: z.string().min(1).max(100).nullable().optional(),
  /** Who decided, when there's no escalation, e.g. "Sam (Remote Control, 2026-10-23)". */
  decidedBy: z.string().trim().min(1).max(100).nullable().optional(),
  /** An owner-wide rule that applies to every project, rather than to the request's project. */
  allProjects: z.boolean().optional(),
})
  // Unknown fields (e.g. group_id instead of group) are errors, not silently ignored.
  .strict();

export const requirementEdit = z
  .object({
    requirement: z.string().trim().min(1).max(REQUIREMENT_MAX).optional(),
    justification: z.string().trim().min(1).max(JUSTIFICATION_MAX).optional(),
    tags: requirementTags.optional(),
  })
  .strict();

export const REQUIREMENT_STATUSES = ['pending', 'active', 'superseded', 'retired'] as const;

/** GET /api/requirements: ?q=&tag=a,b&group=&status=pending,active,superseded&limit= */
export const requirementQuery = z
  .object({
    q: z.string().max(500).optional(),
    tag: z.preprocess(csv, z.array(requirementTag).max(5)).optional(),
    group: groupId.optional(),
    status: z.preprocess(csv, z.array(z.enum(REQUIREMENT_STATUSES)).min(1)).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    project: z.string().max(40).optional(),
  })
  .strict();

// ---- projects ----

export const projectId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'project ids are lowercase letters, digits and dashes, e.g. "lanesignal"');

/** Shown before escalation codes where projects mix: "LS·A12". */
export const projectKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, 'project keys are 2-10 letters or digits, starting with a letter, e.g. "LS"');

export const projectInput = z.object({ id: projectId, key: projectKey, name: z.string().trim().min(1).max(100) }).strict();
export const projectPatch = z.object({ key: projectKey.optional(), name: z.string().trim().min(1).max(100).optional() }).strict();
export const memberInput = z.object({ role: z.enum(['admin', 'member']) }).strict();
export const notifyInput = z.object({ enabled: z.boolean() }).strict();
/** A project's TRMNL screen. The webhook URL and `plus` may be left out to keep the saved ones. */
export const trmnlInput = z
  .object({
    webhookUrl: z.string().trim().min(1).max(500).optional(),
    enabled: z.boolean(),
    includeNotifications: z.boolean(),
    plus: z.boolean().optional(),
  })
  .strict();
export const pushSettings = z.object({ quietAlerts: z.boolean() }).strict();

