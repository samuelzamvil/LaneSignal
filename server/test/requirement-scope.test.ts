// Requirement scope: global, project-wide or products; products people manage and lock.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { Store } from '../src/store.ts';
import { AGENT, ALICE, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
  await srv.tool(AGENT, 'update_group', { group_id: 'alpha', name: 'Alpha train' });
});
after(() => srv.close());

const base = { justification: 'Agreed in review.' };
const record = (args: Record<string, unknown>) =>
  srv.call('POST', '/api/requirements', AGENT, { ...base, decidedBy: 'Sam', ...args });
const get = async (id: string) => (await srv.call('GET', `/api/requirements/${id}`, ALICE)).body;

describe('products', () => {
  test('people add them; agents read them but cannot add or change them', async () => {
    const made = await srv.call('POST', '/api/products', ALICE, { id: 'Product-A', name: 'Product A', color: '#3b82f6' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.id, 'product-a');
    assert.equal(made.body.locked, false);
    assert.equal((await srv.call('POST', '/api/products', ALICE, { id: 'product-b', name: 'Product B' })).status, 201);
    assert.equal((await srv.call('POST', '/api/products', ALICE, { id: 'product-a', name: 'Again' })).status, 409);
    assert.equal((await srv.call('POST', '/api/products', AGENT, { id: 'product-c', name: 'Product C' })).status, 403);
    assert.equal((await srv.call('PATCH', '/api/products/product-a', AGENT, { locked: true })).status, 403);
    const listed = (await srv.call('GET', '/api/products', AGENT)).body;
    assert.deepEqual(listed.map((p: { id: string }) => p.id), ['product-a', 'product-b']);
  });

  test('bad ids and colours are rejected', async () => {
    assert.equal((await srv.call('POST', '/api/products', ALICE, { id: 'has space', name: 'X' })).status, 400);
    assert.equal((await srv.call('POST', '/api/products', ALICE, { id: 'product-x', name: 'X', color: 'blue' })).status, 400);
  });
});

describe('recording with a scope', () => {
  test('products, project-wide and global are stored as chosen, and nothing needs regrouping', async () => {
    const two = await record({ requirement: 'Product A and B share one login.', scope: 'products', products: ['product-b', 'product-a'] });
    assert.equal(two.status, 201, JSON.stringify(two.body));
    assert.equal(two.body.requirement.scope, 'products');
    assert.deepEqual(two.body.requirement.products, ['product-a', 'product-b']);
    assert.equal(two.body.requirement.needsRegrouping, false);
    assert.equal(two.body.requirement.status, 'pending', 'an agent record waits for approval');

    const wide = await record({ requirement: 'Every release has a changelog entry.', scope: 'project' });
    assert.equal(wide.body.requirement.scope, 'project');
    assert.equal(wide.body.requirement.status, 'pending');

    const global = await srv.call('POST', '/api/requirements', ALICE, { ...base, requirement: 'Timestamps are UTC.', scope: 'global' });
    assert.equal(global.status, 201, JSON.stringify(global.body));
    assert.equal(global.body.requirement.scope, 'global');
    assert.equal(global.body.requirement.project, null);
  });

  test('products alone imply the products scope', async () => {
    const res = await record({ requirement: 'Product B exports CSV.', products: ['product-b'] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.requirement.scope, 'products');
  });

  test('an unknown product, an empty list or a mismatched scope is rejected', async () => {
    const unknown = await record({ requirement: 'X.', scope: 'products', products: ['product-z'] });
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /product-a, product-b/);
    assert.equal((await record({ requirement: 'X.', scope: 'products' })).status, 400);
    assert.equal((await record({ requirement: 'X.', scope: 'project', products: ['product-a'] })).status, 400);
    assert.equal((await record({ requirement: 'X.', scope: 'products', allProjects: true, products: ['product-a'] })).status, 400);
  });

  test('without a scope it is refused, from agents and people alike', async () => {
    const res = await record({ requirement: 'Unscoped record.' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Say where it applies/);
    assert.equal((await srv.call('POST', '/api/requirements', ALICE, { ...base, requirement: 'Unscoped record.' })).status, 400);
  });
});

describe('filtering by scope', () => {
  test('product, project-wide and global filters match exactly that scope', async () => {
    const ids = (r: { body: { requirement: string }[] }) => r.body.map((x) => x.requirement);
    const a = ids(await srv.call('GET', '/api/requirements?product=product-a', ALICE));
    assert.deepEqual(a, ['Product A and B share one login.']);
    const b = ids(await srv.call('GET', '/api/requirements?product=product-b', ALICE));
    assert.ok(b.includes('Product B exports CSV.') && b.includes('Product A and B share one login.'));
    const wide = ids(await srv.call('GET', '/api/requirements?scope=project', ALICE));
    assert.ok(wide.includes('Every release has a changelog entry.'));
    assert.ok(!wide.includes('Product B exports CSV.'));
    assert.deepEqual(ids(await srv.call('GET', '/api/requirements?scope=global', ALICE)), ['Timestamps are UTC.']);
  });
});

describe('a person changes the scope', () => {
  test('in place, logged, without re-approval; the agent cannot', async () => {
    const id = (await srv.call('POST', '/api/requirements', ALICE, { ...base, requirement: 'Product A ships weekly.', scope: 'project' })).body.requirement.id;
    assert.equal((await srv.call('PUT', `/api/requirements/${id}/scope`, AGENT, { scope: 'products', products: ['product-a'] })).status, 403);
    const moved = await srv.call('PUT', `/api/requirements/${id}/scope`, ALICE, { scope: 'products', products: ['product-a'] });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.id, id, 'same id');
    assert.equal(moved.body.status, 'active', 'no re-approval');
    assert.deepEqual(moved.body.products, ['product-a']);
    const changes = (await srv.call('GET', `/api/requirements/${id}/changes`, ALICE)).body;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].actor, 'alice');
    assert.deepEqual(changes[0].from, { scope: 'project', project: 'default', products: [] });
    assert.deepEqual(changes[0].to, { scope: 'products', project: 'default', products: ['product-a'] });
  });

  test('saving the scope it already has logs nothing', async () => {
    const id = (await srv.call('POST', '/api/requirements', ALICE, { ...base, requirement: 'Product B is read-mostly.', scope: 'products', products: ['product-b'] })).body.requirement.id;
    assert.equal((await srv.call('PUT', `/api/requirements/${id}/scope`, ALICE, { scope: 'products', products: ['product-b'] })).status, 200);
    assert.deepEqual((await srv.call('GET', `/api/requirements/${id}/changes`, ALICE)).body, []);
  });

  test('approving can set the scope in the same step', async () => {
    const id = (await record({ requirement: 'Product B keeps 90 days of history.', scope: 'project' })).body.requirement.id;
    const res = await srv.call('POST', `/api/requirements/${id}/approve`, ALICE, { scope: 'products', products: ['product-b'] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'active');
    assert.deepEqual(res.body.products, ['product-b']);
    assert.equal((await srv.call('GET', `/api/requirements/${id}/changes`, ALICE)).body.length, 1);
  });

  test('moving to global keeps the citation, qualified', async () => {
    await srv.publish('scope-lane');
    const e = (await srv.tool(AGENT, 'create_escalation', { lane_id: 'scope-lane', question: 'Logs in UTC?' })).value;
    await srv.call('POST', `/api/escalations/${e.ref}/decide`, ALICE, { decision: 'yes' });
    const id = (
      await srv.call('POST', '/api/requirements', AGENT, { ...base, requirement: 'Logs are in UTC.', scope: 'project', sourceEscalation: e.ref })
    ).body.requirement.id;
    assert.equal((await get(id)).scope, 'project');
    const moved = await srv.call('PUT', `/api/requirements/${id}/scope`, ALICE, { scope: 'global' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.project, null);
    assert.equal(moved.body.needsRegrouping, false);
    assert.equal(moved.body.status, 'pending', 'rescoping is not approving');
    assert.match(moved.body.sourceEscalation, /^[A-Z][A-Za-z0-9]*-/);
  });
});

describe('locks', () => {
  test('a locked product refuses agents, not people', async () => {
    const id = (await record({ requirement: 'Product A uses one database.', scope: 'products', products: ['product-a'] })).body.requirement.id;
    const locked = await srv.call('PATCH', '/api/products/product-a', ALICE, { locked: true });
    assert.equal(locked.body.locked, true);

    const recorded = await record({ requirement: 'Product A caches for 5 minutes.', scope: 'products', products: ['product-a'] });
    assert.equal(recorded.status, 403);
    assert.match(recorded.body.error, /locked/);
    const superseded = await srv.call('POST', `/api/requirements/${id}/supersede`, AGENT, { ...base, decidedBy: 'Sam', requirement: 'Product A uses two databases.' });
    assert.equal(superseded.status, 403);

    const byPerson = await srv.call('POST', '/api/requirements', ALICE, { ...base, requirement: 'Product A caches for 5 minutes.', scope: 'products', products: ['product-a'] });
    assert.equal(byPerson.status, 201, JSON.stringify(byPerson.body));
    assert.equal((await srv.call('PUT', `/api/requirements/${id}/scope`, ALICE, { scope: 'products', products: ['product-a', 'product-b'] })).status, 200);
    await srv.call('PATCH', '/api/products/product-a', ALICE, { locked: false });
    assert.equal((await record({ requirement: 'Product A caches for 1 minute.', scope: 'products', products: ['product-a'] })).status, 201);
  });

  test('a personal key cannot edit, retire or restore a locked product\'s requirement', async () => {
    await srv.call('POST', '/api/admin/people', ALICE, { email: 'lee@example.com', name: 'Lee', password: 'correct horse battery' });
    const signIn = await fetch(`${srv.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: srv.base },
      body: JSON.stringify({ email: 'lee@example.com', password: 'correct horse battery' }),
    });
    const personal = (await srv.call('POST', '/api/auth/api-key/create', signIn.headers.get('set-auth-token')!, { name: 'lee-claude', metadata: { role: 'human' } })).body.key;
    await srv.call('POST', '/api/products', ALICE, { id: 'product-l', name: 'Product L' });
    const id = (await srv.call('POST', '/api/requirements', ALICE, { ...base, requirement: 'Product L has no plugins.', scope: 'products', products: ['product-l'] })).body.requirement.id;
    await srv.call('PATCH', '/api/products/product-l', ALICE, { locked: true });
    assert.equal((await srv.call('PATCH', `/api/requirements/${id}`, personal, { requirement: 'Product L has plugins.' })).status, 403);
    assert.equal((await srv.call('POST', `/api/requirements/${id}/retire`, personal)).status, 403);
    assert.equal((await srv.call('POST', `/api/requirements/${id}/retire`, ALICE)).status, 200);
    assert.equal((await srv.call('POST', `/api/requirements/${id}/restore`, personal)).status, 403);
    // Archived meanwhile: restoring would put it back on a product nobody can pick.
    await srv.call('PATCH', '/api/products/product-l', ALICE, { locked: false, archived: true });
    assert.equal((await srv.call('POST', `/api/requirements/${id}/restore`, ALICE)).status, 409);
    await srv.call('PATCH', '/api/products/product-l', ALICE, { archived: false });
    assert.equal((await srv.call('POST', `/api/requirements/${id}/restore`, ALICE)).status, 200);
  });

  test('a supersede without a scope keeps the old one\'s', async () => {
    const id = (await record({ requirement: 'Product B pages are paginated by 50.', scope: 'products', products: ['product-b'] })).body.requirement.id;
    const res = await srv.call('POST', `/api/requirements/${id}/supersede`, AGENT, { ...base, decidedBy: 'Sam', requirement: 'Product B pages are paginated by 25.' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.requirement.scope, res.body.requirement.products, res.body.requirement.needsRegrouping], ['products', ['product-b'], false]);
  });
});

describe('agents (MCP)', () => {
  const tool = (name: string, args: Record<string, unknown>) => srv.tool(AGENT, name, args);

  test('find_requirements returns the products asked for, plus project-wide and global, once each, without justification', async () => {
    await srv.call('POST', '/api/products', ALICE, { id: 'product-c', name: 'Product C' });
    const only = (await srv.call('POST', '/api/requirements', ALICE, { ...base, requirement: 'Product C only rule.', scope: 'products', products: ['product-c'] })).body.requirement.id;
    const res = await tool('find_requirements', { products: ['product-a', 'product-b'] });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(res.value.scope, { project: 'default', products: ['product-a', 'product-b'] });
    const list = res.value.requirements;
    const texts = list.map((r: { requirement: string }) => r.requirement);
    assert.ok(texts.includes('Product A and B share one login.'), 'in both products');
    assert.ok(texts.includes('Product B exports CSV.'));
    assert.ok(texts.includes('Every release has a changelog entry.'), 'project-wide');
    assert.ok(texts.includes('Timestamps are UTC.'), 'global');
    assert.ok(!list.some((r: { id: string }) => r.id === only), 'not another product\'s');
    assert.equal(new Set(list.map((r: { id: string }) => r.id)).size, list.length, 'each once');
    assert.ok(list.every((r: Record<string, unknown>) => r.justification === undefined && r.decidedBy === undefined));
    const shared = list.find((r: { requirement: string }) => r.requirement === 'Product A and B share one login.');
    assert.deepEqual([shared.scope, shared.products], ['products', ['product-a', 'product-b']]);

    const projectOnly = (await tool('find_requirements', { project_only: true })).value.requirements.map((r: { requirement: string }) => r.requirement);
    assert.ok(projectOnly.includes('Every release has a changelog entry.') && projectOnly.includes('Timestamps are UTC.'));
    assert.ok(!projectOnly.includes('Product B exports CSV.'));
  });

  test('find_requirements refuses a call that says neither, or names an unknown product', async () => {
    const neither = await tool('find_requirements', { query: 'login' });
    assert.equal(neither.isError, true);
    assert.match(neither.text, /product-a/);
    assert.equal((await tool('find_requirements', { products: ['product-a'], project_only: true })).isError, true);
    assert.match((await tool('find_requirements', { products: ['nope'] })).text, /Product "nope" not found/);
  });

  test('every agent record is pending, whatever its scope', async () => {
    for (const scope of [{ scope: 'products', products: ['product-a'] }, { scope: 'project' }]) {
      const res = await tool('record_requirement', { requirement: `Pending check ${scope.scope}.`, justification: 'J.', decided_by: 'Sam', ...scope });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.value.requirement.status, 'pending', scope.scope);
    }
    // A static agent token sees every project, so it may propose a global rule; it still waits for approval.
    const global = await tool('record_requirement', { requirement: 'Pending check global.', justification: 'J.', decided_by: 'Sam', scope: 'global' });
    assert.equal(global.isError, false, global.text);
    assert.equal(global.value.requirement.status, 'pending');
  });

  test('record_requirement requires a scope; a locked product refuses it', async () => {
    const unscoped = await tool('record_requirement', { requirement: 'No scope.', justification: 'J.', decided_by: 'Sam' });
    assert.equal(unscoped.isError, true);
    await srv.call('PATCH', '/api/products/product-c', ALICE, { locked: true });
    const locked = await tool('record_requirement', { requirement: 'C rule.', justification: 'J.', decided_by: 'Sam', scope: 'products', products: ['product-c'] });
    assert.match(locked.text, /locked/);
    await srv.call('PATCH', '/api/products/product-c', ALICE, { locked: false });
  });

  test('get_requirement adds the justification only when asked; list_products shows locks', async () => {
    const id = (await tool('find_requirements', { project_only: true, query: 'changelog' })).value.requirements[0].id;
    assert.equal((await tool('get_requirement', { id })).value.justification, undefined);
    assert.equal((await tool('get_requirement', { id, include_justification: true })).value.justification, 'Agreed in review.');
    await srv.call('PATCH', '/api/products/product-b', ALICE, { locked: true });
    const products = (await tool('list_products', {})).value;
    assert.deepEqual(products.find((p: { id: string }) => p.id === 'product-b')?.locked, true);
    assert.equal(products.find((p: { id: string }) => p.id === 'product-a')?.locked, undefined);
    await srv.call('PATCH', '/api/products/product-b', ALICE, { locked: false });
  });

  test('project_only: false is just leaving it out', async () => {
    const res = await tool('find_requirements', { products: ['product-a'], project_only: false });
    assert.equal(res.isError, false, res.text);
  });

  test('the REST search can ask for everything that applies to some products', async () => {
    const texts = (await srv.call('GET', '/api/requirements?applies_to=product-b', AGENT)).body.map((r: { requirement: string }) => r.requirement);
    assert.ok(texts.includes('Product B exports CSV.') && texts.includes('Every release has a changelog entry.') && texts.includes('Timestamps are UTC.'));
    assert.ok(!texts.includes('Product C only rule.'));    assert.equal((await srv.call('GET', '/api/requirements?applies_to=product-b&scope=global', AGENT)).status, 400);
  });
});

describe('archiving', () => {
  test('refused while requirements are in force; hidden from the list once archived', async () => {
    await srv.call('POST', '/api/products', ALICE, { id: 'product-old', name: 'Old' });
    const id = (await srv.call('POST', '/api/requirements', ALICE, { ...base, requirement: 'Old product is read-only.', scope: 'products', products: ['product-old'] })).body.requirement.id;
    assert.equal((await srv.call('PATCH', '/api/products/product-old', ALICE, { archived: true })).status, 409);
    await srv.call('PUT', `/api/requirements/${id}/scope`, ALICE, { scope: 'project' });
    assert.equal((await srv.call('PATCH', '/api/products/product-old', ALICE, { archived: true })).status, 200);
    assert.ok(!(await srv.call('GET', '/api/products', ALICE)).body.some((p: { id: string }) => p.id === 'product-old'));
    assert.ok((await srv.call('GET', '/api/products?archived=true', ALICE)).body.some((p: { id: string }) => p.id === 'product-old'));
    assert.equal((await record({ requirement: 'X.', scope: 'products', products: ['product-old'] })).status, 404);
  });
});

describe('export', () => {
  test('requirements carry scope and products; products and scope changes have their own files', async () => {
    const reqs = (await srv.call('GET', '/api/export/requirements.json', ALICE)).body;
    const shared = reqs.find((r: { requirement: string }) => r.requirement === 'Product A and B share one login.');
    assert.equal(shared.scope, 'products');
    assert.equal(shared.products, 'product-a | product-b');
    const products = (await srv.call('GET', '/api/export/products.json', ALICE)).body;
    assert.ok(products.some((p: { id: string; archived: boolean }) => p.id === 'product-old' && p.archived));
    const changes = (await srv.call('GET', '/api/export/requirement_changes.json', ALICE)).body;
    assert.ok(changes.length >= 3);
    assert.ok(changes.every((c: { kind: string }) => c.kind === 'scope'));
  });
});

test('upgrading flags requirements in force for regrouping, keeping them project-wide or global', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lanesignal-'));
  const file = path.join(dir, 'db.sqlite');
  try {
    let store = new Store({ path: file, resolveTicketUrl: () => null });
    const wide = store.recordRequirement({ requirement: 'One.', justification: 'J.', scope: 'project', project: 'default', decidedBy: 'Sam' }, 'bot');
    const all = store.recordRequirement({ requirement: 'Two.', justification: 'J.', scope: 'global', project: null, decidedBy: 'Sam' }, 'bot');
    const gone = store.recordRequirement({ requirement: 'Three.', justification: 'J.', scope: 'project', project: 'default', decidedBy: 'Sam' }, 'bot');
    store.rejectRequirement(gone.requirement.id, 'No.');
    store.close();

    const db = new DatabaseSync(file);
    db.exec(`
      DROP TABLE requirement_changes;
      DROP TABLE requirement_products;
      DROP TABLE products;
      ALTER TABLE requirements DROP COLUMN scope;
      ALTER TABLE requirements DROP COLUMN needs_regrouping;
      UPDATE meta SET value = '19' WHERE key = 'schema_version';
    `);
    db.close();

    store = new Store({ path: file, resolveTicketUrl: () => null });
    const one = store.getRequirement(wide.requirement.id)!;
    const two = store.getRequirement(all.requirement.id)!;
    const three = store.getRequirement(gone.requirement.id)!;
    assert.deepEqual([one.scope, one.needsRegrouping], ['project', true]);
    assert.deepEqual([two.scope, two.needsRegrouping], ['global', true]);
    assert.deepEqual([three.scope, three.needsRegrouping], ['project', false], 'rejected ones are not put up for regrouping');
    // A person choosing its scope clears the flag, even when it stays project-wide.
    assert.equal(store.setRequirementScope(one.id, { scope: 'project', project: 'default' }, 'Sam').needsRegrouping, false);
    assert.equal(store.requirementChanges(one.id).length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a supersede into another project must say where it applies there', () => {
  const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
  store.createProject({ id: 'other', key: 'OT', name: 'Other' }, null);
  const old = store.recordRequirement({ requirement: 'Old.', justification: 'J.', scope: 'project', project: 'default', decidedBy: 'Sam' }, 'Sam', true);
  assert.throws(
    () => store.supersedeRequirement(old.requirement.id, { requirement: 'New.', justification: 'J.', project: 'other', decidedBy: 'Sam' }, 'Sam', true),
    /say where it applies/,
  );
  const moved = store.supersedeRequirement(old.requirement.id, { requirement: 'New.', justification: 'J.', project: 'other', scope: 'project', decidedBy: 'Sam' }, 'Sam', true);
  assert.equal(moved.requirement.project, 'other');
  store.close();
});
