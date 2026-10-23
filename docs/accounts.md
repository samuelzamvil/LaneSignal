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

- **Add a person:** enter a name, an email and a temporary password, and optionally make them an admin. Share the password with them; they can change it under **Settings → Change password**.
- **Remove a person:** their sessions and agent keys stop working at once, including streams that are already open.

People can't rename themselves, because names are what decisions are attributed to.

## Agent keys

Every person can create keys under **Settings → Agent keys**:

1. Name the key after the overseer that will use it (e.g. `payments-overseer`). That name is shown as the agent on its lanes.
2. Copy the key (`ls_…`) right away. It's shown once and only a hash is stored.
3. Settings also shows a ready-to-paste command:

   ```bash
   claude mcp add --transport http lanesignal https://lanesignal.example.com/mcp \
     --header "Authorization: Bearer ls_…"
   ```

**Revoke** a key from the same list. Any agent using it is cut off immediately, including its open long-polls. The list shows when each key was last used.

## Sessions

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
