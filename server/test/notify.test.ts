import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { startNotifier } from '../src/notify.ts';
import { Store } from '../src/store.ts';

test('ntfy receives escalations only, not routine lane updates', async () => {
  const received: { title: string; body: string; click?: string }[] = [];
  const sink = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ title: String(req.headers.title), body, click: req.headers.click as string | undefined });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => sink.listen(0, r));
  const config = loadConfig({
    LANESIGNAL_CONFIG: '/nonexistent.json',
    LANESIGNAL_AGENT_TOKENS: 'bot:agent-token-0123456789',
    LANESIGNAL_NTFY_URL: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/topic`,
    LANESIGNAL_PUBLIC_URL: 'https://ls.example/',
  });
  const store = new Store({ path: ':memory:', resolveTicketUrl: () => null });
  assert.deepEqual(startNotifier(config, store), { fcm: false, ntfy: true });

  store.upsertLane('lane-1', { name: 'Lane one', status: 'pending_ci' }, 'bot');
  const esc = store.createEscalation({ laneId: 'lane-1', title: 'Ship it?' }, 'bot');
  store.decideEscalation(esc.id, 'yes', null, 'alice');
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(received.length, 1);
  assert.equal(received[0].title, 'Decision needed · Lane one');
  assert.equal(received[0].body, 'Ship it?');
  assert.equal(received[0].click, `https://ls.example/#/esc/${esc.id}`);
  sink.close();
  store.close();
});
