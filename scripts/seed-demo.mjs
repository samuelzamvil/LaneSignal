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
  ['billing-export', { name: 'Billing CSV export', group: 'payments-epic', status: 'awaiting_agent', ticket: 'redmine:4790', activity: 'Waiting for production wiring to land the job queue' }],
  ['prod-wiring', { name: 'Production wiring', group: 'payments-epic', ticket: 'gh:921', activity: 'Plan #921 reviewed; four decisions needed before implementation' }],
  ['e2e-stabilize', { name: 'E2E stabilization', group: 'train-42', status: 'pending_ci', ticket: 'gh:902', activity: 'Waiting on integration suite (shard 3/4)', links: [{ label: 'CI run', url: 'https://github.com/example/app/actions/runs/1', kind: 'ci' }, { label: 'PR #905', url: 'https://github.com/example/app/pull/905', kind: 'pr' }] }],
  ['changelog', { name: 'Changelog & notes', group: 'train-42', status: 'idle', ticket: 'gh:903', activity: 'Drafted; waiting for train cut' }],
  ['docs-refresh', { name: 'Docs refresh', group: 'train-42', status: 'completed', ticket: 'gh:870', activity: 'Merged' }],
];
for (const [id, patch] of lanes) await call('PUT', `/api/lanes/${id}`, patch);

// A lane with a batch of questions from one plan.
const reviewer = { agent: 'plan-reviewer', stance: 'agree' };
const wiring = [
  {
    question: 'May #921 add the @google-cloud/tasks package (Google\'s official Cloud Tasks client, Apache-2.0)?',
    context:
      'The production wiring has to put background jobs, like claims sync and renewal runs, onto Google Cloud Tasks. ' +
      'Today only a test fake exists. This package is Google\'s own client for it, and the repository needs your ' +
      'approval for any new dependency.',
    recommendation: 'Yes. It\'s the standard client, and its licence is compatible.',
    cost: 'A bigger dependency tree and container image, and a little more memory per running service.',
    alternatives: [
      'Hand-write the Cloud Tasks REST calls ourselves: no new package, but more code of our own to maintain and get right (authentication, retries).',
    ],
    options: ['Approve', 'Hand-write the REST calls'],
    recommendedOption: 'Approve',
    positions: [{ ...reviewer, note: 'Approve, with the plan\'s checks on the exact version\'s licence and its retry and deadline settings.' }],
  },
  {
    question: 'One Cloud Tasks queue per job type, or a single shared queue?',
    context: 'Claims sync is bursty; renewal runs are a nightly batch. Separate queues let each have its own rate limit.',
    recommendation: 'One queue per job type.',
    cost: 'Two more queues to provision and monitor in each environment.',
    alternatives: ['A single shared queue: simpler setup, but a claims-sync burst can delay renewals.'],
    options: ['Per job type', 'Single queue'],
    recommendedOption: 'Per job type',
    positions: [{ ...reviewer }],
  },
  {
    question: 'Is a 10-minute dispatch deadline acceptable for renewal runs?',
    context: 'The longest renewal run in staging took 6m40s. Cloud Tasks allows up to 30 minutes for HTTP targets.',
    recommendation: 'Yes, 10 minutes, with an alert when a run passes 8.',
    options: ['10 minutes', '30 minutes'],
    recommendedOption: '10 minutes',
  },
  {
    question: 'Should failed claims-sync tasks retry 5 times with exponential backoff?',
    context: 'Upstream claims API outages usually last under 15 minutes. Five retries starting at 30s cover about 16 minutes.',
    recommendation: 'Yes, 5 retries, then park in a dead-letter table for manual replay.',
    cost: 'A new dead-letter table and a replay script.',
    options: ['5 retries + dead-letter', 'Unlimited retries'],
    recommendedOption: '5 retries + dead-letter',
    positions: [{ agent: 'billing-export', stance: 'disagree', note: 'Billing needs the sync within the hour; prefer 8 retries.' }],
  },
];
for (const q of wiring) await call('POST', '/api/escalations', { laneId: 'prod-wiring', ticket: 'gh:921', ...q });
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
