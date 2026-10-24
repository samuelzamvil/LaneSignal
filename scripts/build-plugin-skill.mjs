// Writes the plugin's skill (plugin/skills/lanesignal/SKILL.md): the skill a server with the default
// features hands out at /api/skill (answering in LaneSignal and requirements on). Run after editing
// skills/lanesignal/; a test checks the two stay the same.
import { readFileSync, writeFileSync } from 'node:fs';

const part = (name) => readFileSync(new URL(`../skills/lanesignal/${name}`, import.meta.url), 'utf8');
const text = part('SKILL.md') + `\n${part('decisions.md')}` + `\n${part('requirements.md')}`;
const out = new URL('../plugin/skills/lanesignal/SKILL.md', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(out, 'utf8') !== text) {
    console.error('plugin/skills/lanesignal/SKILL.md is out of date: run node scripts/build-plugin-skill.mjs');
    process.exit(1);
  }
} else writeFileSync(out, text);
