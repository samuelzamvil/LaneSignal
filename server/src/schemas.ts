import { z } from 'zod';
import { LANE_STATUSES } from './types.ts';

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

export const lanePatch = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.string().max(60).nullable().optional(),
  status: z.enum(LANE_STATUSES).optional(),
  ticket: z.string().max(300).nullable().optional(),
  activity: z.string().max(2000).nullable().optional(),
  links: z.array(link).max(20).optional(),
});

export const escalationInput = z.object({
  laneId,
  title: z.string().min(1).max(300),
  body: z.string().max(10_000).nullable().optional(),
  options: z.array(z.string().min(1).max(200)).max(10).optional(),
  links: z.array(link).max(20).optional(),
  blocking: z.boolean().optional(),
});

export const decision = z.object({
  decision: z.string().min(1).max(2000),
  note: z.string().max(5000).nullable().optional(),
});

export const resolution = z.object({
  note: z.string().max(5000).nullable().optional(),
});

export const pushRegistration = z.object({
  token: z.string().min(10).max(4096),
  platform: z.enum(['android', 'ios', 'web']).default('android'),
});
