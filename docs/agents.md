# Connecting agents (MCP)

Agents talk to LaneSignal over MCP: a stateless Streamable HTTP endpoint at `POST /mcp`. Plain HTTP works too; see the [HTTP API](api.md).

## 1. Create a key

In LaneSignal, go to **Settings → Agent keys** and create one key per overseer, named after it (e.g. `payments-overseer`). That name is shown as the agent on its lanes. See [Agent keys](accounts.md#agent-keys).

## 2. Add the MCP server

### Claude Code

```bash
claude mcp add --transport http lanesignal https://lanesignal.example.com/mcp \
  --header "Authorization: Bearer ls_…"
```

Settings shows this command with your key already filled in. It registers the server for you only (local scope).

To share the server through the repository's `.mcp.json`, don't add `--scope project` to that command, because it would write the key itself into a committed file. Write `.mcp.json` with an environment variable instead, and set `LANESIGNAL_KEY` on each machine:

```json
{
  "mcpServers": {
    "lanesignal": {
      "type": "http",
      "url": "https://lanesignal.example.com/mcp",
      "headers": { "Authorization": "Bearer ${LANESIGNAL_KEY}" }
    }
  }
}
```

### Other MCP clients

Any client that supports Streamable HTTP with custom headers works. Point it at `https://<host>/mcp` and send the header `Authorization: Bearer ls_…`.

## 3. Tell the overseer how to report

Paste the [agent instructions snippet](agent-instructions.md) into the overseer's `CLAUDE.md`. It covers:

- registering the group once
- publishing real state changes rather than heartbeats
- how to structure an escalation
- waiting for answers without polling

## Tools

Which tools a client sees depends on its credential: agent keys get the agent tools, and human sessions get `decide_escalation`.

| Tool | Who | Purpose |
|---|---|---|
| `update_group` | agent | Name the epic/train, set its ticket, link the overseer's Remote Control session |
| `update_lane` | agent | Create or update a lane: status, group, ticket, activity, links. Omitted fields stay unchanged |
| `create_escalation` | agent | Ask humans a question (see the [fields](concepts.md#escalations)) |
| `add_position` | agent | Agree, disagree or stay neutral on an open escalation's recommendation, with a reason |
| `get_escalation` | any | Read one escalation. `wait_seconds` (up to 300) waits until it's answered, so there's no polling loop |
| `acknowledge_escalation` | agent | Confirm you received a decision and are acting on it. This closes the escalation |
| `withdraw_escalation` | agent | Close it without a dashboard answer: answered in Remote Control, or moot |
| `list_lanes` / `list_groups` / `list_escalations` | any | Read state |
| `export_data` | any | All data for analysis (escalations, positions, lanes, groups, history) as CSV or JSON, paged. See [Export](export.md) |
| `decide_escalation` | human | Lets a human's own Claude session answer from the conversation |

## Waiting for a decision

`get_escalation` with `wait_seconds: 300` holds the request until a human decides, or until it times out and returns the escalation still `open`. Call it again while the state is `open`.

Behind a reverse proxy, the proxy's read timeout must be above 300s, or use a shorter `wait_seconds`. See [Reverse proxy](reverse-proxy.md).

If the key is revoked while the agent is waiting, the call fails.
