# LaneSignal: notes for Claude

## Workflow (the maintainer's standing rules)

- Before opening a PR, run an adversarial subagent review of the change and fix what it finds.
- Drive every PR you open to green: CI (test, docker, android) passing, no conflicts, review findings handled.
- **Don't ask whether to merge.** Once a PR is green and the review findings are handled, merge it into `main` yourself, then check that CI on `main` passes after the merge.
- Never use the multiple-choice question dialog. If you need to ask something, ask in plain text and include enough context that it can be answered without reading code.

## Project

- `server/`: Node 22 + Express 5 + `node:sqlite`, Better Auth accounts, MCP at `POST /mcp`. Tests: `npm test` from the repo root.
- `web/`: React + Vite, shared with the Capacitor Android app (`web/capacitor.config.ts`).
- `docs/`: the wiki. Update it alongside behaviour changes.
