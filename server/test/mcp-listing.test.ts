// What tools/list and initialize advertise: trimmed for tokens, while every argument is still validated.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { slimSchema } from '../src/mcp.ts';
import { AGENT, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer();
});
after(() => srv.close());

async function rpc(method: string, params: unknown = {}) {
  const res = await fetch(`${srv.base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${AGENT}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const msgs = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  return (msgs.find((m) => 'result' in m) ?? JSON.parse(text)).result;
}

test('the conventions every tool shares are said once, in the server instructions', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.match(init.instructions, /`project`/);
  assert.match(init.instructions, /967A/);
});

test('tools/list leaves out $schema, validation-only limits and the group alias', async () => {
  const { tools } = await rpc('tools/list');
  const all = JSON.stringify(tools);
  assert.ok(!all.includes('$schema'));
  assert.ok(!all.includes('"minLength"'));
  assert.ok(!all.includes('Project id/key'), 'project is described once, in the instructions');
  const lanes = tools.find((t: { name: string }) => t.name === 'list_lanes');
  assert.ok('group_id' in lanes.inputSchema.properties && !('group' in lanes.inputSchema.properties));
  const esc = tools.find((t: { name: string }) => t.name === 'create_escalation').inputSchema.properties;
  assert.equal(esc.question.maxLength, 1000, 'limits on text an agent writes stay');
  assert.equal(esc.context.maxLength, undefined, 'a 20,000-character limit nobody reaches is left out');
  assert.deepEqual(esc.context.type, ['string', 'null']);
  const ack = tools.find((t: { name: string }) => t.name === 'acknowledge_escalation').inputSchema.properties;
  assert.match(ack.id.description, /967A/, 'ids still say codes work, for clients that drop instructions');
});

test('the alias and the limits are still enforced', async () => {
  await srv.tool(AGENT, 'update_group', { group_id: 'listing', name: 'Listing' });
  assert.equal((await srv.tool(AGENT, 'list_lanes', { group: 'listing' })).isError, false);
  assert.equal((await srv.tool(AGENT, 'list_lanes', { group: 'nope' })).isError, true);
  const long = await srv.tool(AGENT, 'notify_owner', { lane_id: 'x'.repeat(101), message: 'hi' });
  assert.equal(long.isError, true);
});

test('slimSchema leaves nullable enums alone and keeps the outer description', () => {
  const out = slimSchema({
    type: 'object',
    properties: {
      e: { anyOf: [{ type: 'string', enum: ['x', 'y'] }, { type: 'null' }] },
      d: { description: 'outer', anyOf: [{ type: 'string', description: 'inner' }, { type: 'null' }] },
    },
  }) as any;
  assert.ok(out.properties.e.anyOf, 'a nullable enum keeps its anyOf, so null stays allowed');
  assert.deepEqual(out.properties.d, { description: 'outer', type: ['string', 'null'] });
});

test('slimSchema keeps a nullable type and nested items', () => {
  const out = slimSchema({
    type: 'object',
    properties: { a: { anyOf: [{ type: 'string', maxLength: 20000 }, { type: 'null' }] }, b: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } } },
  }) as any;
  assert.deepEqual(out.properties.a, { type: ['string', 'null'] });
  assert.deepEqual(out.properties.b, { type: 'array', items: { type: 'string' } });
});
