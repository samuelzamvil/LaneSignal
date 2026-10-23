import { useCallback, useEffect, useState } from 'react';
import {
  isNative,
  type AgentKey,
  type Client,
  type Person,
  type Principal,
  type ProjectAccess,
  type ProjectMember,
  type ProjectRole,
} from './api.ts';
import { absolute, ago } from './format.ts';

function useAsync<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    load()
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, [load]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function PasswordSection({ client, onNewSession }: { client: Client; onNewSession: (token: string) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const token = await client.changePassword(current, next);
      setStatus('Password changed. Other devices were signed out.');
      setCurrent('');
      setNext('');
      onNewSession(token);
    } catch (err) {
      setStatus(errorText(err));
    }
  }

  return (
    <details className="settings-block">
      <summary>Change password</summary>
      <form onSubmit={submit} className="stack">
        <input type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        <input type="password" placeholder="New password (10+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
        <button className="primary">Change password</button>
        {status && <p className="hint">{status}</p>}
      </form>
    </details>
  );
}

/** Agent keys owned by the signed-in account; each key is shown once, at creation. */
export function AgentKeysSection({
  client,
  serverUrl,
  now,
  projects,
}: {
  client: Client;
  serverUrl: string;
  now: number;
  projects: ProjectAccess[];
}) {
  const load = useCallback(() => client.listKeys(), [client]);
  const { data: keys, error, reload } = useAsync(load);
  const [name, setName] = useState('');
  const [role, setRole] = useState<'agent' | 'human'>('agent');
  /** '' = every project the owner can see. */
  const [project, setProject] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string; role: 'agent' | 'human' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      const k = await client.createKey(name.trim(), role, role === 'agent' && project ? project : undefined);
      setCreated({ name: name.trim(), key: k.key, role });
      setName('');
      reload();
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: AgentKey) {
    if (!confirm(`Revoke "${k.name}"? Agents using it stop working immediately.`)) return;
    try {
      await client.deleteKey(k.id);
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  const mcpCommand = created
    ? `claude mcp add --transport http lanesignal ${serverUrl}/mcp --header "Authorization: Bearer ${created.key}"`
    : '';
  const skillCommand = `mkdir -p .claude/skills/lanesignal && curl -fsS ${serverUrl}/api/skill -o .claude/skills/lanesignal/SKILL.md`;

  return (
    <section className="settings-block">
      <h3>Keys</h3>
      <p className="hint">
        Give each overseer its own <strong>agent key</strong>; the key name is shown as the agent on its lanes. A{' '}
        <strong>personal key</strong> is for your own Claude session: it answers escalations as you (decisions show your
        name) but can't publish lanes. Keys belong to your account and stop working if you revoke them or your account is
        removed.
      </p>
      <form onSubmit={create} className="inline-form">
        <select value={role} onChange={(e) => setRole(e.target.value as 'agent' | 'human')} aria-label="Key type">
          <option value="agent">Agent key</option>
          <option value="human">Personal key</option>
        </select>
        {role === 'agent' && projects.length > 1 && (
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">All my projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                Only {p.name}
              </option>
            ))}
          </select>
        )}
        <input
          placeholder={role === 'agent' ? 'Key name, e.g. payments-overseer' : 'Key name, e.g. my-laptop-claude'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
          required
        />
        <button className="primary" disabled={busy}>
          Create
        </button>
      </form>
      {created && (
        <div className="new-key" role="status">
          <p>
            <strong>{created.name}</strong>: copy this key now. It won't be shown again.
          </p>
          <code className="secret">{created.key}</code>
          <p className="hint">Add it to Claude Code:</p>
          <code className="secret">{mcpCommand}</code>
          {created.role === 'agent' && (
            <>
              <p className="hint">Then install the skill that teaches agents how to use LaneSignal (run in the project):</p>
              <code className="secret">{skillCommand}</code>
              <p className="hint">
                For long waits the skill also needs <code>LANESIGNAL_URL</code>, <code>LANESIGNAL_KEY</code> and{' '}
                <code>LANESIGNAL_GROUP</code> in the agent's environment (see Connecting agents in the docs).
              </p>
            </>
          )}
          <div className="actions">
            <button className="ghost" onClick={() => void navigator.clipboard?.writeText(created.key)}>
              Copy key
            </button>
            <button className="ghost" onClick={() => void navigator.clipboard?.writeText(mcpCommand)}>
              Copy command
            </button>
            {created.role === 'agent' && (
              <button className="ghost" onClick={() => void navigator.clipboard?.writeText(skillCommand)}>
                Copy skill command
              </button>
            )}
            <button className="ghost" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
      {(error || actionError) && <p className="error">{error ?? actionError}</p>}
      {keys && keys.length === 0 && <p className="empty">No keys yet.</p>}
      <ul className="rows">
        {keys?.map((k) => (
          <li key={k.id}>
            <div>
              <strong>{k.name ?? 'unnamed'}</strong> <code>{k.start}…</code>
              {k.metadata?.role === 'human' && <span className="tag">personal</span>}
              {k.metadata?.project && (
                <span className="tag">only {projects.find((p) => p.id === k.metadata!.project)?.name ?? k.metadata.project}</span>
              )}
              <div className="muted small">
                created {absolute(k.createdAt)} · {k.lastRequest ? `last used ${ago(k.lastRequest, now)}` : 'never used'}
              </div>
            </div>
            <button className="ghost danger" onClick={() => void revoke(k)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Members of one project; its admins add people, change roles and remove members. */
function ProjectMembers({ client, project, me }: { client: Client; project: ProjectAccess; me: Principal | null }) {
  const load = useCallback(() => client.projectMembers(project.id), [client, project.id]);
  const { data: members, error, reload } = useAsync(load);
  const admin = project.role === 'admin';
  const loadPeople = useCallback(() => (admin ? client.people() : Promise.resolve([])), [client, admin]);
  const { data: people } = useAsync(loadPeople);
  const [adding, setAdding] = useState('');
  const [addRole, setAddRole] = useState<ProjectRole>('member');
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }
  const outsiders = (people ?? []).filter((p) => !members?.some((m) => m.userId === p.id));
  const remove = (m: ProjectMember) =>
    confirm(`Remove ${m.name} from ${project.name}? They stop seeing its lanes and escalations.`) &&
    void run(() => client.removeProjectMember(project.id, m.userId));

  return (
    <div className="stack">
      {(error || actionError) && <p className="error">{error ?? actionError}</p>}
      <ul className="rows">
        {members?.map((m) => (
          <li key={m.userId}>
            <div>
              <strong>{m.name}</strong> {m.role === 'admin' && <span className="tag">admin</span>}
              <div className="muted small">{m.email}</div>
            </div>
            {admin && (
              <div className="actions">
                <select
                  value={m.role}
                  aria-label={`Role of ${m.name}`}
                  onChange={(e) => void run(() => client.setProjectMember(project.id, m.userId, e.target.value as ProjectRole))}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                {m.userId !== me?.userId && (
                  <button className="ghost danger" onClick={() => remove(m)}>
                    Remove
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {members && members.length === 0 && <p className="empty">No members yet.</p>}
      {admin && outsiders.length > 0 && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding) void run(() => client.setProjectMember(project.id, adding, addRole)).then(() => setAdding(''));
          }}
        >
          <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Person to add" required>
            <option value="">Add a person…</option>
            {outsiders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.email})
              </option>
            ))}
          </select>
          <select value={addRole} onChange={(e) => setAddRole(e.target.value as ProjectRole)} aria-label="Role">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button className="primary">Add</button>
        </form>
      )}
    </div>
  );
}

/** Name and key, for project admins. */
function ProjectSettings({ client, project, onChanged }: { client: Client; project: ProjectAccess; onChanged: () => void }) {
  const [name, setName] = useState(project.name);
  const [key, setKey] = useState(project.key);
  const [status, setStatus] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await client.updateProject(project.id, { name: name.trim(), key: key.trim().toUpperCase() });
      setStatus('Saved.');
      onChanged();
    } catch (err) {
      setStatus(errorText(err));
    }
  }
  return (
    <form className="inline-form" onSubmit={save}>
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" maxLength={100} required />
      <input value={key} onChange={(e) => setKey(e.target.value)} aria-label="Project key" maxLength={10} size={6} required />
      <button className="ghost">Save</button>
      {status && <span className="hint">{status}</span>}
    </form>
  );
}

/** Instance admins start new projects; they become its admin. */
function NewProject({ client, onChanged }: { client: Client; onChanged: () => void }) {
  const [form, setForm] = useState({ id: '', key: '', name: '' });
  const [error, setError] = useState<string | null>(null);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await client.createProject({ id: form.id.trim(), key: form.key.trim().toUpperCase(), name: form.name.trim() });
      setForm({ id: '', key: '', name: '' });
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <details>
      <summary>New project</summary>
      <form className="stack" onSubmit={create}>
        <input placeholder="Name, e.g. Shop app" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <input
          placeholder="Id, e.g. shop (lowercase; agents use it)"
          value={form.id}
          onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })}
          autoCapitalize="off"
          required
        />
        <input
          placeholder="Key, e.g. SH (shown before codes: SH·A12)"
          value={form.key}
          onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
          maxLength={10}
          autoCapitalize="characters"
          required
        />
        <p className="hint">Add people to it afterwards; new projects start with only you.</p>
        {error && <p className="error">{error}</p>}
        <button className="primary">Create project</button>
      </form>
    </details>
  );
}

/**
 * Each project has its own lanes, codes and members. Everyone turns push on or off per project;
 * project admins manage members; instance admins create projects.
 */
export function ProjectsSection({
  client,
  me,
  projects,
  onChanged,
}: {
  client: Client;
  me: Principal | null;
  projects: ProjectAccess[];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const canCreate = !!me && me.role === 'human' && (me.superuser || (me.admin && !me.userId));
  const isPerson = !!me?.userId && me.role === 'human';
  async function toggle(p: ProjectAccess) {
    setError(null);
    try {
      await client.setProjectNotify(p.id, !p.notify);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <section className="settings-block">
      <h3>Projects</h3>
      {projects.length === 0 && <p className="empty">You're not in any project yet. Ask a project admin to add you.</p>}
      {error && <p className="error">{error}</p>}
      <ul className="rows">
        {projects.map((p) => (
          <li key={p.id} className="project-row">
            <div className="grow">
              <strong>{p.name}</strong> <code>{p.key}</code> {p.role === 'admin' && <span className="tag">admin</span>}
              <div className="muted small">id {p.id}</div>
              {me?.role === 'human' && (
                <details>
                  <summary>Members{p.role === 'admin' ? ' and settings' : ''}</summary>
                  {p.role === 'admin' && <ProjectSettings client={client} project={p} onChanged={onChanged} />}
                  <ProjectMembers client={client} project={p} me={me} />
                </details>
              )}
            </div>
            {isPerson && (
              <label className="check" title="Push notifications from this project on your devices">
                <input type="checkbox" checked={p.notify} onChange={() => void toggle(p)} /> Notify
              </label>
            )}
          </li>
        ))}
      </ul>
      {canCreate && <NewProject client={client} onChanged={onChanged} />}
    </section>
  );
}

/** Admins add and remove people. There is no public sign-up. */
export function PeopleSection({ client, me }: { client: Client; me: Principal }) {
  const load = useCallback(() => client.listPeople(), [client]);
  const { data: people, error, reload } = useAsync(load);
  const [form, setForm] = useState({ name: '', email: '', password: '', admin: false });
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    try {
      await client.addPerson(form);
      setNotice(`Added ${form.email}. Share the temporary password with them; they can change it in Settings.`);
      setForm({ name: '', email: '', password: '', admin: false });
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  async function remove(p: Person) {
    if (!confirm(`Remove ${p.email}? Their sessions and agent keys stop working.`)) return;
    try {
      await client.removePerson(p.id);
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  return (
    <section className="settings-block">
      <h3>People</h3>
      {(error || actionError) && <p className="error">{error ?? actionError}</p>}
      <ul className="rows">
        {people?.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{p.name}</strong> {p.role === 'admin' && <span className="tag">admin</span>}
              {p.banned && <span className="tag">banned</span>}
              <div className="muted small">{p.email}</div>
            </div>
            {p.id !== me.userId && (
              <button className="ghost danger" onClick={() => void remove(p)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <details>
        <summary>Add a person</summary>
        <form onSubmit={add} className="stack">
          <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoCapitalize="off" required />
          <input
            type="password"
            placeholder="Temporary password (10+ characters)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            autoComplete="new-password"
            minLength={10}
            required
          />
          <label className="check">
            <input type="checkbox" checked={form.admin} onChange={(e) => setForm({ ...form, admin: e.target.checked })} /> Admin (can manage people)
          </label>
          <button className="primary">Add person</button>
        </form>
      </details>
      {notice && <p className="hint">{notice}</p>}
    </section>
  );
}

const DATASETS = ['escalations', 'positions', 'lanes', 'groups', 'events', 'requirements'] as const;

/** Everything (including closed escalations and removed lanes) as CSV for analysis. */
export function ExportSection({ client, serverUrl }: { client: Client; serverUrl: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams({ ...(from && { from }), ...(to && { to }) }).toString();
  const suffix = query ? `?${query}` : '';

  async function get(path: string, name: string) {
    setBusy(true);
    setError(null);
    try {
      await client.download(path + suffix, name);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-block">
      <h3>Export data</h3>
      <p className="hint">
        All escalations (including closed ones), agent positions, lanes, groups, lane history and requirements as CSV.
        Removed lanes and groups are included. The dates filter escalations, positions, history and requirements.
      </p>
      {isNative ? (
        <p className="hint">
          Downloads work from the web app, or with the API: <code>{serverUrl}/api/export</code>
        </p>
      ) : (
        <>
          <div className="date-range">
            <label>
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              To (exclusive)
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <button className="primary" disabled={busy} onClick={() => void get('/api/export', 'lanesignal-export.zip')}>
            Download everything (.zip)
          </button>
          <div className="dataset-links">
            {DATASETS.map((d) => (
              <button key={d} className="ghost" disabled={busy} onClick={() => void get(`/api/export/${d}.csv`, `${d}.csv`)}>
                {d}.csv
              </button>
            ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
