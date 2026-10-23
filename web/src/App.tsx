import { App as CapApp } from '@capacitor/app';
import { useEffect, useMemo, useState } from 'react';
import {
  createClient,
  isNative,
  loadConnection,
  saveConnection,
  type Client,
  type Connection,
  type LaneStatus,
  type Principal,
  type PublicConfig,
} from './api.ts';
import { Chips, GroupHeader, LaneCard, LaneDetail } from './components.tsx';
import { EscalationCard, EscalationDetail } from './escalations.tsx';
import { compareLanes, needsHuman, STATUS_META } from './format.ts';
import { useLiveData, useNow } from './live.ts';
import { Login } from './login.tsx';
import { pushSupported, setupPush, teardownPush } from './push.ts';
import { AgentKeysSection, PasswordSection, PeopleSection } from './settings.tsx';

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

// History entries created inside the app are tagged, so closing a sheet only goes
// "back" when back stays in the app (not to whatever site linked here).
if (history.state === null) history.replaceState({ inApp: false }, '');

/** Close a sheet: step back if we navigated here in-app, otherwise go to `fallback`. */
export function closeTo(fallback: string) {
  if ((history.state as { inApp?: boolean } | null)?.inApp) history.back();
  else location.replace(fallback);
}

function useRoute(): [Route, (r: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      if (history.state === null) history.replaceState({ inApp: true }, '');
      setRoute(parseRoute(location.hash));
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (location.hash = r)];
}

// ---- persisted filters ----

interface Filters {
  /** Group (epic/train/overseer) ids to show; empty = all. */
  groups: string[];
  statuses: LaneStatus[];
  arrange: 'group' | 'priority' | 'status';
  showCompleted: boolean;
}

const FILTER_KEY = 'lanesignal.filters.v2';
const defaultFilters: Filters = { groups: [], statuses: [], arrange: 'group', showCompleted: false };

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
        // End the server-side session too (static access tokens have none).
        if (conn.kind === 'session') await client.signOut().catch(() => {});
        saveConnection(null);
        setConn(null);
      }}
    />
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

  const [loadError, setLoadError] = useState<string | null>(null);
  const isLive = live.link === 'live';

  // Load config + identity; retry every 5s while it fails, and again whenever the stream reconnects.
  useEffect(() => {
    if (config) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      Promise.all([client.config(), client.me()])
        .then(([c, m]) => !cancelled && (setConfig(c), setMe(m), setLoadError(null)))
        .catch((e: { status?: number; message?: string }) => {
          if (cancelled) return;
          if (e.status === 401 || e.status === 403) return setAuthError(true);
          setLoadError(e.message ?? 'Server unreachable');
          timer = setTimeout(load, 5000);
        });
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, config, isLive]);

  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    let cleanup = () => {};
    setupPush(client, config, navigate)
      .then((c) => (cancelled ? c() : (cleanup = c)))
      .catch((err: unknown) => console.warn('push setup failed', err));
    return () => {
      cancelled = true;
      cleanup();
    };
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
  // Inbox order: lanes by their oldest open question, then each lane's questions in order,
  // so a batch ("four questions from #921") reads top to bottom.
  const openByLane = new Map<string, typeof escalations>();
  for (const e of escalations) {
    if (e.state !== 'open') continue;
    openByLane.set(e.laneId, [...(openByLane.get(e.laneId) ?? []), e]);
  }
  const open = [...openByLane.values()].flat();
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
  const seqOf = (e: (typeof escalations)[number]) => {
    const siblings = openByLane.get(e.laneId) ?? [];
    return siblings.length > 1 ? { index: siblings.indexOf(e), total: siblings.length } : undefined;
  };
  const escLaneId = route.escId ? (live.escalations.get(route.escId)?.laneId ?? null) : null;
  const blockedLanes = lanes.filter((l) => l.status === 'blocked_human' && l.openEscalations === 0);

  useEffect(() => {
    document.title = open.length ? `(${open.length}) LaneSignal` : 'LaneSignal';
  }, [open.length]);

  if (authError || live.link === 'unauthorized') {
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
  if (!config) {
    return (
      <main className="loading">
        <div>
          <p>Connecting…</p>
          {loadError && <p className="error">{loadError} · retrying</p>}
          <button className="link" onClick={() => onSignOut(client)}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  const label = config.groupLabel;
  const groupName = (id: string | null) => (id ? (live.groups.get(id)?.name ?? id) : `No ${label.toLowerCase()}`);
  // Groups that have lanes, plus any the overseers published without lanes yet.
  const groupIds = [...new Set([...live.groups.keys(), ...lanes.map((l) => l.group).filter((g): g is string => !!g)])];
  const statusOptions = config.statuses.filter((s) => s !== 'completed' || filters.showCompleted);
  // Only filters the user can currently see (and so undo) take effect.
  const activeGroups = filters.groups.filter((g) => groupIds.includes(g));
  const activeStatuses = filters.statuses.filter((s) => statusOptions.includes(s));
  const visible = lanes.filter(
    (l) =>
      (filters.showCompleted || l.status !== 'completed' || needsHuman(l)) &&
      (!activeGroups.length || (l.group !== null && activeGroups.includes(l.group))) &&
      (!activeStatuses.length || activeStatuses.includes(l.status)),
  );
  type Section = { key: string; title?: string; groupId?: string | null; lanes: typeof visible };
  let sections: Section[];
  if (filters.arrange === 'group') {
    // Groups needing a human first, then alphabetical; ungrouped lanes last.
    const ids: (string | null)[] = [...groupIds, null];
    sections = ids
      .map((id) => ({ key: id ?? '', groupId: id, lanes: visible.filter((l) => l.group === id) }))
      .sort(
        (a, b) =>
          Number(b.lanes.some(needsHuman)) - Number(a.lanes.some(needsHuman)) ||
          Number(a.groupId === null) - Number(b.groupId === null) ||
          groupName(a.groupId ?? null).localeCompare(groupName(b.groupId ?? null)),
      );
  } else if (filters.arrange === 'status') {
    sections = config.statuses.map((s) => ({ key: s, title: STATUS_META[s].label, lanes: visible.filter((l) => l.status === s) }));
  } else {
    sections = [{ key: '', lanes: visible }];
  }
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
          seq={seqOf(e)}
          lane={live.lanes.get(e.laneId)}
          group={live.groups.get(live.lanes.get(e.laneId)?.group ?? '')}
          now={now}
          client={client}
        />
      ))}
      {blockedLanes.length > 0 && (
        <>
          <h3 className="subhead">Blocked lanes without an escalation</h3>
          {blockedLanes.map((l) => (
            <LaneCard key={l.id} lane={l} now={now} config={config} groupName={l.group && groupName(l.group)} onOpen={() => navigate(`#/lane/${encodeURIComponent(l.id)}`)} />
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
              group={live.groups.get(live.lanes.get(e.laneId)?.group ?? '')}
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
        {(groupIds.length > 1 || activeGroups.length > 0) && (
          <Chips
            label={label}
            options={groupIds}
            selected={new Set(filters.groups)}
            onToggle={(g) => setFilters({ groups: toggle(filters.groups, g) })}
            render={groupName}
          />
        )}
        <Chips
          label="Status"
          options={statusOptions}
          selected={new Set(filters.statuses)}
          onToggle={(s) => setFilters({ statuses: toggle(filters.statuses, s) })}
          render={(s) => STATUS_META[s].label}
        />
        <div className="filter-row">
          <label>
            Arrange by
            <select value={filters.arrange} onChange={(e) => setFilters({ arrange: e.target.value as Filters['arrange'] })}>
              <option value="group">{label}</option>
              <option value="priority">Priority</option>
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
          {(activeGroups.length > 0 || activeStatuses.length > 0) && (
            <button className="link" onClick={() => setFilters({ groups: [], statuses: [] })}>
              Clear
            </button>
          )}
        </div>
      </div>
      {visible.length === 0 && <p className="empty">No lanes match.</p>}
      {sections.map(
        (sec) =>
          sec.lanes.length > 0 && (
            <div key={sec.key} className="group">
              {sec.groupId !== undefined ? (
                <GroupHeader
                  group={sec.groupId ? live.groups.get(sec.groupId) : undefined}
                  name={groupName(sec.groupId)}
                  lanes={sec.lanes}
                />
              ) : (
                sec.title && (
                  <h3 className="subhead">
                    {sec.title} <span className="count">{sec.lanes.length}</span>
                  </h3>
                )
              )}
              <div className="lane-grid">
                {sec.lanes.map((l) => (
                  <LaneCard
                    key={l.id}
                    lane={l}
                    now={now}
                    config={config}
                    groupName={filters.arrange === 'group' || !l.group ? null : groupName(l.group)}
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
        <dd>
          {me ? `${me.name}${me.email ? ` · ${me.email}` : ''}${me.admin ? ' (admin)' : ''}` : '…'}
          {conn.kind !== 'session' && ' · access token'}
        </dd>
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
      {me?.userId ? (
        <>
          <AgentKeysSection client={client} serverUrl={conn.server || location.origin} now={now} />
          {me.admin && <PeopleSection client={client} me={me} />}
          <PasswordSection client={client} />
        </>
      ) : (
        <p className="hint">Sign in with an account to manage agent keys and people.</p>
      )}
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
          groups={live.groups}
          laneOpenIds={escLaneId ? (openByLane.get(escLaneId) ?? []).map((e) => e.id) : []}
          version={escVersion}
          now={now}
          onClose={() => closeTo('#/')}
        />
      )}
      {route.laneId && (
        <LaneDetail
          laneId={route.laneId}
          client={client}
          version={laneVersion}
          now={now}
          canDelete={me?.role === 'human'}
          group={live.groups.get(live.lanes.get(route.laneId)?.group ?? '')}
          groupLabel={config.groupLabel}
          onClose={() => closeTo('#/lanes')}
        />
      )}
    </div>
  );
}
