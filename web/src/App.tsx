import { App as CapApp } from '@capacitor/app';
import { useEffect, useMemo, useState } from 'react';
import {
  createClient,
  isNative,
  loadConnection,
  normalizeServer,
  saveConnection,
  type Client,
  type Connection,
  type LaneStatus,
  type Principal,
  type PublicConfig,
} from './api.ts';
import { Chips, LaneCard, LaneDetail } from './components.tsx';
import { EscalationCard, EscalationDetail } from './escalations.tsx';
import { compareLanes, needsHuman, STATUS_META } from './format.ts';
import { useLiveData, useNow } from './live.ts';
import { pushSupported, setupPush, teardownPush } from './push.ts';

// ---- routing (hash based, so it works from file-less Capacitor URLs and push deep links) ----

type View = 'inbox' | 'lanes' | 'settings';
interface Route {
  view: View;
  laneId?: string;
  escId?: string;
}

function parseRoute(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/');
  if (a === 'lane' && b) return { view: 'lanes', laneId: decodeURIComponent(b) };
  if (a === 'esc' && b) return { view: 'inbox', escId: b };
  if (a === 'lanes' || a === 'settings') return { view: a };
  return { view: 'inbox' };
}

function useRoute(): [Route, (r: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (location.hash = r)];
}

// ---- persisted filters ----

interface Filters {
  categories: string[];
  statuses: LaneStatus[];
  group: 'none' | 'category' | 'status';
  showCompleted: boolean;
}

const FILTER_KEY = 'lanesignal.filters';
const defaultFilters: Filters = { categories: [], statuses: [], group: 'none', showCompleted: false };

function useFilters(): [Filters, (f: Partial<Filters>) => void] {
  const [f, setF] = useState<Filters>(() => {
    try {
      return { ...defaultFilters, ...JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}') };
    } catch {
      return defaultFilters;
    }
  });
  return [
    f,
    (patch) =>
      setF((cur) => {
        const next = { ...cur, ...patch };
        localStorage.setItem(FILTER_KEY, JSON.stringify(next));
        return next;
      }),
  ];
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

// ---- root ----

export default function App() {
  const [conn, setConn] = useState<Connection | null>(() => loadConnection());
  if (!conn) return <Login onConnected={(c) => (saveConnection(c), setConn(c))} />;
  return (
    <Dashboard
      key={conn.server + conn.token}
      conn={conn}
      onSignOut={async (client) => {
        await teardownPush(client);
        saveConnection(null);
        setConn(null);
      }}
    />
  );
}

function Login({ onConnected }: { onConnected: (c: Connection) => void }) {
  const [server, setServer] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const c = { server: normalizeServer(server), token: token.trim() };
    try {
      const me = await createClient(c).me();
      if (me.role !== 'overseer') throw new Error('This is an agent token; sign in with an overseer token.');
      onConnected(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>LaneSignal</h1>
        {(isNative || server) && (
          <label>
            Server URL
            <input
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="https://lanesignal.example.com"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              required={isNative}
            />
          </label>
        )}
        <label>
          Overseer token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        {!isNative && !server && (
          <button type="button" className="link" onClick={() => setServer('https://')}>
            Connect to a different server
          </button>
        )}
      </form>
    </main>
  );
}

function Dashboard({ conn, onSignOut }: { conn: Connection; onSignOut: (c: Client) => void }) {
  const client = useMemo(() => createClient(conn), [conn]);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Principal | null>(null);
  const [authError, setAuthError] = useState(false);
  const live = useLiveData(client);
  const now = useNow();
  const [route, navigate] = useRoute();
  const [filters, setFilters] = useFilters();

  useEffect(() => {
    Promise.all([client.config(), client.me()])
      .then(([c, m]) => (setConfig(c), setMe(m)))
      .catch((e: { status?: number }) => e.status === 401 && setAuthError(true));
  }, [client]);

  useEffect(() => {
    if (!config) return;
    let cleanup = () => {};
    void setupPush(client, config, navigate).then((c) => (cleanup = c));
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, config]);

  // Android hardware back button: close sheets first, then leave the app.
  useEffect(() => {
    if (!isNative) return;
    const h = CapApp.addListener('backButton', () => {
      if (location.hash && location.hash !== '#/') history.back();
      else void CapApp.minimizeApp();
    });
    return () => void h.then((x) => x.remove());
  }, []);

  const lanes = useMemo(() => [...live.lanes.values()].sort(compareLanes), [live.lanes]);
  const escalations = useMemo(
    () => [...live.escalations.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [live.escalations],
  );
  const open = escalations.filter((e) => e.state === 'open');
  const decided = escalations.filter((e) => e.state === 'decided');
  // Refetch lane detail only when something about that lane changed.
  const laneVersion = route.laneId
    ? [
        live.lanes.get(route.laneId)?.updatedAt,
        ...escalations.filter((e) => e.laneId === route.laneId).map((e) => e.id + e.state),
      ].join('|')
    : '';
  // Closed escalations drop out of the live map, which also changes this key.
  const escVersion = route.escId ? (live.escalations.get(route.escId)?.updatedAt ?? 'closed') : '';
  const blockedLanes = lanes.filter((l) => l.status === 'blocked_human' && l.openEscalations === 0);

  useEffect(() => {
    document.title = open.length ? `(${open.length}) LaneSignal` : 'LaneSignal';
  }, [open.length]);

  if (authError) {
    return (
      <main className="login">
        <form onSubmit={(e) => (e.preventDefault(), onSignOut(client))}>
          <h1>Token rejected</h1>
          <p>The server no longer accepts this token.</p>
          <button className="primary">Sign in again</button>
        </form>
      </main>
    );
  }
  if (!config) return <main className="loading">Connecting…</main>;

  const categories = [...new Set([...config.categories, ...lanes.map((l) => l.category).filter((c): c is string => !!c)])];
  const statusOptions = config.statuses.filter((s) => s !== 'completed' || filters.showCompleted);
  const visible = lanes.filter(
    (l) =>
      (filters.showCompleted || l.status !== 'completed' || needsHuman(l)) &&
      (!filters.categories.length || (l.category && filters.categories.includes(l.category))) &&
      (!filters.statuses.length || filters.statuses.includes(l.status)),
  );
  const groups: [string, typeof visible][] =
    filters.group === 'none'
      ? [['', visible]]
      : filters.group === 'category'
        ? [...categories, ''].map((c) => [c || 'Uncategorized', visible.filter((l) => (l.category ?? '') === c)])
        : config.statuses.map((s) => [STATUS_META[s].label, visible.filter((l) => l.status === s)]);
  const completedCount = lanes.filter((l) => l.status === 'completed').length;

  const inbox = (
    <section className="pane inbox" aria-label="Needs you">
      <h2>
        Needs you <span className={`count${open.length ? ' hot' : ''}`}>{open.length}</span>
      </h2>
      {open.length === 0 && blockedLanes.length === 0 && <p className="empty">No decisions waiting. 🎉</p>}
      {open.map((e) => (
        <EscalationCard
          key={e.id}
          esc={e}
          lane={live.lanes.get(e.laneId)}
          now={now}
          client={client}
        />
      ))}
      {blockedLanes.length > 0 && (
        <>
          <h3 className="subhead">Blocked lanes without an escalation</h3>
          {blockedLanes.map((l) => (
            <LaneCard key={l.id} lane={l} now={now} config={config} onOpen={() => navigate(`#/lane/${encodeURIComponent(l.id)}`)} />
          ))}
        </>
      )}
      {decided.length > 0 && (
        <>
          <h3 className="subhead">Decided · awaiting agent</h3>
          {decided.map((e) => (
            <EscalationCard
              key={e.id}
              esc={e}
              lane={live.lanes.get(e.laneId)}
              now={now}
              client={client}
            />
          ))}
        </>
      )}
    </section>
  );

  const lanePane = (
    <section className="pane lanes" aria-label="Lanes">
      <h2>
        Lanes <span className="count">{visible.length}</span>
      </h2>
      <div className="filters">
        <Chips
          label="Category"
          options={categories}
          selected={new Set(filters.categories)}
          onToggle={(c) => setFilters({ categories: toggle(filters.categories, c) })}
        />
        <Chips
          label="Status"
          options={statusOptions}
          selected={new Set(filters.statuses)}
          onToggle={(s) => setFilters({ statuses: toggle(filters.statuses, s) })}
          render={(s) => STATUS_META[s].label}
        />
        <div className="filter-row">
          <label>
            Group
            <select value={filters.group} onChange={(e) => setFilters({ group: e.target.value as Filters['group'] })}>
              <option value="none">Priority</option>
              <option value="category">Category</option>
              <option value="status">Status</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={filters.showCompleted}
              onChange={(e) => setFilters({ showCompleted: e.target.checked })}
            />
            Completed ({completedCount})
          </label>
          {(filters.categories.length > 0 || filters.statuses.length > 0) && (
            <button className="link" onClick={() => setFilters({ categories: [], statuses: [] })}>
              Clear
            </button>
          )}
        </div>
      </div>
      {visible.length === 0 && <p className="empty">No lanes match.</p>}
      {groups.map(
        ([name, items]) =>
          items.length > 0 && (
            <div key={name} className="group">
              {name && (
                <h3 className="subhead">
                  {name} <span className="count">{items.length}</span>
                </h3>
              )}
              <div className="lane-grid">
                {items.map((l) => (
                  <LaneCard
                    key={l.id}
                    lane={l}
                    now={now}
                    config={config}
                    onOpen={() => navigate(`#/lane/${encodeURIComponent(l.id)}`)}
                  />
                ))}
              </div>
            </div>
          ),
      )}
    </section>
  );

  const settings = (
    <section className="pane settings" aria-label="Settings">
      <h2>Settings</h2>
      <dl className="facts">
        <dt>Server</dt>
        <dd>{conn.server || location.origin}</dd>
        <dt>Signed in as</dt>
        <dd>{me ? `${me.name} (${me.role})` : '…'}</dd>
        <dt>Connection</dt>
        <dd>{live.link}</dd>
        <dt>Push</dt>
        <dd>
          {!isNative
            ? 'Android app only'
            : !pushSupported
              ? 'Not included in this build'
              : config.push.fcm
                ? 'Enabled for human decisions'
                : 'Server has no FCM credentials'}
          {config.push.ntfy && ' · ntfy enabled on server'}
        </dd>
        <dt>Ticket systems</dt>
        <dd>{config.ticketSystems.join(', ') || 'none configured'}</dd>
      </dl>
      <button className="ghost danger" onClick={() => onSignOut(client)}>
        Sign out
      </button>
    </section>
  );

  return (
    <div className={`app view-${route.view}`}>
      <header className="topbar">
        <a href="#/" className="brand">
          <img src="/icon.svg" alt="" width={24} height={24} /> {config.name}
        </a>
        <span className={`link-dot ${live.link}`} title={live.link} aria-label={`connection ${live.link}`} />
        <a href="#/settings" className="settings-link" aria-label="Settings">
          ⚙
        </a>
      </header>
      {open.length > 0 && route.view !== 'inbox' && (
        <a className="alert-banner" href="#/">
          ⚑ {open.length} decision{open.length > 1 ? 's' : ''} waiting
        </a>
      )}
      <main className="panes">
        {inbox}
        {route.view === 'settings' ? settings : lanePane}
      </main>
      <nav className="tabbar">
        <a href="#/" className={route.view === 'inbox' ? 'on' : ''}>
          <span className="icon">⚑</span>Needs you
          {open.length > 0 && <span className="badge">{open.length}</span>}
        </a>
        <a href="#/lanes" className={route.view === 'lanes' ? 'on' : ''}>
          <span className="icon">☰</span>Lanes
        </a>
        <a href="#/settings" className={route.view === 'settings' ? 'on' : ''}>
          <span className="icon">⚙</span>Settings
        </a>
      </nav>
      {route.escId && (
        <EscalationDetail
          id={route.escId}
          client={client}
          lanes={live.lanes}
          version={escVersion}
          now={now}
          onClose={() => (history.length > 1 ? history.back() : navigate('#/'))}
        />
      )}
      {route.laneId && (
        <LaneDetail
          laneId={route.laneId}
          client={client}
          version={laneVersion}
          now={now}
          canDelete={me?.role === 'overseer'}
          onClose={() => (history.length > 1 ? history.back() : navigate('#/lanes'))}
        />
      )}
    </div>
  );
}
