// The agent side of escalations: short numbers, safe retries, waiting on many
// escalations at once (with keepalives), correcting a decision, and showing
// whether an agent is listening.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

const ask = async (lane: string, question: string, extra: Record<string, unknown> = {}) => {
  await srv.publish(lane);
  return (await srv.tool(AGENT, 'create_escalation', { lane_id: lane, question, ...extra })).value;
};
const decide = (id: string, decision: string, extra: Record<string, unknown> = {}) =>
  srv.call('POST', `/api/escalations/${encodeURIComponent(id)}/decide`, ALICE, { decision, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('escalation codes', () => {
  test('codes are the lane letter and a number, usable wherever an id is', async () => {
    await srv.tool(AGENT, 'update_lane', { lane_id: 'refs' });
    const letter = (await srv.call('GET', '/api/lanes/refs', ALICE)).body.lane.letter;
    assert.match(letter, /^[A-Z]+$/);
    const a = await ask('refs', 'First?');
    const b = await ask('refs', 'Second?');
    assert.match(a.ref, new RegExp(`^${letter}\\d+$`));
    assert.equal(Number(b.ref.slice(letter.length)), Number(a.ref.slice(letter.length)) + 1);
    assert.equal((await srv.call('GET', `/api/escalations/${b.ref}`, ALICE)).body.id, b.id);
    assert.equal((await srv.tool(AGENT, 'get_escalation', { id: b.ref.toLowerCase() })).value.id, b.id);
    assert.equal((await srv.tool(AGENT, 'add_position', { id: a.ref, stance: 'agree' })).value.positions.length, 1);
    assert.equal((await decide(a.ref, 'yes')).body.state, 'decided');
    assert.equal((await srv.tool(AGENT, 'acknowledge_escalation', { id: a.ref })).value.state, 'acknowledged');
    assert.equal((await srv.tool(AGENT, 'dismiss_escalation', { id: b.ref, justification: 'moot' })).value.state, 'withdrawn');
    assert.equal((await srv.call('GET', '/api/escalations/ZZZ999', ALICE)).status, 404);
  });

  test('codes appear in exports and the lane history', async () => {
    const rows = (await srv.call('GET', '/api/export/escalations.json?lane=refs', ALICE)).body;
    assert.ok(rows.length > 0 && rows.every((r: any) => /^[A-Z]+\d+$/.test(r.ref)));
    const events = (await srv.call('GET', '/api/lanes/refs', ALICE)).body.events.map((e: any) => e.message);
    assert.ok(events.some((m: string) => /^Escalated [A-Z]+\d+: First\?$/.test(m)));
  });

  test('overseers can remove a lane whose work is over', async () => {
    await srv.tool(AGENT, 'update_lane', { lane_id: 'finished' });
    const e = await ask('finished', 'Still needed?');
    const res = await srv.tool(AGENT, 'remove_lane', { lane_id: 'finished' });
    assert.equal(res.isError, false, res.text);
    assert.equal((await srv.call('GET', '/api/lanes/finished', ALICE)).status, 404);
    const closed = (await srv.call('GET', `/api/escalations/${e.id}`, ALICE)).body;
    assert.equal(closed.state, 'withdrawn');
    assert.match(closed.resolution, /Lane removed by overseer/);
    assert.equal((await srv.call('DELETE', '/api/lanes/nope', AGENT)).status, 404);
  });
});

describe('safe retries', () => {
  test('raising the same open question again returns the first one', async () => {
    await srv.publish('retry');
    const first = await srv.call('POST', '/api/escalations', AGENT, { laneId: 'retry', question: 'Same?' });
    const again = await srv.call('POST', '/api/escalations', AGENT, { laneId: 'retry', question: 'Same?' });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.duplicate, true);
    assert.equal((await srv.call('GET', '/api/lanes/retry', ALICE)).body.lane.openEscalations, 1);
    // Once answered, the same question can be asked again.
    await decide(first.body.id, 'ok');
    const later = await srv.call('POST', '/api/escalations', AGENT, { laneId: 'retry', question: 'Same?' });
    assert.equal(later.status, 201);
    assert.notEqual(later.body.id, first.body.id);
  });

  test('acknowledging twice returns the same result', async () => {
    const e = await ask('retry', 'Ack twice?');
    await decide(e.id, 'yes');
    const one = await srv.tool(AGENT, 'acknowledge_escalation', { id: e.id, note: 'doing it' });
    const two = await srv.tool(AGENT, 'acknowledge_escalation', { id: e.id, note: 'doing it' });
    assert.equal(two.isError, false, two.text);
    assert.deepEqual(two.value, one.value);
  });

  test('acknowledging an open escalation is still an error', async () => {
    const e = await ask('retry', 'Not yet?');
    const res = await srv.tool(AGENT, 'acknowledge_escalation', { id: e.id });
    assert.equal(res.isError, true);
    assert.match(res.text, /[A-Z]+\d+ is open/);
  });

  test('validation errors name the fields as the tool spells them', async () => {
    const res = await srv.tool(AGENT, 'create_escalation', {
      lane_id: 'retry',
      question: 'Bad?',
      options: ['A'],
      recommended_option: 'B',
    });
    assert.equal(res.isError, true);
    assert.match(res.text, /^Invalid input: recommended_option: /);
  });
});

describe('acknowledging publishes the next lane state', () => {
  test('status and activity are applied in the same call', async () => {
    await srv.tool(AGENT, 'update_lane', { lane_id: 'next', status: 'active' });
    const e = await ask('next', 'Go?');
    await decide(e.id, 'go');
    assert.equal((await srv.call('GET', '/api/lanes/next', ALICE)).body.lane.status, 'awaiting_agent');
    const ack = await srv.call('POST', `/api/escalations/${e.id}/ack`, AGENT, { status: 'active', activity: 'Going' });
    assert.equal(ack.body.decision, 'go');
    const lane = (await srv.call('GET', '/api/lanes/next', ALICE)).body.lane;
    assert.equal(lane.status, 'active');
    assert.equal(lane.activity, 'Going');
  });

  test('it does not bring back a removed lane', async () => {
    const e = await ask('removed-ack', 'Go?');
    await decide(e.id, 'go');
    await srv.call('DELETE', '/api/lanes/removed-ack', ALICE);
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: e.id, status: 'active' });
    assert.equal(ack.value.state, 'acknowledged');
    assert.equal((await srv.call('GET', '/api/lanes/removed-ack', ALICE)).status, 404);
  });
});

describe('changing a decision', () => {
  test('needs change: true, and only until the agent acknowledges', async () => {
    const e = await ask('change', 'Which?', { options: ['A', 'B'] });
    await decide(e.id, 'A');
    assert.equal((await decide(e.id, 'B')).status, 409, 'a plain second decision is a conflict');
    const changed = await decide(e.id, 'B', { change: true, note: 'mis-tap' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.decision, 'B');
    assert.equal(changed.body.decisionNote, 'mis-tap');
    const ack = await srv.tool(AGENT, 'acknowledge_escalation', { id: e.id });
    assert.equal(ack.value.decision, 'B');
    assert.equal((await decide(e.id, 'A', { change: true })).status, 409);
    const events = (await srv.call('GET', '/api/lanes/change', ALICE)).body.events.map((x: any) => x.message);
    assert.ok(events.includes('Decision changed by alice: B (was A by alice)'));
  });

  test('change: true on an open escalation is a normal decision', async () => {
    const e = await ask('change', 'Open?');
    assert.equal((await decide(e.id, 'yes', { change: true })).body.state, 'decided');
  });

  test('humans can change a decision over MCP', async () => {
    const e = await ask('change', 'MCP change?');
    await decide(e.id, 'A');
    const res = await srv.tool(ALICE, 'decide_escalation', { id: e.id, decision: 'B', change: true });
    assert.equal(res.value.decision, 'B');
  });
});

describe('waiting on many escalations', () => {
  test('a group wait wakes on the first decision and lists what is still open', async () => {
    await srv.publish('w-1', { group: 'wait-group' });
    await srv.publish('w-2', { group: 'wait-group' });
    const a = await ask('w-1', 'A?');
    const b = await ask('w-2', 'B?');
    const t0 = Date.now();
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { group_id: 'wait-group', wait_seconds: 30 });
    await sleep(150);
    await decide(b.id, 'yes');
    const res = (await waiting).value;
    assert.ok(Date.now() - t0 < 5000, 'woken by the decision, not the timeout');
    assert.equal(res.ready, true);
    assert.deepEqual(res.decided.map((e: any) => e.id), [b.id]);
    assert.deepEqual(res.open.map((e: any) => e.ref), [a.ref]);
  });

  test('returns at once while a decision is unacknowledged, and once nothing is open', async () => {
    const now = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'wait-group', wait_seconds: 30 })).value;
    assert.equal(now.ready, true);
    assert.equal(now.decided.length, 1);
    await srv.tool(AGENT, 'acknowledge_escalation', { id: now.decided[0].id });
    const [open] = now.open;
    await decide(open.id, 'yes');
    await srv.tool(AGENT, 'acknowledge_escalation', { id: open.id });
    const empty = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'wait-group', wait_seconds: 30 })).value;
    assert.deepEqual({ ...empty, checkedAt: undefined }, { ready: true, decided: [], closed: [], open: [], removedLanes: [], checkedAt: undefined });
    assert.ok(Date.parse(empty.checkedAt));
  });

  test('times out with ready: false when nothing changes', async () => {
    const e = await ask('w-1', 'Quiet?');
    const res = (await srv.tool(AGENT, 'wait_for_decisions', { lane_ids: ['w-1'], wait_seconds: 1 })).value;
    assert.equal(res.ready, false);
    assert.deepEqual(res.open.map((x: any) => x.id), [e.id]);
  });

  test('named escalations report being closed, e.g. by a lane removal', async () => {
    const e = await ask('w-gone', 'Gone?');
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { ids: [`#${e.ref}`], wait_seconds: 30 });
    await sleep(150);
    await srv.call('DELETE', '/api/lanes/w-gone', ALICE);
    const res = (await waiting).value;
    assert.equal(res.ready, true);
    assert.equal(res.closed[0].state, 'withdrawn');
  });

  test('a group wait reports a lane a human removed, but not the agent\'s own withdrawals', async () => {
    await srv.publish('g-a', { group: 'removals' });
    await srv.publish('g-b', { group: 'removals' });
    const a = await ask('g-a', 'A?');
    const b = await ask('g-b', 'B?');
    const own = await ask('g-b', 'Mine to withdraw?');
    const t0 = Date.now();
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { group_id: 'removals', wait_seconds: 30 });
    await sleep(150);
    await srv.tool(AGENT, 'dismiss_escalation', { id: own.id, justification: 'moot' });
    await sleep(100);
    await srv.call('DELETE', '/api/lanes/g-a', ALICE);
    const res = (await waiting).value;
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(res.ready, true);
    assert.deepEqual(res.closed.map((e: any) => e.id), [a.id]);
    assert.match(res.closed[0].resolution, /Lane removed by alice/);
    assert.deepEqual(res.open.map((e: any) => e.id), [b.id]);
  });

  test('a lane removed with nothing open is reported too, but not the agent\'s own removals', async () => {
    await srv.publish('quiet-1', { group: 'quiet' });
    await srv.publish('quiet-2', { group: 'quiet' });
    await ask('quiet-2', 'Keeps the wait open?');
    const start = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'quiet', wait_seconds: 0 })).value;
    await srv.publish('quiet-3', { group: 'quiet' });
    await srv.tool(AGENT, 'remove_lane', { lane_id: 'quiet-3' });
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { group_id: 'quiet', since: start.checkedAt, wait_seconds: 30 });
    await sleep(150);
    await srv.call('DELETE', '/api/lanes/quiet-1', ALICE);
    const res = (await waiting).value;
    assert.equal(res.ready, true);
    assert.deepEqual(res.removedLanes.map((l: any) => [l.laneId, l.removedBy]), [['quiet-1', 'alice']]);
  });

  test('since catches withdrawals that happened between two waits', async () => {
    const before = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'removals', wait_seconds: 0 })).value;
    await srv.publish('g-c', { group: 'removals' });
    await ask('g-c', 'C?');
    await srv.call('DELETE', '/api/lanes/g-c', ALICE);
    const later = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'removals', since: before.checkedAt, wait_seconds: 5 })).value;
    assert.equal(later.ready, true);
    assert.deepEqual(later.closed.map((e: any) => e.laneId), ['g-c']);
    const http = await srv.call('GET', `/api/wait?group=removals&since=${encodeURIComponent(before.checkedAt)}&timeout=5`, AGENT);
    assert.deepEqual(http.body.closed.map((e: any) => e.laneId), ['g-c']);
  });

  test('scope is required; unknown groups, lanes and ids are errors', async () => {
    assert.equal((await srv.tool(AGENT, 'wait_for_decisions', {})).isError, true);
    assert.equal((await srv.tool(AGENT, 'wait_for_decisions', { ids: ['#99999'] })).isError, true);
    const typo = await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'wait-gruop' });
    assert.equal(typo.isError, true);
    assert.match(typo.text, /Group "wait-gruop" not found/);
    assert.equal((await srv.call('GET', '/api/wait', AGENT)).status, 400);
    assert.equal((await srv.call('GET', '/api/wait?ids=99999', AGENT)).status, 404);
    assert.equal((await srv.call('GET', '/api/wait?group=nope', AGENT)).status, 404);
    assert.equal((await srv.call('GET', '/api/wait?lane=nope', AGENT)).status, 404);
    assert.equal((await srv.call('GET', '/api/wait?group=g&bogus=1', AGENT)).status, 400);
    assert.equal((await srv.call('GET', '/api/wait?group=g&timeout=100000', AGENT)).status, 400);
    assert.equal((await srv.call('GET', '/api/wait?group=wait-group&since=yesterday', AGENT)).status, 400);
  });
});

describe('the HTTP wait for long waits', () => {
  test('answers at once with JSON when something is ready', async () => {
    await srv.tool(AGENT, 'update_lane', { lane_id: 'empty-lane' });
    const res = await srv.call('GET', '/api/wait?lane=empty-lane&timeout=60', AGENT);
    assert.equal(res.status, 200);
    assert.equal(res.body.ready, true);
    assert.deepEqual(res.body.open, []);
  });

  test('sends headers and keepalive bytes at once, then the JSON when decided', async () => {
    const e = await ask('http-wait', 'Long wait?');
    const res = await fetch(`${srv.base}/api/wait?lane=http-wait&timeout=3600`, { headers: { authorization: `Bearer ${AGENT}` } });
    assert.equal(res.status, 200, 'the 200 is sent before anything is decided');
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value).trim(), '', 'whitespace keepalive');
    await decide(e.id, 'yes');
    let text = new TextDecoder().decode(first.value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const body = JSON.parse(text);
    assert.equal(body.ready, true);
    assert.equal(body.decided[0].id, e.id);
  });
});

describe('whether an agent is listening', () => {
  test('lanes show agentWaiting while an agent waits on them, briefly after', async () => {
    const e = await ask('listening', 'Anyone there?');
    assert.equal((await srv.call('GET', '/api/lanes/listening', ALICE)).body.lane.agentWaiting, false);
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { lane_ids: ['listening'], wait_seconds: 30 });
    await sleep(150);
    assert.equal((await srv.call('GET', '/api/lanes/listening', ALICE)).body.lane.agentWaiting, true);
    await decide(e.id, 'yes');
    await waiting;
    // The test server's grace period is 50ms.
    await sleep(200);
    assert.equal((await srv.call('GET', '/api/lanes/listening', ALICE)).body.lane.agentWaiting, false);
  });

  test('a lane that gets a question during a group wait is marked too', async () => {
    await srv.publish('join-1', { group: 'joining' });
    await srv.publish('join-2', { group: 'joining' });
    const first = await ask('join-1', 'First?');
    const waiting = srv.tool(AGENT, 'wait_for_decisions', { group_id: 'joining', wait_seconds: 30 });
    await sleep(150);
    const second = await ask('join-2', 'Second?');
    await sleep(50);
    assert.equal((await srv.call('GET', '/api/lanes/join-2', ALICE)).body.lane.agentWaiting, true);
    await decide(second.id, 'ok');
    const res = (await waiting).value;
    assert.deepEqual(res.decided.map((e: any) => e.id), [second.id]);
    await decide(first.id, 'ok');
  });

  test('FYI escalations are counted apart from blocking ones', async () => {
    await ask('fyi-count', 'Blocking?');
    await ask('fyi-count', 'Just so you know', { blocking: false });
    const lane = (await srv.call('GET', '/api/lanes/fyi-count', ALICE)).body.lane;
    assert.equal(lane.openEscalations, 2);
    assert.equal(lane.blockingEscalations, 1);
  });
});

describe('export filters', () => {
  test('impossible dates are a 400, not a 500', async () => {
    for (const bad of ['2026-13-01', '2026-02-30', '2026-10-01T25:00:00Z']) {
      assert.equal((await srv.call('GET', `/api/export/escalations.csv?from=${encodeURIComponent(bad)}`, ALICE)).status, 400, bad);
    }
    const mcp = await srv.tool(ALICE, 'export_data', { dataset: 'escalations', from: '2026-13-01' });
    assert.equal(mcp.isError, true);
    assert.match(mcp.text, /from: not a valid date/);
  });
});
