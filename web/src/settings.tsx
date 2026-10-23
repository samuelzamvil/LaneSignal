import { useCallback, useEffect, useState } from 'react';
import { isNative, type AgentKey, type Client, type Person, type Principal } from './api.ts';
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
export function AgentKeysSection({ client, serverUrl, now }: { client: Client; serverUrl: string; now: number }) {
  const load = useCallback(() => client.listKeys(), [client]);
  const { data: keys, error, reload } = useAsync(load);
  const [name, setName] = useState('');
  const [role, setRole] = useState<'agent' | 'human'>('agent');
  const [created, setCreated] = useState<{ name: string; key: string; role: 'agent' | 'human' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      const k = await client.createKey(name.trim(), role);
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
