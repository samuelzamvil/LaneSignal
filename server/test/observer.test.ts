// Observer keys: read everything an agent key reads, within the same projects, and change nothing.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, startServer } from './helpers.ts';

/** A static observer token named like the agent token, so their keys could be confused. */
const WATCHER = 'watcher-token-0123456789';

let srv: Awaited<ReturnType<typeof startServer>>;
let escalation: { id: string; ref: string };

before(async () => {
  srv = await startServer({ LANESIGNAL_OBSERVER_TOKENS: `overseer:${WATCHER}`, LANESIGNAL_SIGNIN_RATE_MAX: '50' });
  await srv.publish('auth');
  escalation = (await srv.call('POST', '/api/escalations', AGENT, { laneId: 'auth', question: 'Ship it?' })).body;
});
after(() => srv.close());

async function signIn(name: string, email: string) {
  const password = 'correct horse battery';
  const created = await srv.call('POST', '/api/admin/people', ALICE, { email, name, password });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const res = await fetch(`${srv.base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  return { token: res.headers.get('set-auth-token')!, id: created.body.id as string };
}

async function toolNames(token: string) {
  const res = await fetch(`${srv.base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const msg = JSON.parse(line ? line.slice(6) : text);
  return (msg.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[]).map((t) => t.name).sort();
}

describe('observer keys', () => {
  test('read what an agent reads', async () => {
    assert.equal((await srv.call('GET', '/api/me', WATCHER)).body.role, 'observer');
    assert.equal((await srv.call('GET', '/api/lanes', WATCHER)).status, 200);
    assert.equal((await srv.call('GET', '/api/lanes/auth', WATCHER)).body.lane.id, 'auth');
    assert.equal((await srv.call('GET', `/api/escalations/${escalation.id}`, WATCHER)).body.question, 'Ship it?');
    assert.equal((await srv.call('GET', '/api/snapshot', WATCHER)).status, 200);
    assert.equal((await srv.call('GET', '/api/groups/main/conversation', WATCHER)).status, 200);
    assert.equal((await srv.call('GET', '/api/requirements', WATCHER)).status, 200);
    assert.equal((await srv.call('GET', '/api/updates?lane=auth', WATCHER)).status, 200);
    assert.equal((await srv.call('GET', '/api/wait?lane=auth&timeout=0', WATCHER)).status, 200);
    assert.equal((await srv.call('GET', '/api/export/escalations.json', WATCHER)).status, 200);
    // Member, never admin, in the projects it sees (config tokens see every project).
    const projects = (await srv.call('GET', '/api/projects', WATCHER)).body;
    assert.ok(projects.length > 0 && projects.every((p: { role: string }) => p.role === 'member'));
  });

  test('change nothing over HTTP', async () => {
    const refused: [string, string, unknown?][] = [
      ['PUT', '/api/lanes/auth', { group: 'main', status: 'idle' }],
      ['PUT', '/api/lanes/auth/fill', { group: 'main', ticket: '9' }],
      ['DELETE', '/api/lanes/auth'],
      ['PUT', '/api/groups/main', {}],
      ['DELETE', '/api/groups/main'],
      ['POST', '/api/groups/main/messages', { body: 'Hello' }],
      ['POST', '/api/groups/main/ack', { upTo: 1 }],
      ['POST', '/api/escalations', { laneId: 'auth', question: 'Mine?' }],
      ['POST', `/api/escalations/${escalation.id}/decide`, { decision: 'yes' }],
      ['POST', `/api/escalations/${escalation.id}/ack`, {}],
      ['POST', `/api/escalations/${escalation.id}/withdraw`, { note: 'gone' }],
      ['POST', `/api/escalations/${escalation.id}/messages`, { body: 'Hi' }],
      ['POST', `/api/escalations/${escalation.id}/positions`, { agree: true, reason: 'ok' }],
      ['POST', '/api/epics', { name: 'gh:1' }],
      ['POST', '/api/requirements', { requirement: 'Observers record nothing.', justification: 'Read-only.', scope: 'project' }],
      ['POST', '/api/products', { id: 'billing', name: 'Billing' }],
      ['POST', '/api/attachments', {}],
      ['POST', '/api/push/register', { token: 'x' }],
      ['POST', '/api/projects', { id: 'spy', key: 'SPY', name: 'Spy' }],
    ];
    for (const [method, path, body] of refused) {
      const res = await srv.call(method, path, WATCHER, body);
      assert.equal(res.status, 403, `${method} ${path}: ${JSON.stringify(res.body)}`);
    }
    // Acknowledging group notes rides on reads: refused there too.
    assert.equal((await srv.call('GET', '/api/updates?group=main&ack=1', WATCHER)).status, 403);
    assert.equal((await srv.call('GET', '/api/wait?group=main&timeout=0&ack=1', WATCHER)).status, 403);
    // Nothing changed.
    const lane = (await srv.call('GET', '/api/lanes/auth', AGENT)).body.lane;
    assert.notEqual(lane.status, 'idle');
    assert.equal((await srv.call('GET', `/api/escalations/${escalation.id}`, AGENT)).body.state, 'open');
  });

  test('get only the read tools over MCP', async () => {
    assert.deepEqual(await toolNames(WATCHER), [
      'export_data',
      'find_requirements',
      'get_attachment',
      'get_escalation',
      'get_requirement',
      'get_ticket',
      'get_updates',
      'list_epics',
      'list_escalations',
      'list_groups',
      'list_lanes',
      'list_products',
      'list_projects',
      'list_tickets',
      'read_conversation',
      'wait_for_decisions',
    ]);
    assert.equal((await srv.tool(WATCHER, 'list_lanes', {})).isError, false);
    assert.equal((await srv.tool(WATCHER, 'read_conversation', { group_id: 'main' })).isError, false);
    assert.match((await srv.tool(WATCHER, 'export_data', { dataset: 'escalations' })).text, /^escalations: rows/);
    // Writing tools aren't there at all.
    for (const name of ['update_lane', 'create_escalation', 'record_requirement', 'acknowledge_escalation', 'upload_attachment']) {
      assert.ok((await srv.tool(WATCHER, name, {})).isError, name);
    }
    const ack = await srv.tool(WATCHER, 'wait_for_decisions', { group_id: 'main', wait_seconds: 0, ack: 1 });
    assert.ok(ack.isError);
    assert.match(ack.text, /read-only/);
    assert.ok((await srv.tool(WATCHER, 'get_updates', { group_id: 'main', ack: 1 })).isError);
  });

  test("what it's handed doesn't count as handed to the agent with its name", async () => {
    await srv.call('PUT', '/api/groups/watched', AGENT, {});
    const note = (await srv.call('POST', '/api/groups/watched/messages', ALICE, { body: 'For the overseer' })).body;
    const seenByObserver = (await srv.tool(WATCHER, 'wait_for_decisions', { group_id: 'watched', wait_seconds: 0 })).value;
    assert.deepEqual(seenByObserver.items.map((i: { id: string }) => i.id), [String(note.id)]);
    // From the observer's checkedAt, the agent still gets the note as new: it was never handed to the agent.
    const agent = (await srv.tool(AGENT, 'wait_for_decisions', { group_id: 'watched', wait_seconds: 0, since: seenByObserver.checkedAt })).value;
    assert.deepEqual(agent.items.map((i: { id: string; seen?: boolean }) => [i.id, i.seen]), [[String(note.id), undefined]]);
  });

  test('account observer keys, unbound or bound to one project', async () => {
    assert.equal((await srv.call('POST', '/api/projects', ALICE, { id: 'shop', key: 'SH', name: 'Shop' })).status, 201);
    const ivy = await signIn('Ivy', 'ivy@example.com');
    assert.equal((await srv.call('PUT', `/api/projects/default/members/${ivy.id}`, ALICE, { role: 'admin' })).status, 204);
    assert.equal((await srv.call('PUT', `/api/projects/shop/members/${ivy.id}`, ALICE, { role: 'member' })).status, 204);
    const create = (metadata: unknown) => srv.call('POST', '/api/auth/api-key/create', ivy.token, { name: 'ivy-watch', metadata });

    const unbound = await create({ role: 'observer' });
    assert.equal(unbound.status, 200, JSON.stringify(unbound.body));
    const me = (await srv.call('GET', '/api/me', unbound.body.key)).body;
    assert.equal(me.role, 'observer');
    assert.equal(me.userId, ivy.id);
    // Its owner's projects, as a member even where its owner is an admin.
    const projects = (await srv.call('GET', '/api/projects', unbound.body.key)).body;
    assert.deepEqual(projects.map((p: { id: string; role: string }) => [p.id, p.role]).sort(), [['default', 'member'], ['shop', 'member']]);
    assert.equal((await srv.call('PATCH', '/api/projects/default', unbound.body.key, { name: 'nope' })).status, 403);
    assert.equal((await srv.call('GET', '/api/projects/default/members', unbound.body.key)).status, 403);

    const bound = await create({ role: 'observer', project: 'shop' });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.deepEqual((await srv.call('GET', '/api/projects', bound.body.key)).body.map((p: { id: string }) => p.id), ['shop']);
    assert.equal((await srv.call('GET', '/api/lanes/auth?project=default', bound.body.key)).status, 404);
    assert.equal((await srv.call('GET', `/api/escalations/${escalation.id}`, bound.body.key)).status, 404);
    assert.equal((await srv.call('PUT', '/api/lanes/cart', bound.body.key, { group: 'main', status: 'active' })).status, 403);

    // Bound to a project its owner can't see: it reaches nothing.
    const elsewhere = await signIn('Jo', 'jo@example.com');
    await srv.call('DELETE', `/api/projects/default/members/${elsewhere.id}`, ALICE);
    const stray = (await srv.call('POST', '/api/auth/api-key/create', elsewhere.token, { name: 'jo-watch', metadata: { role: 'observer', project: 'shop' } })).body.key;
    assert.deepEqual((await srv.call('GET', '/api/projects', stray)).body, []);
  });

  test('an observer key is revoked like any other', async () => {
    const kim = await signIn('Kim', 'kim@example.com');
    const created = (await srv.call('POST', '/api/auth/api-key/create', kim.token, { name: 'kim-watch', metadata: { role: 'observer' } })).body;
    assert.equal((await srv.call('GET', '/api/lanes', created.key)).status, 200);
    assert.equal((await srv.call('POST', '/api/auth/api-key/delete', kim.token, { keyId: created.id })).status, 200);
    assert.equal((await srv.call('GET', '/api/lanes', created.key)).status, 401);
  });

  test('key metadata takes "observer", and a project for it, but nothing else new', async () => {
    const kit = await signIn('Kit', 'kit@example.com');
    for (const metadata of [{ role: 'viewer' }, { role: 'observer', extra: 1 }, { role: 'observer', project: 'Not An Id' }]) {
      assert.equal((await srv.call('POST', '/api/auth/api-key/create', kit.token, { name: 'x', metadata })).status, 400, JSON.stringify(metadata));
    }
  });
});
