// Regression suite for the everyday loop: an overseer agent runs several lanes
// for one group, raises escalations, a human answers from the dashboard, and
// the agent picks the answers up. Each step goes through the public HTTP API or
// MCP, the way real clients do.
//
// The tests are one scenario and run in order: later steps build on the
// lanes and escalations earlier ones create.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const laneOf = async (id: string) => (await srv.call('GET', `/api/lanes/${id}`, ALICE)).body;

/** Fails unless `p` is still pending after `ms`: proves a wait is really parked before we wake it. */
async function assertPending(p: Promise<unknown>, ms = 150) {
  const timer = new Promise((r) => setTimeout(() => r('pending'), ms));
  assert.equal(await Promise.race([p.then(() => 'settled'), timer]), 'pending');
}

/** Resolves `p`, failing if it takes longer than `ms` (a wake-up that didn't happen would run to the wait's end). */
async function within<T>(p: Promise<T>, ms = 3000): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`not woken within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

describe('overseer publishes its group and lanes', () => {
  test('update_group and update_lane over MCP show up in the snapshot', async () => {
    const group = await srv.tool(AGENT, 'update_group', {
      group_id: 'payments',
      name: 'Payments train',
      ticket: 'gh:900',
      links: [{ label: 'Overseer', url: 'https://claude.ai/code/session_x', kind: 'session' }],
    });
    assert.equal(group.isError, false, group.text);
    // What was sent is not echoed back; a group's ticket is its epic's now, so that one is refused with a pointer.
    assert.deepEqual(Object.keys(group.value).sort(), ['id', 'project', 'warning']);
    assert.match(group.value.warning, /update_epic with epic "gh:900" and group "payments"/);

    for (const [id, ticket] of [
      ['pay-1', 'gh:901'],
      ['pay-2', 'gh:902'],
    ]) {
      const lane = await srv.tool(AGENT, 'update_lane', {
        lane_id: id,
        group: 'payments',
        status: 'active',
        ticket,
        activity: `Working ${ticket}`,
      });
      assert.equal(lane.isError, false, lane.text);
    }

    const snap = (await srv.call('GET', '/api/snapshot', ALICE)).body;
    assert.equal(snap.groups.find((g: any) => g.id === 'payments').name, 'Payments train');
    assert.equal(snap.groups.find((g: any) => g.id === 'payments').ticket, null, "a group's ticket is read-only");
    const lanes = snap.lanes.filter((l: any) => l.group === 'payments');
    assert.deepEqual(lanes.map((l: any) => l.id).sort(), ['pay-1', 'pay-2']);
    assert.ok(lanes.every((l: any) => l.status === 'active' && l.agent === 'overseer'));
  });

  test('status changes are recorded in the lane history', async () => {
    await srv.tool(AGENT, 'update_lane', { lane_id: 'pay-2', status: 'pending_ci', activity: 'CI on PR #12' });
    const detail = await laneOf('pay-2');
    assert.equal(detail.lane.status, 'pending_ci');
    const messages = detail.events.map((e: any) => e.message);
    assert.ok(messages.includes('active → pending_ci'));
    assert.ok(messages.includes('CI on PR #12'));
  });

  test('agents cannot use human tools and humans cannot publish', async () => {
    assert.equal((await srv.call('PUT', '/api/lanes/pay-1', ALICE, { status: 'idle' })).status, 403);
    const e = await srv.call('POST', '/api/escalations', AGENT, { laneId: 'pay-2', question: 'Role check?', blocking: false });
    const decide = await srv.tool(AGENT, 'decide_escalation', { id: e.body.id, decision: 'y' });
    assert.equal(decide.isError, true);
    assert.match(decide.text, /not found/i, 'the tool is not offered to agents');
    assert.equal((await srv.call('POST', `/api/escalations/${e.body.id}/decide`, AGENT, { decision: 'y' })).status, 403);
    assert.equal((await srv.call('GET', `/api/escalations/${e.body.id}`, ALICE)).body.state, 'open');
    assert.equal((await srv.call('POST', `/api/escalations/${e.body.id}/withdraw`, AGENT, { note: 'moot' })).status, 200);
  });
});

describe('escalations on one lane', () => {
  const ids: string[] = [];

  test('several escalations on a lane, all listed in order, lane blocked', async () => {
    for (const question of ['Add the queue dependency?', 'One queue per job type?', 'Retry 5 times?']) {
      const res = await srv.tool(AGENT, 'create_escalation', {
        lane_id: 'pay-1',
        question,
        context: 'Wiring background jobs for payouts.',
        recommendation: 'Yes',
        cost: 'A new dependency',
        alternatives: ['Hand-written REST calls'],
        accept_means: 'Add the dependency',
        reject_means: 'Hand-write the REST calls',
      });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.value.state, 'open');
      ids.push(res.value.id);
    }
    const lane = (await laneOf('pay-1')).lane;
    assert.equal(lane.status, 'blocked_human');
    assert.equal(lane.openEscalations, 3);
    const listed = await srv.tool(AGENT, 'list_escalations', { lane_id: 'pay-1' });
    assert.deepEqual(
      listed.value.map((e: any) => e.id),
      ids,
    );
  });

  test('an FYI escalation does not block its lane', async () => {
    const fyi = await srv.call('POST', '/api/escalations', AGENT, { laneId: 'pay-2', question: 'FYI: CI is slow', blocking: false });
    assert.equal(fyi.status, 201);
    assert.equal((await laneOf('pay-2')).lane.status, 'pending_ci');
    const closed = await srv.call('POST', `/api/escalations/${fyi.body.id}/withdraw`, AGENT, { note: 'noted' });
    assert.equal(closed.body.state, 'withdrawn');
  });

  test('another agent adds a position; the same agent replaces its own', async () => {
    const first = await srv.tool(REVIEWER, 'add_position', { id: ids[0], stance: 'disagree', note: 'too heavy' });
    assert.equal(first.value.positions.length, 1);
    const res = await srv.tool(REVIEWER, 'add_position', { id: ids[0], stance: 'agree', note: 'fine after all' });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(
      res.value.positions.map((p: any) => [p.agent, p.stance]),
      [['reviewer', 'agree']],
    );
  });

  test('the agent waits; a human decision wakes it', async () => {
    const waiting = srv.tool(AGENT, 'get_escalation', { id: ids[0], wait_seconds: 30 });
    await assertPending(waiting);
    const decided = await srv.call('POST', `/api/escalations/${ids[0]}/decide`, ALICE, { decision: 'Yes', note: 'pin the version' });
    assert.equal(decided.status, 200);
    const got = await within(waiting);
    assert.equal(got.value.state, 'decided');
    assert.equal(got.value.decision, 'Yes');
    assert.equal(got.value.decisionNote, 'pin the version');
    assert.equal(got.value.decidedBy, 'alice');
  });

  test('a decided escalation can not be decided again', async () => {
    assert.equal((await srv.call('POST', `/api/escalations/${ids[0]}/decide`, ALICE, { decision: 'No' })).status, 409);
  });

  test('the REST long-poll wakes on a decision too', async () => {
    const e = await srv.call('POST', '/api/escalations', AGENT, { laneId: 'pay-2', question: 'REST wait?', blocking: false });
    const waiting = srv.call('GET', `/api/escalations/${e.body.id}?wait=30`, AGENT);
    await assertPending(waiting);
    await srv.call('POST', `/api/escalations/${e.body.id}/decide`, ALICE, { decision: 'ok' });
    assert.equal((await within(waiting)).body.state, 'decided');
    const ack = await srv.call('POST', `/api/escalations/${e.body.id}/ack`, AGENT, { note: 'done' });
    assert.equal(ack.body.state, 'acknowledged');
  });

  test('a waiting agent gets the current state back when nothing happens', async () => {
    const res = await srv.tool(AGENT, 'get_escalation', { id: ids[1], wait_seconds: 1 });
    assert.equal(res.value.state, 'open');
  });

  test('the lane stays blocked until its last blocking escalation is answered', async () => {
    await srv.call('POST', `/api/escalations/${ids[1]}/decide`, ALICE, { decision: 'No' });
    assert.equal((await laneOf('pay-1')).lane.status, 'blocked_human');
    await srv.call('POST', `/api/escalations/${ids[2]}/decide`, ALICE, { decision: 'Yes' });
    const lane = (await laneOf('pay-1')).lane;
    assert.equal(lane.status, 'awaiting_agent');
    assert.equal(lane.blockedSince, null);
    assert.equal(lane.openEscalations, 0);
  });

  test('a restarted agent finds decisions it has not acknowledged', async () => {
    const res = await srv.tool(AGENT, 'list_escalations', { lane_id: 'pay-1', states: ['decided'] });
    assert.deepEqual(
      res.value.map((e: any) => e.id),
      ids,
    );
  });

  test('acknowledging closes the escalation and keeps its note', async () => {
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: ids[0], note: 'added with a pinned version' });
    assert.equal(ack.isError, false, ack.text);
    assert.equal(ack.value.state, 'acknowledged');
    const unresolved = (await srv.call('GET', '/api/escalations', ALICE)).body.map((e: any) => e.id);
    assert.ok(!unresolved.includes(ids[0]));
    const history = (await laneOf('pay-1')).escalations.find((e: any) => e.id === ids[0]);
    assert.equal(history.resolution, 'added with a pinned version');
  });

  test('withdrawing closes an open escalation answered elsewhere', async () => {
    const e = await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-2', question: 'Skip the flaky test?' });
    const res = await srv.tool(AGENT, 'dismiss_escalation', { id: e.value.id, justification: 'answered in Remote Control' });
    assert.equal(res.value.state, 'withdrawn');
    assert.equal(res.value.resolution, 'answered in Remote Control');
  });
});

describe('removing and restoring a lane', () => {
  test('removal releases waiters and parks the ticket with its questions: open ones stay open, decided ones can be acknowledged', async () => {
    await srv.tool(AGENT, 'update_lane', { lane_id: 'gone', group: 'payments', ticket: '321', status: 'active' });
    const open = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'gone', question: 'Open?' })).value;
    const decided = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'gone', question: 'Decided?' })).value;
    await srv.call('POST', `/api/escalations/${decided.id}/decide`, ALICE, { decision: 'ok' });

    const waiting = srv.tool(AGENT, 'get_escalation', { id: open.id, wait_seconds: 30 });
    await assertPending(waiting);
    assert.equal((await srv.call('DELETE', '/api/lanes/gone', ALICE)).status, 204);
    // The waiter hears the lane went; nothing is withdrawn, the question waits on the parked ticket.
    const released = await within(waiting);
    assert.equal(released.value.state, 'open');
    assert.equal((await srv.call('GET', '/api/tickets/321', ALICE)).body.ticket.state, 'parked');
    await srv.call('POST', `/api/escalations/${open.id}/decide`, ALICE, { decision: 'later' });

    assert.equal((await srv.call('GET', '/api/lanes/gone', ALICE)).status, 404);
    for (const id of [decided.id, open.id]) {
      assert.equal((await srv.tool(AGENT, 'acknowledge_escalation', { id })).value.state, 'acknowledged');
    }
  });

  test('publishing to a removed lane restores it with its history', async () => {
    // It comes back without its ticket: filling it brings the parked one back.
    await srv.tool(AGENT, 'fill_lane', { lane_id: 'gone', ticket: '321', status: 'active' });
    const detail = await laneOf('gone');
    assert.equal(detail.lane.status, 'active');
    const messages = detail.events.map((e: any) => e.message);
    assert.ok(messages.includes('Lane removed'));
    assert.ok(messages.includes('Lane restored'));
  });
});

describe('real time and export', () => {
  test('the event stream delivers escalation and lane removal events', { timeout: 5000 }, async () => {
    const ctrl = new AbortController();
    try {
      const res = await fetch(`${srv.base}/api/events`, { headers: { authorization: `Bearer ${ALICE}` }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const readUntil = async (needle: string) => {
        while (!text.includes(needle)) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`stream ended before ${needle}`);
          text += decoder.decode(value, { stream: true });
        }
      };
      await srv.publish('streamed');
      await srv.tool(AGENT, 'create_escalation', { lane_id: 'streamed', question: 'Stream me?' });
      await readUntil('Stream me?');
      assert.match(text, /event: escalation/);
      await srv.call('DELETE', '/api/lanes/streamed', ALICE);
      await readUntil('event: lane_deleted');
    } finally {
      ctrl.abort();
    }
  });

  test('a human can decide over MCP', async () => {
    const e = await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-2', question: 'Decide over MCP?', blocking: false });
    const res = await srv.tool(ALICE, 'decide_escalation', { id: e.value.id, decision: 'yes' });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.value.state, 'decided');
    assert.equal(res.value.decidedBy, 'alice');
  });

  test('exports keep every escalation, whatever its state', async () => {
    await srv.tool(AGENT, 'create_escalation', { lane_id: 'pay-2', question: 'Still open?', blocking: false });
    const rows = (await srv.call('GET', '/api/export/escalations.json', ALICE)).body;
    const states = new Set(rows.map((r: any) => r.state));
    for (const s of ['open', 'decided', 'acknowledged', 'withdrawn']) assert.ok(states.has(s), s);
    const csv = await srv.tool(ALICE, 'export_data', { dataset: 'escalations' });
    assert.equal(csv.isError, false);
    assert.ok(csv.content![1].text.startsWith('id,'));
  });
});

describe('agent skill', () => {
  /** The skill a server hands out, and the tools an agent key sees there. */
  async function skillAndTools(server: typeof srv) {
    const res = await fetch(`${server.base}/api/skill`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
    const text = await res.text();
    const tools = (await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }).then(async (r) => {
      const body = await r.text();
      const line = body.split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(line ? line.slice(6) : body).result.tools as { name: string; inputSchema: { properties?: object } }[];
    }));
    return { text, tools };
  }

  /** Every tool the skill names exists. */
  function namesOnlyRealTools(text: string, tools: { name: string; inputSchema: { properties?: object } }[]) {
    const toolNames = tools.map((t) => t.name);
    const params = new Set(tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {})));
    const named = [...new Set(text.match(/`([a-z]+_[a-z_]+)`/g)?.map((m) => m.slice(1, -1)) ?? [])].filter(
      (n) => /^(update|remove|create|add|wait|get|acknowledge|dismiss|find|record|supersede|list|fill|notify|reply|request)_/.test(n) && !params.has(n),
    );
    assert.ok(named.length > 5);
    for (const name of named) assert.ok(toolNames.includes(name), `skill names unknown tool ${name}`);
    return toolNames;
  }

  test('alerts only: the skill and tools have no waiting or answering in LaneSignal', async () => {
    const plain = await startServer({ LANESIGNAL_DECISIONS: 'false' });
    try {
      const { text, tools } = await skillAndTools(plain);
      assert.match(text, /^---\nname: lanesignal\n/);
      const names = namesOnlyRealTools(text, tools);
      assert.ok(names.includes('dismiss_escalation'));
      assert.ok(names.includes('find_requirements'), 'requirements are on by default');
      for (const off of ['wait_for_decisions', 'acknowledge_escalation', 'add_position']) {
        assert.ok(!names.includes(off), `${off} is off by default`);
        assert.ok(!text.includes(off), `the skill doesn't mention ${off}`);
      }
      assert.match(text, /owner answers \*\*in this session\*\*/);
    } finally {
      plain.close();
    }
  });

  test('the config gives the app the ticket templates, so refs in free text can link', async () => {
    const config = (await srv.call('GET', '/api/config', ALICE)).body;
    assert.deepEqual(config.ticketTemplates, { gh: 'https://github.com/o/r/issues/{id}' });
    assert.equal(config.defaultTicketSystem, 'gh');
  });

  test('by default people answer in LaneSignal, and the skill covers waiting and acknowledging', async () => {
    assert.equal((await srv.call('GET', '/api/config', ALICE)).body.decisions, true);
    const { text, tools } = await skillAndTools(srv);
    const names = namesOnlyRealTools(text, tools);
    for (const on of ['wait_for_decisions', 'acknowledge_escalation', 'add_position', 'dismiss_escalation']) {
      assert.ok(names.includes(on), on);
      assert.ok(text.includes(on), `the skill covers ${on}`);
    }
    assert.match(text, /## Waiting for answers/);
    assert.doesNotMatch(text, /owner answers \*\*in this session\*\*/);
    // Requirements come after how answers arrive.
    assert.ok(text.indexOf('## Requirements') > text.indexOf('## After a restart'));
  });

  test('the Claude Code plugin carries the skill a default server hands out', async () => {
    const served = await (await fetch(`${srv.base}/api/skill`)).text();
    const plugin = readFileSync(new URL('../../plugin/skills/lanesignal/SKILL.md', import.meta.url), 'utf8');
    assert.equal(plugin, served, 'run node scripts/build-plugin-skill.mjs');
  });

  test('requirements can be turned off', async () => {
    const off = await startServer({ LANESIGNAL_REQUIREMENTS: 'false' });
    try {
      const { text, tools } = await skillAndTools(off);
      assert.ok(!tools.some((t) => t.name.includes('requirement')));
      assert.ok(!text.includes('find_requirements'));
      assert.equal((await off.call('GET', '/api/requirements', AGENT)).status, 404);
      assert.equal((await off.call('GET', '/api/export/requirements.csv', ALICE)).status, 404);
      assert.equal((await off.call('GET', '/api/config', ALICE)).body.requirements, false);
    } finally {
      off.close();
    }
  });
});


