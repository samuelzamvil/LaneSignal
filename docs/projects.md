# Projects

One LaneSignal server can run several independent **projects**, such as one per application. Each project has its own:

- groups, lanes and escalations
- lane letters and escalation codes: the shop's first question is **A1**, and so is the main app's
- members, and its own push-notification setting for each of them

Requirements are global: ids (`R14`) are unique across the server. Each requirement either belongs to one project or applies to **all projects** ("all our apps store money as integers").

A server starts with one project, **Main** (id `default`, key `MAIN`). Data from before projects existed lives there. While there's only one project, nothing changes: nobody has to name it, and the web app shows no project switcher (Settings lists the one project).

## A project

| Field | Meaning |
|---|---|
| `id` | Stable, lowercase: `shop`. Agents and URLs use it |
| `key` | 2–10 letters or digits, shown in uppercase before codes where projects mix: **SH·A1**. Unique |
| `name` | Shown in the app: "Shop app" |

## Who sees what

| Credential | Projects | Role |
|---|---|---|
| Static config token (`LANESIGNAL_*_TOKENS`) | all | admin |
| Account admin (and keys they own) | all | admin |
| Person | the ones they're a member of | `member` or `admin`, per project |
| Agent key | its owner's projects, or the one project the key is bound to | — |

- Another project's data is invisible, not just read-only: its lanes, escalations, requirements, events and exports don't exist for you.
- On a server with one project, new people join it. With several, new people belong to no project until a project admin adds them, and their inbox says so.
- Member lists include the account admins (marked *instance admin*), who see every project without being members.
- A project **admin** can rename the project, change its key, add people, change their role and remove them. A **member** sees the project and answers its escalations. There are no finer permissions.
- Only instance admins (account admins and static human tokens) create projects. The creator becomes the new project's admin.
- When an account is removed, its memberships go with it.
- Access is re-checked when it changes: open event streams restart, and a long wait that returns after someone lost a project leaves that project's escalations out.

## In the web app

With more than one project, a switcher appears in the top bar:

- **All projects** (the combined view): every project's lanes and questions together. Codes carry the project key (**SH·A1**), and group names carry it too.
- **One project**: only that project, with plain codes (**A1**). The choice is remembered on the device.

Settings → **Projects** lists your projects. In it:

- **Notify** turns push notifications for that project on or off, for your own devices.
- **Members and settings** shows the members. Project admins manage them there, and rename the project.
- **New project** (instance admins only) creates one.

When creating an agent key with access to several projects, choose **All my projects** or **Only** one project. A bound key needs no `project` parameter and can't reach anything else. One overseer per project usually wants a bound key. If its owner leaves that project, the key reaches nothing.

## Agents and the API

- **`project` parameter:** every MCP tool takes an optional `project` (id or key), and every HTTP endpoint takes `?project=`.
- **Leaving it out:** when it's left out, the request acts on the key's bound project, or the caller's only project.
  - A credential that reaches several projects doesn't need it for an existing lane or group: the id is looked up in its projects. So overseers that were running before a second project appeared keep working.
  - A new id, or one that exists in several of its projects, needs `project`. Otherwise the request fails with `Say which project: MAIN, SH`.
  - Listings without `project` cover every project the caller can see.
- **`project` field:** lanes, groups, escalations and requirements carry a `project` field. Escalations also carry `projectKey`.
- **Escalation codes:** a code names one escalation across projects with its key: `SH-A1`, `SH·A1` or `SH:A1`. A bare `A1` works with `project`, or when only one of your projects has an `A1`; otherwise the error lists the keyed codes to choose from.
- **`list_projects`** (MCP) and `GET /api/projects` list the projects a credential reaches.
- **All-projects requirements:** record a requirement for every project with `all_projects: true` (MCP) or `allProjects: true` (HTTP). Only credentials that see every project write these: instance admins, static tokens, and keys owned by an account admin that aren't bound to one project. The same goes for superseding, editing or retiring one. `find_requirements` in a project returns that project's requirements plus the all-projects ones.
- **Citations:** a project's requirement can only cite that project's escalations.

## Notifications

A push for a new escalation goes to the people whose devices are registered, if all of these hold:

- they can see its project
- they haven't turned **Notify** off for that project

Account admins who aren't members of a project still get its pushes until they turn them off. With several projects, the title carries the key: `Decision needed SH·A1 · …`.
