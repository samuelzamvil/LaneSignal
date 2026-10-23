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

const lanes = [
  ['auth-rework', { name: 'Auth rework', category: 'Epic', status: 'active', ticket: 'redmine:4812', activity: 'Migrating session store to Redis-compatible adapter; 14/22 call sites done', links: [{ label: 'PR #311', url: 'https://github.com/example/app/pull/311', kind: 'pr' }] }],
  ['release-train-42', { name: 'Release train 42', category: 'Train', status: 'pending_ci', ticket: 'gh:902', activity: 'Waiting on integration suite (shard 3/4)', links: [{ label: 'CI run', url: 'https://github.com/example/app/actions/runs/1', kind: 'ci' }, { label: 'PR #905', url: 'https://github.com/example/app/pull/905', kind: 'pr' }] }],
  ['billing-export', { name: 'Billing CSV export', category: 'Epic', status: 'awaiting_agent', ticket: 'redmine:4790', activity: 'Waiting for schema lane to publish migration 0042' }],
  ['overseer', { name: 'Overseer', category: 'Overseer', status: 'idle', activity: 'All lanes assigned' }],
  ['docs-refresh', { name: 'Docs refresh', category: 'Train', status: 'completed', ticket: 'gh:870', activity: 'Merged' }],
];
for (const [id, patch] of lanes) await call('PUT', `/api/lanes/${id}`, patch);

await call('PUT', '/api/lanes/schema-migrations', { name: 'Schema migrations', category: 'Epic', ticket: 'redmine:4791', activity: 'Migration 0042 drafted; needs decision on legacy column', links: [{ label: 'Remote Control session', url: 'https://claude.ai/code', kind: 'session' }] });
await call('POST', '/api/escalations', {
  laneId: 'schema-migrations',
  title: 'Drop users.legacy_role in migration 0042?',
  body: 'The column has had no reads for 90 days (see query log). Dropping it simplifies the auth rework.\nRollback requires restoring from backup.',
  options: ['Drop it', 'Keep for one more release', 'Rename to _deprecated'],
});
await call('POST', '/api/escalations', {
  laneId: 'release-train-42',
  title: 'Flaky e2e test blocks train — quarantine or hold?',
  options: ['Hold the train', 'Ship with known flake'],
  blocking: false,
});
console.log('seeded');
