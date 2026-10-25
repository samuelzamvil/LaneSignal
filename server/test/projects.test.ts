// Several projects on one server: each with its own lanes, codes and members.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
/** Session tokens for people with accounts. */
const people: Record<string, { token: string; id: string }> = {};

async function person(name: string, email: string) {
  const password = 'correct horse battery';
  const created = await srv.call('POST', '/api/admin/people', ALICE, { email, name, password });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const res = await fetch(`${srv.base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: srv.base },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  people[name] = { token: res.headers.get('set-auth-token')!, id: created.body.id };
}

before(async () => {
  srv = await startServer({ LANESIGNAL_SIGNIN_RATE_MAX: '50' });
  await person('Pat', 'pat@example.com');
  await person('Quinn', 'quinn@example.com');
});
after(() => srv.close());

describe('one project', () => {
  test('existing data lives in the default project and nobody has to name it', async () => {
    const projects = (await srv.call('GET', '/api/projects', ALICE)).body;
    assert.deepEqual(
      projects.map((p: any) => [p.id, p.key, p.role]),
      [['default', 'MAIN', 'admin']],
    );
    const lane = await srv.call('PUT', '/api/lanes/auth', AGENT, { status: 'active' });
    assert.equal(lane.status, 200);
    assert.equal(lane.body.id, 'auth');
    assert.equal(lane.body.project, 'default');
  });
});

describe('several projects', () => {
  test('instance admins create projects; others cannot; ids and keys are unique', async () => {
    const created = await srv.call('POST', '/api/projects', ALICE, { id: 'shop', key: 'SH', name: 'Shop' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await srv.call('POST', '/api/projects', ALICE, { id: 'shop', key: 'XX', name: 'Again' })).status, 409);
    assert.equal((await srv.call('POST', '/api/projects', ALICE, { id: 'other', key: 'sh', name: 'Same key' })).status, 409);
    assert.equal((await srv.call('POST', '/api/projects', people.Pat.token, { id: 'mine', key: 'MI', name: 'Mine' })).status, 403);
    assert.equal((await srv.call('POST', '/api/projects', ALICE, { id: 'Bad Id', key: 'B', name: 'x' })).status, 400);
  });

  test('a credential that reaches several projects names one only where an id is new or ambiguous', async () => {
    // An overseer that was running before the second project appeared keeps working.
    const existing = await srv.call('PUT', '/api/lanes/auth', AGENT, { status: 'active' });
    assert.equal(existing.status, 200, JSON.stringify(existing.body));
    assert.equal(existing.body.project, 'default');
    const res = await srv.call('PUT', '/api/lanes/brand-new', AGENT, { status: 'active' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Say which project: (MAIN, SH|SH, MAIN)/);
    // By id or by key.
    assert.equal((await srv.call('PUT', '/api/lanes/auth?project=sh', AGENT, { status: 'idle' })).status, 200);
    assert.equal((await srv.call('PUT', '/api/lanes/auth?project=default', AGENT, { status: 'active' })).status, 200);
    // Now "auth" is in both: ambiguous again.
    const both = await srv.call('PUT', '/api/lanes/auth', AGENT, { status: 'active' });
    assert.equal(both.status, 400);
    assert.match(both.body.error, /Say which project/);
  });

  test('lane ids and codes are per project; KEY-500A names one across projects', async () => {
    for (const p of ['default', 'shop']) assert.equal((await srv.call('PUT', `/api/lanes/auth?project=${p}`, AGENT, { ticket: '500' })).status, 200);
    const main = (await srv.call('POST', '/api/escalations?project=default', AGENT, { laneId: 'auth', question: 'Main?' })).body;
    const shop = (await srv.call('POST', '/api/escalations?project=shop', AGENT, { laneId: 'auth', question: 'Shop?' })).body;
    assert.equal(main.ref, '500A');
    assert.equal(shop.ref, '500A');
    assert.equal(shop.projectKey, 'SH');
    assert.equal((await srv.call('GET', '/api/escalations/SH-500A', ALICE)).body.id, shop.id);
    assert.equal((await srv.call('GET', `/api/escalations/${encodeURIComponent('MAIN·500A')}`, ALICE)).body.id, main.id);
    assert.equal((await srv.call('GET', '/api/escalations/500A?project=shop', ALICE)).body.id, shop.id);
    // A key reaching several projects reads digest codes with their project key.
    await srv.call('POST', `/api/escalations/${shop.id}/decide`, ALICE, { decision: 'Accept' });
    const digest = (await srv.call('GET', '/api/wait?lane=auth&project=shop&timeout=0', AGENT)).body;
    assert.deepEqual(digest.items.map((i: any) => [i.kind, i.code]), [['decided', 'SH-500A']]);
    const lanes = (await srv.call('GET', '/api/lanes', ALICE)).body;
    assert.deepEqual(
      lanes.filter((l: any) => l.id === 'auth').map((l: any) => l.project).sort(),
      ['default', 'shop'],
    );
  });

  test('people see only the projects they belong to', async () => {
    // Pat and Quinn were added while there was one project, so they joined it.
    assert.deepEqual((await srv.call('GET', '/api/projects', people.Pat.token)).body.map((p: any) => p.id), ['default']);
    assert.equal((await srv.call('DELETE', `/api/projects/default/members/${people.Quinn.id}`, ALICE)).status, 204);
    // Quinn is in no project now.
    assert.deepEqual((await srv.call('GET', '/api/projects', people.Quinn.token)).body, []);
    assert.deepEqual((await srv.call('GET', '/api/snapshot', people.Quinn.token)).body.lanes, []);
    // Alice (config token) admits Quinn to the shop as a member.
    assert.equal((await srv.call('PUT', `/api/projects/shop/members/${people.Quinn.id}`, ALICE, { role: 'member' })).status, 204);
    const snap = (await srv.call('GET', '/api/snapshot', people.Quinn.token)).body;
    assert.deepEqual([...new Set(snap.lanes.map((l: any) => l.project))], ['shop']);
    assert.deepEqual(snap.escalations.map((e: any) => e.question), ['Shop?']);
  });

  test("another project's data is invisible, not just read-only", async () => {
    const main = (await srv.call('GET', '/api/escalations?project=default', ALICE)).body.find((e: any) => e.question === 'Main?');
    const q = people.Quinn.token;
    assert.equal((await srv.call('GET', `/api/escalations/${main.id}`, q)).status, 404);
    assert.equal((await srv.call('POST', `/api/escalations/${main.id}/decide`, q, { decision: 'x' })).status, 404);
    assert.equal((await srv.call('GET', '/api/lanes/auth?project=default', q)).status, 404);
    const rows = (await srv.call('GET', '/api/export/escalations.json', q)).body;
    assert.deepEqual([...new Set(rows.map((r: any) => r.project))], ['shop']);
  });

  test('project admins manage members; members cannot', async () => {
    const q = people.Quinn.token;
    assert.equal((await srv.call('PUT', `/api/projects/shop/members/${people.Pat.id}`, q, { role: 'member' })).status, 403);
    assert.equal((await srv.call('PUT', `/api/projects/shop/members/${people.Quinn.id}`, ALICE, { role: 'admin' })).status, 204);
    assert.equal((await srv.call('PUT', `/api/projects/shop/members/${people.Pat.id}`, q, { role: 'member' })).status, 204);
    const members = (await srv.call('GET', '/api/projects/shop/members', q)).body;
    assert.deepEqual(members.map((m: any) => [m.name, m.role]).sort(), [['Pat', 'member'], ['Quinn', 'admin']]);
    assert.equal((await srv.call('PATCH', '/api/projects/shop', q, { name: 'Shop app' })).body.name, 'Shop app');
    assert.equal((await srv.call('PATCH', '/api/projects/default', q, { name: 'nope' })).status, 404, 'not a member there');
    assert.equal((await srv.call('DELETE', `/api/projects/shop/members/${people.Pat.id}`, q)).status, 204);
  });

  test('push can be turned off per project, by each person for themselves', async () => {
    const q = people.Quinn.token;
    assert.equal((await srv.call('PUT', '/api/projects/shop/notifications', q, { enabled: false })).status, 204);
    const mine = (await srv.call('GET', '/api/projects', q)).body.find((p: any) => p.id === 'shop');
    assert.equal(mine.notify, false);
    assert.equal(srv.store.membershipsOf(people.Quinn.id).get('shop')?.notify, false);
  });

  test('an agent key can be bound to one project, and then needs no project parameter', async () => {
    const created = await srv.call('POST', '/api/auth/api-key/create', people.Quinn.token, {
      name: 'shop-overseer',
      metadata: { role: 'agent', project: 'shop' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const key = created.body.key;
    assert.equal((await srv.call('PUT', '/api/lanes/cart', key, { status: 'active' })).body.project, 'shop');
    assert.deepEqual((await srv.call('GET', '/api/projects', key)).body.map((p: any) => p.id), ['shop']);
    assert.equal((await srv.call('PUT', '/api/lanes/cart?project=default', key, { status: 'active' })).status, 404);
    const tools = await srv.tool(key, 'list_lanes', {});
    assert.ok(tools.value.every((l: any) => l.project === 'shop'));
  });

  test('requirements: ids are global; all-projects ones are seen everywhere, project ones only there', async () => {
    const everywhere = await srv.call('POST', '/api/requirements?project=default', ALICE, {
      requirement: 'All apps store money as integers in minor units.',
      justification: 'Rounding drift.',
      tags: ['money-amounts'],
      allProjects: true,
    });
    assert.equal(everywhere.status, 201, JSON.stringify(everywhere.body));
    assert.equal(everywhere.body.requirement.project, null);
    const mainOnly = await srv.call('POST', '/api/requirements?project=default', ALICE, {
      requirement: 'The main app supports SSO.',
      justification: 'Customers asked.',
      tags: ['sso-login'],
    });
    assert.equal(mainOnly.body.requirement.project, 'default');
    const quinnSees = (await srv.call('GET', '/api/requirements', people.Quinn.token)).body.map((r: any) => r.id);
    assert.ok(quinnSees.includes(everywhere.body.requirement.id));
    assert.ok(!quinnSees.includes(mainOnly.body.requirement.id));
    assert.equal((await srv.call('GET', `/api/requirements/${mainOnly.body.requirement.id}`, people.Quinn.token)).status, 404);
    const viaMcp = await srv.tool(AGENT, 'find_requirements', { query: 'money', project: 'shop' });
    assert.deepEqual(viaMcp.value.map((r: any) => r.id), [everywhere.body.requirement.id]);
  });

  test('the event stream only carries the caller’s projects, and ends when memberships change', { timeout: 5000 }, async () => {
    const ctrl = new AbortController();
    try {
      const res = await fetch(`${srv.base}/api/events`, { headers: { authorization: `Bearer ${people.Quinn.token}` }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      await srv.call('PUT', '/api/lanes/secret?project=default', AGENT, { activity: 'main only' });
      await srv.call('PUT', '/api/lanes/visible?project=shop', AGENT, { activity: 'shop lane' });
      while (!text.includes('shop lane')) {
        const { done, value } = await reader.read();
        if (done) throw new Error('stream ended early');
        text += decoder.decode(value, { stream: true });
      }
      assert.ok(!text.includes('main only'));
      // A membership change closes the stream so the client reconnects with what it may now see.
      await srv.call('PUT', `/api/projects/default/members/${people.Quinn.id}`, ALICE, { role: 'member' });
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      ctrl.abort();
    }
  });
});

describe('review findings', () => {
  before(async () => {
    await person('Rae', 'rae@example.com');
    assert.equal((await srv.call('PUT', `/api/projects/shop/members/${people.Rae.id}`, ALICE, { role: 'member' })).status, 204);
  });

  test("a key bound to a project its owner can't see reaches nothing", async () => {
    for (const project of ['default', 'ghost']) {
      const key = (
        await srv.call('POST', '/api/auth/api-key/create', people.Rae.token, { name: `bound-${project}`, metadata: { role: 'agent', project } })
      ).body.key;
      assert.deepEqual((await srv.call('GET', '/api/projects', key)).body, []);
      assert.equal((await srv.call('GET', '/api/lanes/auth', key)).status, 404);
      assert.equal((await srv.call('PUT', '/api/lanes/auth', key, { status: 'idle' })).status, 404);
      assert.equal((await srv.call('POST', '/api/escalations', key, { laneId: 'auth', question: 'x' })).status, 404);
      assert.equal((await srv.call('PUT', '/api/groups/ops', key, { name: 'x' })).status, 404);
    }
  });

  test('a project id cannot take another project\'s key, and ids win over keys', async () => {
    assert.equal((await srv.call('POST', '/api/projects', ALICE, { id: 'main', key: 'ZZ', name: 'x' })).status, 409);
    assert.equal((await srv.call('POST', '/api/projects', ALICE, { id: 'zz', key: 'SHOP', name: 'x' })).status, 409);
  });

  test('bare codes resolve within your own projects only; ambiguous ones ask for a project', async () => {
    // Rae sees only the shop, so 500A there is unambiguous even though the main project has a 500A.
    const shopA1 = (await srv.call('GET', '/api/escalations/500A', people.Rae.token)).body;
    assert.equal(shopA1.project, 'shop');
    const both = await srv.call('GET', '/api/escalations/500A', ALICE);
    assert.equal(both.status, 400);
    assert.match(both.body.error, /several projects/);
    // An id with the wrong project is not found.
    assert.equal((await srv.call('GET', `/api/escalations/${shopA1.id}?project=default`, ALICE)).status, 404);
  });

  test('all-projects requirements: only instance admins write them; others see only what they may in `similar`', async () => {
    const shopKey = (
      await srv.call('POST', '/api/auth/api-key/create', people.Rae.token, { name: 'shop-only', metadata: { role: 'agent', project: 'shop' } })
    ).body.key;
    const body = { requirement: 'Invoices are exported nightly.', justification: 'x', tags: ['invoice-export'], decidedBy: 'Sam' };
    assert.equal((await srv.call('POST', '/api/requirements', shopKey, { ...body, allProjects: true })).status, 403);
    assert.equal((await srv.call('POST', '/api/requirements', people.Rae.token, { ...body, allProjects: true })).status, 403);
    const secret = await srv.call('POST', '/api/requirements?project=default', ALICE, { ...body, requirement: 'Main: invoices are exported nightly.' });
    assert.equal(secret.status, 201);
    const global = await srv.call('POST', '/api/requirements', ALICE, { ...body, allProjects: true });
    assert.equal(global.status, 201);
    assert.equal((await srv.call('POST', `/api/requirements/${global.body.requirement.id}/supersede`, shopKey, body)).status, 403);
    assert.equal((await srv.call('POST', `/api/requirements/${global.body.requirement.id}/retire`, people.Rae.token)).status, 403);
    const mine = await srv.call('POST', '/api/requirements?project=shop', people.Rae.token, body);
    assert.equal(mine.status, 201);
    const similar = mine.body.similar.map((r: any) => r.id);
    assert.ok(similar.includes(global.body.requirement.id));
    assert.ok(!similar.includes(secret.body.requirement.id), 'another project\'s requirement leaked');
  });

  test("a requirement can't cite another project's escalation", async () => {
    const res = await srv.call('POST', '/api/requirements?project=default', ALICE, {
      requirement: 'Guest checkout is allowed.',
      justification: 'x',
      tags: ['guest-checkout'],
      sourceEscalation: 'SH-500A',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /another project/);
  });

  test('turning push off for a project you are not in grants nothing', async () => {
    srv.store.setNotify('shop', people.Pat.id, false);
    assert.equal(srv.store.membershipsOf(people.Pat.id).has('shop'), false);
    assert.equal(srv.store.notifyChoice('shop', people.Pat.id), false);
  });
});

