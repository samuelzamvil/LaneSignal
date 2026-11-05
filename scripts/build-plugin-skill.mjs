// Writes the plugin's skill (plugin/skills/lanesignal/SKILL.md): the skill a server with the default
// features hands out at /api/skill (answering in LaneSignal and requirements on), and the relay beside it
// (relay.mjs, served at /api/skill/relay.mjs). Run after editing skills/lanesignal/, and bump "version" in
// plugin/.claude-plugin/plugin.json: Claude Code won't update an installed plugin whose version hasn't changed.
// A test checks these files match what the server serves; with --check, this only checks them.
import { readFileSync, writeFileSync } from 'node:fs';

const part = (name) => readFileSync(new URL(`../skills/lanesignal/${name}`, import.meta.url), 'utf8');
// As the server's skillText: usage blocks kept, their markers removed.
const text = (part('SKILL.md') + `\n${part('decisions.md')}` + `\n${part('requirements.md')}`)
  .replace(/\r\n/g, '\n')
  .replace(/^<!-- \/?usage -->$\n?/gm, '')
  .replace(/\n{3,}/g, '\n\n');
const files = { 'SKILL.md': text, 'relay.mjs': part('relay.mjs') };
let stale = false;
for (const [name, content] of Object.entries(files)) {
  const out = new URL(`../plugin/skills/lanesignal/${name}`, import.meta.url);
  if (!process.argv.includes('--check')) {
    writeFileSync(out, content);
    continue;
  }
  let current = null;
  try {
    current = readFileSync(out, 'utf8');
  } catch {}
  if (current !== content) {
    console.error(`plugin/skills/lanesignal/${name} is out of date: run node scripts/build-plugin-skill.mjs`);
    stale = true;
  }
}
if (stale) process.exit(1);
