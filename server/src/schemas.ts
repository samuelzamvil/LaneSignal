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
});

export const resolution = z.object({
  note: z.string().max(5000).nullable().optional(),
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
    // Reject impossible dates (2026-02-30) instead of letting them roll over.
    const sameDay = v.length !== 10 || new Date(ms).toISOString().slice(0, 10) === v;
    if (Number.isNaN(ms) || !sameDay) {
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
