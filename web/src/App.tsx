import { App as CapApp } from '@capacitor/app';
import { useEffect, useMemo, useState } from 'react';
import {
  createClient,
  isNative,
  loadConnection,
  saveConnection,
  type Client,
  type Connection,
  type Escalation,
  type LaneStatus,
  type Principal,
  type PublicConfig,
} from './api.ts';
import { Chips, GroupHeader, LaneCard, LaneDetail, LaneRow } from './components.tsx';
import { EscalationCard, EscalationDetail, EscalationRow, isCodeOf } from './escalations.tsx';
import { routeFromAppLink } from './deeplink.ts';
import { compareLanes, needsHuman, STATUS_META } from './format.ts';
import { keyOf } from './merge.ts';
import { useLiveData, useNow } from './live.ts';
import { backLabel, closeOverlay, closeTo, trackEntry } from './nav.ts';
import { Login } from './login.tsx';
import { pushSupported, setupPush, teardownPush } from './push.ts';
import { HistoryPane } from './history.tsx';
import { RequirementsPane } from './requirements.tsx';
import { Toaster } from './toast.tsx';
import { AgentKeysSection, ExportSection, PasswordSection, PeopleSection, ProjectsSection } from './settings.tsx';

// ---- routing (hash based, so it works from file-less Capacitor URLs and push deep links) ----

type View = 'inbox' | 'lanes' | 'reqs' | 'history' | 'settings';
interface Route {
  view: View;
  laneId?: string;
  /** The lane's project; old links (#/lane/<id>) leave it out. */
  laneProject?: string;
  escId?: string;
}

/** A URL path segment decoded, or null when it's malformed (e.g. "%E0" from a crafted link). */
const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

function parseRoute(hash: string): Route {
  const [, a, b, c] = hash.replace(/^#/, '').split('/');
  const lb = b ? decode(b) : null;
  const lc = c ? decode(c) : null;
  if (a === 'lane' && lb && lc) return { view: 'lanes', laneProject: lb, laneId: lc };
  if (a === 'lane' && lb && !c) return { view: 'lanes', laneId: lb };
  if (a === 'esc' && b) return { view: 'inbox', escId: b };
  // A closed escalation opened from History: closing it goes back there.
  if (a === 'history' && b) return { view: 'history', escId: b };
  if (a === 'lanes' || a === 'reqs' || a === 'history' || a === 'settings') return { view: a };
  return { view: 'inbox' };
}

/** Where closing an escalation goes when there's no in-app history to step back to. */
const escFallback = (r: Route) => (r.view === 'history' ? '#/history' : '#/');

function useRoute(): [Route, (r: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      trackEntry();
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

/** Which project the views show: '' for all of them (the combined view). Remembered per device. */
/** Cards or a compact list, for the inbox or the lanes; remembered on this device. */
function useLayout(key: string): ['cards' | 'list', (l: 'cards' | 'list') => void] {
  const [layout, setLayout] = useState<'cards' | 'list'>(() => {
    try {
      return localStorage.getItem(key) === 'list' ? 'list' : 'cards';
    } catch {
      return 'cards';
    }
  });
  return [
    layout,
    (l) => {
      setLayout(l);
      try {
        localStorage.setItem(key, l);
      } catch {
        /* storage unavailable: keep it for this visit */
      }
    },
  ];
}

const PROJECT_KEY = 'lanesignal.project';
function useProjectFilter(): [string, (p: string) => void] {
  const [p, setP] = useState(() => {
    try {
      return localStorage.getItem(PROJECT_KEY) ?? '';
    } catch {
      return '';
    }
  });
  return [
    p,
    (next) => {
      setP(next);
      try {
        localStorage.setItem(PROJECT_KEY, next);
      } catch {
        /* private mode: just don't remember */
      }
    },
  ];
}

export const laneRoute = (project: string, id: string) => `#/lane/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;

// ---- root ----

export default function App() {
  const [conn, setConn] = useState<Connection | null>(() => loadConnection());
  if (!conn) return <Login onConnected={(c) => (saveConnection(c), setConn(c))} />;
  return (
    <Dashboard
      key={conn.server + conn.token}
      conn={conn}
      onNewSession={(token) => {
        const next = { ...conn, token };
        saveConnection(next);
        setConn(next);
      }}
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


function Dashboard({
  conn,
  onSignOut,
  onNewSession,
}: {
  conn: Connection;
  onSignOut: (c: Client) => void;
  /** Replaces this device's session token (after a password change). */
  onNewSession: (token: string) => void;
}) {
  const client = useMemo(() => createClient(conn), [conn]);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [me, setMe] = useState<Principal | null>(null);
  const [authError, setAuthError] = useState(false);
  const live = useLiveData(client);
  // History refreshes when an escalation closes (leaves the live set), not on every update.
  const unresolvedIds = useMemo(() => [...live.escalations.keys()].sort().join(','), [live.escalations]);
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

  // Desktop: the open escalation or lane sits beside the list, under the top bar, so CSS needs its height.
  useEffect(() => {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const set = () => document.documentElement.style.setProperty('--topbar-h', `${bar.getBoundingClientRect().height}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(bar);
    return () => observer.disconnect();
    // The top bar appears once the configuration has loaded.
  }, [!!config]);

  // Escape closes an open sheet (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Escape while typing an answer shouldn't throw the draft away.
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
      const r = parseRoute(location.hash);
      if (r.escId) closeTo(escFallback(r));
      else if (r.laneId) closeTo('#/lanes');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // lanesignal:// links (ntfy notifications) open the screen they name. Capacitor delivers the link that
  // started the app this way too, and holds links that arrive before sign-in until this listener exists.
  useEffect(() => {
    if (!isNative) return;
    const open = (url: string | undefined) => {
      const route = url ? routeFromAppLink(url) : null;
      if (route) navigate(route);
    };
    const h = CapApp.addListener('appUrlOpen', (e) => open(e.url));
    return () => void h.then((x) => x.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Android hardware back button: close sheets first, then leave the app.
  useEffect(() => {
    if (!isNative) return;
    const h = CapApp.addListener('backButton', () => {
      // Overlays (an open attachment) close first, then sheets the way their back button says;
      // other screens step back.
      if (closeOverlay()) return;
      const r = parseRoute(location.hash);
      if (r.escId) closeTo(escFallback(r));
      else if (r.laneId) closeTo('#/lanes');
      else if (location.hash && location.hash !== '#/') history.back();
      else void CapApp.minimizeApp();
    });
    return () => void h.then((x) => x.remove());
  }, []);

  const [projectChoice, setProjectFilter] = useProjectFilter();
  const [inboxLayout, setInboxLayout] = useLayout('lanesignal.inboxLayout');
  const [laneLayout, setLaneLayout] = useLayout('lanesignal.laneLayout');
  // Only a project the caller can still see filters anything; with one project there's nothing to pick.
  const multiProject = live.projects.length > 1;
  const projectFilter = multiProject && live.projects.some((p) => p.id === projectChoice) ? projectChoice : '';
  const inScope = (project: string) => !projectFilter || project === projectFilter;
  const lanes = useMemo(
    () => [...live.lanes.values()].filter((l) => inScope(l.project)).sort(compareLanes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.lanes, projectFilter],
  );
  const escalations = useMemo(
    () =>
      [...live.escalations.values()]
        .filter((e) => inScope(e.project))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.escalations, projectFilter],
  );
  const laneOf = (e: { project: string; laneId: string }) => live.lanes.get(keyOf(e.project, e.laneId));
  const groupOfLane = (l: { project: string; group: string | null } | undefined) =>
    l?.group ? live.groups.get(keyOf(l.project, l.group)) : undefined;
  // Inbox order: lanes by their oldest open question, then each lane's questions in order,
  // so a batch ("four questions from #921") reads top to bottom.
  const openByLane = new Map<string, typeof escalations>();
  for (const e of escalations) {
    if (e.state !== 'open') continue;
    const k = keyOf(e.project, e.laneId);
    openByLane.set(k, [...(openByLane.get(k) ?? []), e]);
  }
  // Counts and badges are for blocking questions waiting on you; FYI ones, and ones where the
  // agent is replying to your Other, are listed separately.
  const open = [...openByLane.values()].flat().filter((e) => e.blocking && e.turn === 'owner');
  const replying = [...openByLane.values()].flat().filter((e) => e.turn === 'agent');
  const fyi = [...openByLane.values()].flat().filter((e) => !e.blocking && e.turn === 'owner');
  const decided = escalations.filter((e) => e.state === 'decided');
  // Old lane links carry no project: the one lane with that id, or the current/only project.
  const routeLaneProject = route.laneId
    ? (route.laneProject ??
      [...live.lanes.values()].find((l) => l.id === route.laneId && inScope(l.project))?.project ??
      (projectFilter || live.projects[0]?.id))
    : undefined;
  const routeLaneKey = route.laneId && routeLaneProject ? keyOf(routeLaneProject, route.laneId) : '';
  // Refetch lane detail only when something about that lane changed.
  const laneVersion = routeLaneKey
    ? [
        live.lanes.get(routeLaneKey)?.updatedAt,
        ...[...live.escalations.values()]
          .filter((e) => keyOf(e.project, e.laneId) === routeLaneKey)
          .map((e) => e.id + e.state),
      ].join('|')
    : '';
  // The route may name an escalation by its code (#/esc/A12, or #/esc/LS-A12 across projects).
  const routeEsc = route.escId
    ? (live.escalations.get(route.escId) ??
      [...live.escalations.values()].find((e) => isCodeOf(e, route.escId!) && inScope(e.project)) ??
      [...live.escalations.values()].find((e) => isCodeOf(e, route.escId!)))
    : undefined;
  // Closed escalations drop out of the live map, which also changes this key.
  const escVersion = route.escId ? (routeEsc?.updatedAt ?? 'closed') : '';
  const seqOf = (e: (typeof escalations)[number]) => {
    const siblings = openByLane.get(keyOf(e.project, e.laneId)) ?? [];
    return siblings.length > 1 ? { index: siblings.indexOf(e), total: siblings.length } : undefined;
  };
  const escLaneKey = routeEsc ? keyOf(routeEsc.project, routeEsc.laneId) : null;
  /** In the combined view with several projects, codes and groups carry their project. */
  const showProject = multiProject && !projectFilter;
  const blockedLanes = lanes.filter((l) => l.status === 'blocked_human' && l.blockingEscalations === 0);

  useEffect(() => {
    document.title = open.length ? `(${open.length}) LaneSignal` : 'LaneSignal';
  }, [open.length]);

  if (authError || live.link === 'unauthorized') {
    return (
      <main className="login">
        <form onSubmit={(e) => (e.preventDefault(), onSignOut(client))}>
          {conn.kind === 'token' ? (
            <>
              <h1>Token rejected</h1>
              <p>The server no longer accepts this token.</p>
            </>
          ) : (
            <>
              <h1>You were signed out</h1>
              <p>Your session ended (signed out elsewhere, a password change, or an admin). Sign in again to continue.</p>
            </>
          )}
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
  const projectKeyOf = (project: string) => live.projects.find((p) => p.id === project)?.key ?? project;
  /** Group keys are keyOf(project, group). */
  const groupName = (key: string | null) => {
    if (!key) return `No ${label.toLowerCase()}`;
    const g = live.groups.get(key);
    const name = g?.name ?? key.slice(key.indexOf('/') + 1);
    return showProject ? `${projectKeyOf(g?.project ?? key.slice(0, key.indexOf('/')))} · ${name}` : name;
  };
  const laneGroupKey = (l: { project: string; group: string | null }) => (l.group ? keyOf(l.project, l.group) : null);
  // Groups that have lanes, plus any the overseers published without lanes yet.
  const groupIds = [
    ...new Set([
      ...[...live.groups.values()].filter((g) => inScope(g.project)).map((g) => keyOf(g.project, g.id)),
      ...lanes.map(laneGroupKey).filter((g): g is string => !!g),
    ]),
  ];
  const statusOptions = config.statuses.filter((s) => s !== 'completed' || filters.showCompleted);
  // Only filters the user can currently see (and so undo) take effect.
  const activeGroups = filters.groups.filter((g) => groupIds.includes(g));
  const activeStatuses = filters.statuses.filter((s) => statusOptions.includes(s));
  const visible = lanes.filter(
    (l) =>
      (filters.showCompleted || l.status !== 'completed' || needsHuman(l)) &&
      (!activeGroups.length || (l.group !== null && activeGroups.includes(laneGroupKey(l)!))) &&
      (!activeStatuses.length || activeStatuses.includes(l.status)),
  );
  type Section = { key: string; title?: string; groupId?: string | null; lanes: typeof visible };
  let sections: Section[];
  if (filters.arrange === 'group') {
    // Groups needing a human first, then alphabetical; ungrouped lanes last.
    const ids: (string | null)[] = [...groupIds, null];
    sections = ids
      .map((id) => ({ key: id ?? '', groupId: id, lanes: visible.filter((l) => laneGroupKey(l) === id) }))
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

  /** One escalation in the inbox: a card with the answer buttons, or a one-line row. */
  const escItem = (e: Escalation, seq?: { index: number; total: number }) =>
    inboxLayout === 'list' ? (
      <EscalationRow key={e.id} esc={e} lane={laneOf(e)} now={now} showProject={showProject} selected={route.escId === e.id} />
    ) : (
      <EscalationCard
        key={e.id}
        esc={e}
        seq={seq}
        lane={laneOf(e)}
        group={groupOfLane(laneOf(e))}
        now={now}
        client={client}
        staleMinutes={config.staleMinutes}
        showProject={showProject}
        decisions={config.decisions}
      />
    );

  const inbox = (
    <section className={`pane inbox layout-${inboxLayout}`} aria-label="Needs you">
      <div className="pane-head">
        <h2>
          Needs you <span className={`count${open.length ? ' hot' : ''}`}>{open.length}</span>
        </h2>
        <span className="layout-toggle" role="group" aria-label="Show as">
          <button className={inboxLayout === 'cards' ? 'on' : ''} aria-pressed={inboxLayout === 'cards'} onClick={() => setInboxLayout('cards')}>
            Cards
          </button>
          <button className={inboxLayout === 'list' ? 'on' : ''} aria-pressed={inboxLayout === 'list'} onClick={() => setInboxLayout('list')}>
            List
          </button>
        </span>
      </div>
      {open.length === 0 && blockedLanes.length === 0 && (
        isLive && live.projects.length === 0 ? (
          <p className="empty">You're not in any project yet. Ask a project admin to add you.</p>
        ) : isLive && live.lanes.size === 0 ? (
          <p className="empty">
            Nothing here yet. Next: <a href="#/settings">Settings → Keys</a> to connect your first overseer.
          </p>
        ) : (
          <p className="empty">Nothing needs you. 🎉</p>
        )
      )}
      {open.map((e) => (
        escItem(e, seqOf(e))
      ))}
      {blockedLanes.length > 0 && (
        <>
          <h3 className="subhead">Blocked lanes without an escalation</h3>
          {blockedLanes.map((l) => (
            <LaneCard
              key={keyOf(l.project, l.id)}
              lane={l}
              now={now}
              config={config}
              groupName={laneGroupKey(l) && groupName(laneGroupKey(l))}
              onOpen={() => navigate(laneRoute(l.project, l.id))}
            />
          ))}
        </>
      )}
      {replying.length > 0 && (
        <>
          <h3 className="subhead">
            Agent's turn · replying to you <span className="count">{replying.length}</span>
          </h3>
          {replying.map((e) => (
            escItem(e)
          ))}
        </>
      )}
      {fyi.length > 0 && (
        <>
          <h3 className="subhead">
            FYI · agents keep working <span className="count">{fyi.length}</span>
          </h3>
          {fyi.map((e) => (
            escItem(e, seqOf(e))
          ))}
        </>
      )}
      {decided.length > 0 && (
        <>
          <h3 className="subhead">Decided · awaiting agent</h3>
          {decided.map((e) => (
            escItem(e)
          ))}
        </>
      )}
    </section>
  );

  const lanePane = (
    <section className="pane lanes" aria-label="Lanes">
      <div className="pane-head">
        <h2>
          Lanes <span className="count">{visible.length}</span>
        </h2>
        <span className="layout-toggle" role="group" aria-label="Show as">
          <button className={laneLayout === 'cards' ? 'on' : ''} aria-pressed={laneLayout === 'cards'} onClick={() => setLaneLayout('cards')}>
            Cards
          </button>
          <button className={laneLayout === 'list' ? 'on' : ''} aria-pressed={laneLayout === 'list'} onClick={() => setLaneLayout('list')}>
            List
          </button>
        </span>
      </div>
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
              <div className={laneLayout === 'list' ? 'lane-list' : 'lane-grid'}>
                {sec.lanes.map((l) =>
                  laneLayout === 'list' ? (
                    <LaneRow key={keyOf(l.project, l.id)} lane={l} now={now} onOpen={() => navigate(laneRoute(l.project, l.id))} />
                  ) : (
                  <LaneCard
                    key={keyOf(l.project, l.id)}
                    lane={l}
                    now={now}
                    config={config}
                    groupName={filters.arrange === 'group' || !l.group ? null : groupName(laneGroupKey(l))}
                    onOpen={() => navigate(laneRoute(l.project, l.id))}
                  />
                  ),
                )}
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
                ? 'Enabled for escalations'
                : 'Server has no FCM credentials'}
          {config.push.ntfy && ' · ntfy enabled on server'}
        </dd>
        <dt>Ticket systems</dt>
        <dd>{config.ticketSystems.join(', ') || 'none configured'}</dd>
      </dl>
      <ProjectsSection client={client} me={me} projects={live.projects} onChanged={live.refresh} />
      {me?.userId ? (
        <>
          <AgentKeysSection
            client={client}
            serverUrl={conn.server || location.origin}
            now={now}
            projects={live.projects}
            decisions={config.decisions}
            requirements={config.requirements}
          />
          {me.admin && <PeopleSection client={client} me={me} />}
          <PasswordSection client={client} onNewSession={onNewSession} />
        </>
      ) : (
        <p className="hint">Sign in with an account to manage agent keys and people.</p>
      )}
      <ExportSection client={client} serverUrl={conn.server || location.origin} requirements={config.requirements} />
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
        {multiProject && (
          <select
            className="project-switch"
            aria-label="Project"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">All projects</option>
            {live.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <nav className="topnav" aria-label="Views">
          <a href="#/lanes" className={route.view === 'lanes' || route.view === 'inbox' ? 'on' : ''}>
            Lanes
          </a>
          <a href="#/history" className={route.view === 'history' ? 'on' : ''}>
            History
          </a>
          {config.requirements && (
            <a href="#/reqs" className={route.view === 'reqs' ? 'on' : ''}>
              Requirements
            </a>
          )}
        </nav>
        <span className={`link-dot ${live.link}`} title={live.link} aria-label={`connection ${live.link}`} />
        <a href="#/settings" className="settings-link" aria-label="Settings">
          ⚙
        </a>
      </header>
      {live.link === 'offline' && (
        <div className="offline-bar" role="status">
          Offline{live.syncedAt ? ` · showing data from ${new Date(live.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''} ·
          reconnecting…
        </div>
      )}
      <Toaster />
      {open.length > 0 && route.view !== 'inbox' && (
        <a className="alert-banner" href="#/">
          ⚑ {open.length} {config.decisions ? 'decision' : 'alert'}
          {open.length > 1 ? 's' : ''} waiting
        </a>
      )}
      <main className="panes">
        {route.view === 'history' ? (
          <HistoryPane
            client={client}
            groups={live.groups}
            lanes={live.lanes}
            projects={live.projects}
            project={projectFilter}
            groupLabel={config.groupLabel}
            now={now}
            version={unresolvedIds}
            selectedId={route.escId}
          />
        ) : (
          inbox
        )}
        {route.view === 'settings' ? (
          settings
        ) : route.view === 'history' ? (
          <section className="pane history-empty" aria-hidden>
            <p className="empty">Pick an escalation to see it here.</p>
          </section>
        ) : route.view === 'reqs' && config.requirements ? (
          <RequirementsPane
            client={client}
            groups={live.groups}
            projects={live.projects}
            project={projectFilter}
            groupLabel={config.groupLabel}
            canEdit={me?.role === 'human'}
            version={live.requirementsVersion}
          />
        ) : (
          lanePane
        )}
      </main>
      <nav className="tabbar">
        <a href="#/" className={route.view === 'inbox' ? 'on' : ''}>
          <span className="icon">⚑</span>Needs you
          {open.length > 0 && <span className="badge">{open.length}</span>}
        </a>
        <a href="#/lanes" className={route.view === 'lanes' ? 'on' : ''}>
          <span className="icon">☰</span>Lanes
        </a>
        <a href="#/history" className={route.view === 'history' ? 'on' : ''}>
          <span className="icon">↺</span>History
        </a>
        {config.requirements && (
          <a href="#/reqs" className={route.view === 'reqs' ? 'on' : ''}>
            <span className="icon">§</span>Requirements
          </a>
        )}
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
          laneOpenIds={escLaneKey && route.view !== 'history' ? (openByLane.get(escLaneKey) ?? []).map((e) => e.id) : []}
          showProject={multiProject}
          decisions={config.decisions}
          currentId={routeEsc?.id}
          version={escVersion}
          now={now}
          staleMinutes={config.staleMinutes}
          onClose={() => closeTo(escFallback(route))}
          backTo={backLabel(escFallback(route))}
        />
      )}
      {route.laneId && routeLaneProject && (
        <LaneDetail
          laneId={route.laneId}
          project={routeLaneProject}
          client={client}
          version={laneVersion}
          now={now}
          canDelete={me?.role === 'human'}
          group={groupOfLane(live.lanes.get(routeLaneKey))}
          groupLabel={config.groupLabel}
          onClose={() => closeTo('#/lanes')}
          backTo={backLabel('#/lanes')}
        />
      )}
    </div>
  );
}
