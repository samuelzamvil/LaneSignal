# Security model

## Credentials and roles

Every request carries one bearer credential, which gets one of two roles:

| Credential | Role | Can |
|---|---|---|
| Agent key (`ls_…`) or static agent token | **agent** | Publish groups and lanes; remove lanes; raise escalations and dismiss its own; with `LANESIGNAL_DECISIONS=true`, also acknowledge them and add positions |
| Account session, personal key or static human token | **human** | Dismiss stale escalations, remove lanes and groups, register phones for push; with `LANESIGNAL_DECISIONS=true`, also decide escalations |

- Each person sees only the [projects](projects.md) they're a member of; other projects' data is invisible to them and their keys. An agent key can be bound to one project.
- Project **admins** manage that project's members. Account **admins** manage people, create projects, and see every project as admin.
- Static human tokens can use the break-glass routes.
- Agents can't decide escalations. Dismissals and decisions are attributed to the key's or account's name.

## Accounts

[Better Auth](https://better-auth.com) (MIT) handles accounts. It's a maintained library rather than auth code written for this project. For LaneSignal it's configured like this:

- **Sign-up:** there is none for the public. The first account needs a one-time setup code from the server log, and admins add everyone else.
- **Passwords:** hashed with scrypt, 10 to 128 characters.
- **Sessions:** signed bearer tokens, so a token copied out of the database is useless without the server's secret. Cookies are ignored, so the API is bearer-only.
- **Rate limiting:** sign-in is limited per client IP. The IP comes from the socket, or from `X-Forwarded-For` as far as `LANESIGNAL_TRUST_PROXY` allows. That's only trustworthy when your proxy is the only way in ([Reverse proxy](reverse-proxy.md)). Better Auth's own client-IP headers are never read from the request.
- **Revocation:** sign-out, password change (other devices), admin password reset, removal and bans all take effect immediately.
- **Admin controls:** impersonation is disabled, and only admins change names.
- **Telemetry:** off.

## Agent keys

- Stored hashed and shown once.
- Owned by an account. Revoking a key, or removing or banning its owner, disables it.
- Better Auth's built-in per-key rate limit (10 requests a day) is turned off, so long-running agents work.
- **By design**, anyone with an account can create agent keys, and so can publish lane state. They are the people running the agents.
- **By design**, any agent key can publish to or remove any lane and publish to any group. Removing another overseer's lane dismisses that overseer's open questions on it. Overseers on one install are trusted alike; give each overseer its own group and lane ids.
- **Dismissing and acknowledging:** only the agent that raised an escalation (the same key, or a newer key with the same name on the same account) can dismiss or acknowledge it, and an agent must give a justification to dismiss. People can dismiss any escalation they can see.
- **Requirements:** any agent key can record or supersede a requirement and must name the human decision behind it.
  - A cited escalation is checked: the agent must have raised it, or it must come from a lane in the requirement's group, and it must be in the requirement's project. If it was decided on the dashboard, its decider is recorded; otherwise the agent names who decided with `decided_by`.
  - A `decided_by` name is the agent's attestation, which the server can't verify. People review requirements in the app and can retire them.
- **Personal keys** act as their owner (dismissing, and deciding when that's on). They can't publish lanes or manage accounts. Key metadata is limited to this role flag.

## Revocation reaches open connections

Event streams, long-polls and MCP waits stop as soon as their credential is revoked: sign-out, key revocation, password change or reset, ban, or removal. Event streams also re-check on every 25s heartbeat. A removed person's open app stops receiving data at once, and a revoked key's waiting agent gets an error straight away. Push notifications skip phones registered by people who were removed or are banned.

## Input and output

- All input is validated with zod, and link URLs must be http(s).
- The UI renders agent-supplied text as text, and only auto-links http(s) URLs.
- Static tokens are compared in constant time against SHA-256 digests.
- Attachments are recognised by their content: Markdown and text (valid UTF-8, named `.md` or `.txt`) and PNG, JPEG, WebP or GIF images. Everything else, SVG and HTML included, is refused. Files are served with their own type, `nosniff` and a sandboxing `Content-Security-Policy`, only to callers who can see the escalation's project (or, before it's attached, to the key that uploaded it). The app renders Markdown as its own elements, never as HTML.
- Only `/api/events` accepts a token as a query parameter (`?access_token=`), for clients that can't send headers. The bundled apps send headers.

## Your part

- Serve it over HTTPS ([Reverse proxy](reverse-proxy.md)), and don't expose port 8080 directly to the internet.
- Set `LANESIGNAL_TRUST_PROXY` to match your proxy chain, and only trust a proxy that is the sole way in. Never set it to `true`.
- Create the admin account soon after first start. The setup code sits in the log until you do.
- Treat agent keys like passwords. Keep them in environment variables, not in git.
- Back up the data volume, including `auth-secret` ([Operations](operations.md)).
