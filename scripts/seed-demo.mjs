// Publishes a handful of demo lanes and escalations through the public API.
// Usage: LANESIGNAL_URL=http://localhost:8080 LANESIGNAL_TOKEN=<agent token> node scripts/seed-demo.mjs
const base = process.env.LANESIGNAL_URL ?? 'http://localhost:8080';
const token = process.env.LANESIGNAL_TOKEN;
if (!token) throw new Error('LANESIGNAL_TOKEN (agent token) is required');

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// One overseer session per epic/train; each runs several lanes.
await call('PUT', '/api/groups/payments-epic', {
  name: 'Payments epic',
  ticket: 'redmine:4700',
  links: [{ label: 'Overseer session', url: 'https://claude.ai/code', kind: 'session' }],
});
await call('PUT', '/api/groups/train-42', {
  name: 'Release train 42',
  ticket: 'gh:900',
  links: [{ label: 'Overseer session', url: 'https://claude.ai/code', kind: 'session' }],
});

const lanes = [
  ['auth-rework', { name: 'Auth rework', group: 'payments-epic', status: 'active', ticket: 'redmine:4812', activity: 'Migrating session store to Redis-compatible adapter; 14/22 call sites done', links: [{ label: 'PR #311', url: 'https://github.com/example/app/pull/311', kind: 'pr' }] }],
  ['billing-export', { name: 'Billing CSV export', group: 'payments-epic', status: 'awaiting_agent', ticket: 'redmine:4790', activity: 'Waiting for schema lane to publish migration 0042' }],
  ['schema-migrations', { name: 'Schema migrations', group: 'payments-epic', ticket: 'redmine:4791', activity: 'Migration 0042 drafted; needs decision on legacy column' }],
  ['e2e-stabilize', { name: 'E2E stabilization', group: 'train-42', status: 'pending_ci', ticket: 'gh:902', activity: 'Waiting on integration suite (shard 3/4)', links: [{ label: 'CI run', url: 'https://github.com/example/app/actions/runs/1', kind: 'ci' }, { label: 'PR #905', url: 'https://github.com/example/app/pull/905', kind: 'pr' }] }],
  ['changelog', { name: 'Changelog & notes', group: 'train-42', status: 'idle', ticket: 'gh:903', activity: 'Drafted; waiting for train cut' }],
  ['docs-refresh', { name: 'Docs refresh', group: 'train-42', status: 'completed', ticket: 'gh:870', activity: 'Merged' }],
];
for (const [id, patch] of lanes) await call('PUT', `/api/lanes/${id}`, patch);

const esc = await call('POST', '/api/escalations', {
  laneId: 'schema-migrations',
  context:
    'Migration 0042 cleans up the users table for the auth rework. users.legacy_role has had no reads in 90 days ' +
    '(query log: https://grafana.example.com/d/abc). Two internal reports still SELECT * from users.\n' +
    'Rollback after dropping requires a restore from the nightly backup.',
  question: 'Drop users.legacy_role in migration 0042?',
  recommendation: 'Drop it now. The auth rework is simpler without it, and SELECT * reports tolerate a missing column.',
  options: ['Drop it', 'Keep for one more release', 'Rename to _deprecated'],
  recommendedOption: 'Drop it',
  positions: [{ agent: 'auth-rework', stance: 'agree', note: 'Unblocks 6 call sites in the session adapter.' }],
  links: [{ label: 'Migration 0042', url: 'https://github.com/example/app/pull/318', kind: 'pr' }],
});
await call('POST', `/api/escalations/${esc.id}/positions`, {
  agent: 'billing-export',
  stance: 'disagree',
  note: 'The billing CSV job reads legacy_role via a raw query that the log sampling misses. Rename first.',
});
await call('POST', '/api/escalations', {
  laneId: 'e2e-stabilize',
  context: 'checkout.e2e.ts failed 2 of the last 10 runs on main; unrelated to train 42 changes.',
  question: 'Hold the train for the flaky e2e test, or ship?',
  recommendation: 'Ship; file a ticket for the flake.',
  options: ['Hold the train', 'Ship with known flake'],
  recommendedOption: 'Ship with known flake',
  blocking: false,
});
console.log('seeded');
