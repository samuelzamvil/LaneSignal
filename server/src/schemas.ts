import { z } from 'zod';
import { LANE_STATUSES, STANCES } from './types.ts';

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
  links: z.array(link).max(20).optional(),
  blocking: z.boolean().optional(),
};

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
    message: 'give a group, lanes, or escalation ids to wait on',
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

export const requirementInput = z.object({
  requirement: z.string().trim().min(1).max(2000),
  justification: z.string().trim().min(1).max(5000),
  tags: requirementTags,
  /** Group (train/epic) id; omit or null for a product-wide requirement. */
  group: groupId.nullable().optional(),
  /** Answered escalation the owner decided this in (id or code like "A12"). */
  sourceEscalation: z.string().min(1).max(100).nullable().optional(),
  /** Who decided, when there's no escalation, e.g. "Sam (Remote Control, 2026-10-23)". */
  decidedBy: z.string().trim().min(1).max(100).nullable().optional(),
})
  // Unknown fields (e.g. group_id instead of group) are errors, not silently ignored.
  .strict();

export const requirementEdit = z
  .object({
    requirement: z.string().trim().min(1).max(2000).optional(),
    justification: z.string().trim().min(1).max(5000).optional(),
    tags: requirementTags.optional(),
  })
  .strict();

const REQUIREMENT_STATUSES = ['active', 'superseded', 'retired'] as const;

/** GET /api/requirements: ?q=&tag=a,b&group=&status=active,superseded&limit= */
export const requirementQuery = z
  .object({
    q: z.string().max(500).optional(),
    tag: z.preprocess(csv, z.array(requirementTag).max(5)).optional(),
    group: groupId.optional(),
    status: z.preprocess(csv, z.array(z.enum(REQUIREMENT_STATUSES)).min(1)).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

