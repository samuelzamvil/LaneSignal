# Accounts and agent keys

Humans sign in with accounts. Agents use **agent keys** that belong to those accounts. Both are handled by [Better Auth](https://better-auth.com), on LaneSignal's own SQLite database.

## First run

A fresh server has no accounts, and there is no public sign-up. The first account:

- is created on the app's **Create admin account** screen
- needs the one-time **setup code** the server prints to its log and writes to `/data/setup-code`, so whoever reaches the server first can't claim it
- becomes the **admin**

```bash
docker compose logs lanesignal | grep setupCode
# or
docker compose exec lanesignal cat /data/setup-code
```

A static human token from the config (`LANESIGNAL_HUMAN_TOKENS`) can also complete setup in place of the code. Send it as `Authorization: Bearer …` to `POST /api/setup`.

## People

Admins manage people under **Settings → People**:

- **Add a person:** enter a name, an email and a temporary password, and optionally make them an admin. Share the password with them; they can change it under **Settings → Change password**. With one [project](projects.md) they join it straight away; with several, add them to projects under **Settings → Projects**.
- **Remove a person:** their sessions and agent keys stop working at once, including streams that are already open.

People can't rename themselves, because names are what decisions are attributed to.

## Agent keys

Every person can create keys under **Settings → Keys**:

1. Name the key after the overseer that will use it (e.g. `payments-overseer`). That name is shown as the agent on its lanes.
2. Copy the key (`ls_…`) right away. It's shown once and only a hash is stored.
3. Settings then shows everything an overseer needs, each with a copy button:
   - the command that adds LaneSignal to Claude Code:

     ```bash
     claude mcp add --transport http lanesignal https://lanesignal.example.com/mcp \
       --header "Authorization: Bearer ls_…"
     ```
   - the command that installs the [skill](agents.md#3-install-the-skill-how-to-use-lanesignal)
   - an `env` block for `.claude/settings.local.json` (URL, key, group, and project when the key needs one), for the skill's long waits
   - the starter [policy](agent-instructions.md) for the overseer's `CLAUDE.md`

### Personal keys

Pick **Personal key** instead of **Agent key** to use LaneSignal from your own Claude session. A personal key acts as you:

- It gets the human tools (`dismiss_escalation`, the read tools, and `decide_escalation` when answering on the dashboard is on), and what it does shows your name.
- It can't publish lanes or raise escalations.
- It can't manage accounts, even if you're an admin.

Keys are marked *personal* in the list.

**Revoke** a key from the same list. Any agent using it is cut off immediately, including its open long-polls. The list shows when each key was last used.

## Sessions

- A sign-in lasts `LANESIGNAL_SESSION_DAYS` (default 90) days without being used. Each use, at most once a day, extends it, so a phone you open now and then stays signed in.
- **Sign out** ends the session on the server, not just on the device.
- **Change password** keeps the current device signed in and signs out every other device.
- **Admin password reset** signs the person out everywhere.
- **Banning** a person (Better Auth's admin API) blocks their sign-in and their keys. A temporary ban lifts by itself when it expires.

## Locked out (break-glass)

Static human tokens from the server config still work, and can manage people even when no admin can sign in:

```bash
# reset someone's password (also signs them out everywhere)
curl -X POST https://lanesignal.example.com/api/admin/people/password \
  -H "authorization: Bearer $HUMAN_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"a new password"}'

# add a person (optionally an admin)
curl -X POST https://lanesignal.example.com/api/admin/people \
  -H "authorization: Bearer $HUMAN_TOKEN" -H 'content-type: application/json' \
  -d '{"email":"ops@example.com","name":"Ops","password":"temporary password","admin":true}'
```

Set one with `LANESIGNAL_HUMAN_TOKENS=ops:<openssl rand -base64 24>`, recreate the container, use it, then remove it again if you like.

## Static tokens

`LANESIGNAL_HUMAN_TOKENS` and `LANESIGNAL_AGENT_TOKENS` (`name:token` pairs) still work beside accounts:

- **Human tokens:** break-glass access, and scripts that decide escalations.
- **Agent tokens:** CI jobs or agents you don't want tied to a person.

They can only be changed by editing the config and restarting.
