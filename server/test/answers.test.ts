// Accept / Reject / Other answers, and files attached to escalations.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AGENT, ALICE, REVIEWER, startServer } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer({ LANESIGNAL_ATTACHMENT_MAX_MB: '1', LANESIGNAL_ATTACHMENTS_PER_ITEM: '2' });
  await srv.publish('plan', { group: 'payments' });
});
after(() => srv.close());

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function upload(token: string, name: string, data: Uint8Array | string) {
  const form = new FormData();
  form.append('note', 'ignored');
  form.append('file', new Blob([data]), name);
  const res = await fetch(`${srv.base}/api/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: (await res.json()) as any };
}
const ask = async (question: string, extra: Record<string, unknown> = {}) =>
  srv.tool(AGENT, 'create_escalation', { lane_id: 'plan', question, ...extra });
const full = async (id: string) => (await srv.call('GET', `/api/escalations/${id}`, ALICE)).body;
const decide = (id: string, decision: string, note?: string) =>
  srv.call('POST', `/api/escalations/${id}/decide`, ALICE, { decision, note });

describe('answers', () => {
  test('the agent says what Accept and Reject mean', async () => {
    const e = (await ask('Drop legacy_role?', { accept_means: 'Drop it in 0042', reject_means: 'Keep it for a release' })).value;
    const got = await full(e.id);
    assert.equal(got.acceptMeans, 'Drop it in 0042');
    assert.equal(got.rejectMeans, 'Keep it for a release');
    assert.equal(got.allowReject, true);
    assert.equal((await decide(e.id, 'Reject')).status, 200);
  });

  test('Reject only where offered; Other only with instructions', async () => {
    const e = (await ask('Rotate the key now?', { accept_means: 'Rotate it', allow_reject: false, reject_means: 'ignored' })).value;
    const got = await full(e.id);
    assert.equal(got.allowReject, false);
    assert.equal(got.rejectMeans, null);
    const reject = await decide(e.id, 'Reject');
    assert.equal(reject.status, 400);
    assert.match(reject.body.error, /didn't offer Reject/);
    assert.equal((await decide(e.id, 'Other', '  ')).status, 400);
    const other = await decide(e.id, 'Other', 'Rotate after the release');
    assert.equal(other.status, 200);
    assert.equal(other.body.decisionNote, 'Rotate after the release');
  });
});

describe('attachments', () => {
  test('a plan and a screenshot are attached, and readable by people who see the escalation', async () => {
    const plan = await upload(AGENT, '../../plan.md', '# Plan\n\n1. Drop the column\n');
    assert.equal(plan.status, 201, JSON.stringify(plan.body));
    assert.deepEqual({ name: plan.body.name, type: plan.body.type }, { name: 'plan.md', type: 'text/markdown' });
    const shot = await upload(AGENT, 'preview.bin', PNG);
    assert.equal(shot.body.type, 'image/png');
    const e = await ask('Approve the plan?', { attachments: [plan.body.id, shot.body.id] });
    assert.equal(e.isError, false, e.text);
    const got = await full(e.value.id);
    assert.deepEqual(
      got.attachments.map((a: any) => a.name),
      ['plan.md', 'preview.bin'],
    );
    const file = await fetch(`${srv.base}/api/attachments/${plan.body.id}`, { headers: { authorization: `Bearer ${ALICE}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
    assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(await file.text(), '# Plan\n\n1. Drop the column\n');
    // Exports name the files but never carry them.
    const csv = (await srv.call('GET', '/api/export/escalations.csv', ALICE)).body as string;
    assert.match(csv, /plan\.md \(text\/markdown, \d+ bytes\)/);
  });

  test("only safe types are accepted, recognised by content", async () => {
    for (const [name, data] of [
      ['ui.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
      ['page.html', '<html><script>alert(1)</script></html>'],
      ['fake.png', 'not a png'],
      ['binary.txt', Uint8Array.from([0x41, 0, 0x42])],
    ] as const) {
      const res = await upload(AGENT, name, data);
      assert.equal(res.status, 400, name);
    }
    // A real image is an image whatever it's called.
    assert.equal((await upload(AGENT, 'shot.svg', PNG)).body.type, 'image/png');
  });

  test('size and count limits', async () => {
    assert.equal((await upload(AGENT, 'big.txt', 'x'.repeat(1024 * 1024 + 1))).status, 400);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await upload(AGENT, `p${i}.md`, `# ${i}`)).body.id);
    const res = await ask('Three files?', { attachments: ids });
    assert.equal(res.isError, true);
    assert.match(res.text, /At most 2 attachments/);
  });

  test("an upload is only usable by its uploader, once", async () => {
    const mine = (await upload(AGENT, 'mine.md', '# mine')).body.id;
    // Before it's attached, only its uploader can read it.
    assert.equal((await srv.call('GET', `/api/attachments/${mine}`, REVIEWER)).status, 404);
    assert.equal((await srv.call('GET', `/api/attachments/${mine}`, AGENT)).status, 200);
    await srv.publish('theirs', { group: 'search', token: REVIEWER });
    const stolen = await srv.tool(REVIEWER, 'create_escalation', { lane_id: 'theirs', question: 'Steal?', attachments: [mine] });
    assert.equal(stolen.isError, true);
    assert.match(stolen.text, /not found: upload it first/);
    assert.equal((await ask('First use?', { attachments: [mine] })).isError, false);
    const again = await ask('Second use?', { attachments: [mine] });
    assert.match(again.text, /already on another escalation/);
  });

  test('an upload needs a file field', async () => {
    const res = await srv.call('POST', '/api/attachments', AGENT, { file: 'plan' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /multipart\/form-data/);
  });
});
