import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Client, Escalation, Group, GroupFeedItem } from './api.ts';
import { AttachmentList } from './attachments.tsx';
import { RichText } from './components.tsx';
import { PresenceSessions } from './epic-views.tsx';
import { absolute, ago, seenByOverseer } from './format.ts';
import { deliveryLine } from './presence.ts';
import { latestEscalationAt, markMessagesSeen } from './seen.ts';

/** A group's conversation: its sheet's route. */
export const groupRoute = (project: string, group: string) => `#/group/${encodeURIComponent(project)}/${encodeURIComponent(group)}`;

type Item = GroupFeedItem;
const keyOf = (i: Item) => `${i.type}:${i.id}`;
/** Oldest first, as the server orders them: by time, a question before a message written at the same moment, then id. */
const byTime = (a: Item, b: Item) =>
  a.at.localeCompare(b.at) || (a.type === b.type ? (a.type === 'message' ? Number(a.id) - Number(b.id) : String(a.id).localeCompare(String(b.id))) : a.type === 'escalation' ? -1 : 1);

/** A key for one message, so a retry never posts it twice. randomUUID needs a secure context; LAN servers on plain HTTP get random bytes. */
const newKey = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * A group's conversation, as one transcript: messages written to the group, and each escalation as a
 * bounded thread (its question, the replies, and how it ended) where it was raised. Lanes, epics and
 * tickets have their own sheets; this shows only what was said.
 */
export function GroupView({
  project,
  groupId,
  group,
  name,
  client,
  version,
  escalations,
  now,
  canWrite,
  onClose,
  backTo,
  focus,
}: {
  project: string;
  groupId: string;
  group: Group | undefined;
  name: string;
  client: Client;
  /** Changes when the group's conversation changed, to refetch its latest page. */
  version: string;
  /** The live copies of open and decided escalations, to refetch a thread when it changes. */
  escalations: Map<string, Escalation>;
  now: number;
  /** May write to the overseer (a person, with answering in LaneSignal on). */
  canWrite: boolean;
  onClose: () => void;
  backTo: string;
  /** An escalation's id: its thread is brought into view and marked (a push about it opens here). */
  focus?: string;
}) {
  // Everything loaded so far, by key: the newest page is fetched again on changes and merged in, so
  // nothing already showing drops out; `next` stays where the oldest loaded page ended.
  const [items, setItems] = useState<Map<string, Item> | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const loaded = useRef<Map<string, Item> | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // Follows new messages while you're at the newest one, like a chat; reading back stays put.
  const atBottom = useRef(true);
  // How far the overseer has acknowledged, never moving back: a stale copy of the group arriving
  // after a newer one mustn't turn "seen" back into "not seen yet".
  const readId = useRef(0);
  readId.current = Math.max(readId.current, group?.overseerReadId ?? 0);

  useEffect(() => {
    let cancelled = false;
    client
      .groupConversation(project, groupId)
      .then((page) => {
        if (cancelled) return;
        const prev = loaded.current;
        let merged: Map<string, Item>;
        if (prev && page.items.some((i) => prev.has(keyOf(i)))) {
          merged = new Map(prev);
          for (const i of page.items) merged.set(keyOf(i), i);
        } else {
          // First load, or more new than a page since: start again from the newest page.
          merged = new Map(page.items.map((i) => [keyOf(i), i]));
          setNext(page.next);
        }
        loaded.current = merged;
        setItems(merged);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, project, groupId, version, sent]);

  // Read here: the chat button stops marking the overseer's messages, and escalations raised here, as new.
  const latestEscalation = group ? latestEscalationAt(escalations.values(), group) : null;
  useEffect(() => {
    if (group) markMessagesSeen(group, group.lastAgentMessageId, latestEscalation);
  }, [group, latestEscalation]);

  // The escalation a push was about: brought into view once loaded, paging back until it's found
  // (the feed is in the order questions were raised). While it's in view, following new messages
  // waits until you scroll or touch, so threads filling in don't carry it away.
  const focused = useRef<string | null>(null);
  const holdFocus = useRef(false);
  const [focusMissing, setFocusMissing] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || !items || focused.current === focus) return;
    if (!items.has(`escalation:${focus}`)) {
      // A page that failed to load isn't retried here (no loop on a flaky network): the button does that.
      if (loadingOlder || error) return;
      if (next) void loadOlder();
      // Every page read and it isn't here: say so, with a way to it.
      else {
        focused.current = focus;
        setFocusMissing(focus);
      }
      return;
    }
    focused.current = focus;
    setFocusMissing(null);
    atBottom.current = false;
    holdFocus.current = true;
    requestAnimationFrame(() => {
      const el = [...(list.current?.querySelectorAll<HTMLElement>('[data-esc]') ?? [])].find((n) => n.dataset.esc === focus);
      el?.scrollIntoView({ block: 'start' });
    });
  }, [focus, items, next, loadingOlder, error]);

  // Opens at the newest message, and stays there as threads fill in and messages arrive, unless you scrolled up.
  useLayoutEffect(() => {
    const el = list.current;
    const sheet = el?.closest('.convo');
    if (!el || !sheet) return;
    const onScroll = () => {
      if (holdFocus.current) return;
      atBottom.current = sheet.scrollHeight - sheet.scrollTop - sheet.clientHeight < 80;
    };
    // You taking over (a scroll, a tap, a key) releases the focused thread.
    const release = () => {
      holdFocus.current = false;
    };
    const follow = new ResizeObserver(() => {
      if (atBottom.current && !holdFocus.current) bottom.current?.scrollIntoView({ block: 'end' });
    });
    follow.observe(el);
    sheet.addEventListener('scroll', onScroll, { passive: true });
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) sheet.addEventListener(type, release, { passive: true });
    return () => {
      follow.disconnect();
      sheet.removeEventListener('scroll', onScroll);
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) sheet.removeEventListener(type, release);
    };
  }, [items !== null]);

  async function loadOlder() {
    if (!next) return;
    setLoadingOlder(true);
    try {
      const page = await client.groupConversation(project, groupId, next);
      const merged = new Map(loaded.current ?? []);
      for (const i of page.items) merged.set(keyOf(i), i);
      loaded.current = merged;
      atBottom.current = false;
      setItems(merged);
      setNext(page.next);
      // A page that loads clears an earlier failure, and lets paging toward a pushed thread go on.
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  }

  // Oldest first on screen. A message on an escalation shows in its thread, not on its own.
  const shown = [...(items?.values() ?? [])].filter((i) => !(i.type === 'message' && i.escalationId)).sort(byTime);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet sheet-group" onClick={(e) => e.stopPropagation()} aria-label={`${name}'s conversation`}>
        <header className="sheet-head">
          <button className="back" onClick={onClose} aria-label={`Back to ${backTo}`}>
            ← {backTo}
          </button>
          <div className="sheet-title">
            <span className="sheet-kind">Group</span>
            <h2>{name}</h2>
          </div>
        </header>
        <div className="sheet-body convo">
          {error && <p className="error">{error}</p>}
          {next && (
            <p className="convo-older">
              <button className="ghost" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load older messages'}
              </button>
            </p>
          )}
          {focusMissing && (
            <p className="hint">
              That escalation isn't in this conversation. <a href={`#/esc/${encodeURIComponent(focusMissing)}`}>Open it</a>
            </p>
          )}
          {items && shown.length === 0 && <p className="hint">Nothing said yet. What you write here reaches {name}'s overseer.</p>}
          <ol className="convo-list" ref={list}>
            {shown.map((i) =>
              i.type === 'message' ? (
                <li key={keyOf(i)} className={`convo-msg from-${i.from}`}>
                  <div className="msg-meta">
                    {i.author} <span title={absolute(i.at)}>· {ago(i.at, now)}</span>
                    {i.laneId && <span> · on lane {i.laneId}</span>}
                    {i.epicId !== null && <span> · on an epic's board</span>}
                    {(() => {
                      const seen = seenByOverseer(i, readId.current);
                      return seen === null ? null : <span className="msg-seen">{seen ? ' · seen by the overseer' : ' · not seen yet'}</span>;
                    })()}
                  </div>
                  <RichText text={i.body} />
                  {i.attachments.length > 0 && <AttachmentList client={client} files={i.attachments} />}
                </li>
              ) : (
                <li key={keyOf(i)} className={`convo-esc${i.id === focus ? ' focused' : ''}`} data-esc={i.id}>
                  <EscalationThread item={i} live={escalations.get(i.id)} client={client} now={now} focused={i.id === focus} canAnswer={canWrite} />
                </li>
              ),
            )}
          </ol>
          <div ref={bottom} />
        </div>
        {canWrite && group && (
          <GroupComposer
            name={name}
            group={group}
            onSend={async (body, clientKey) => {
              await client.groupMessage(project, groupId, body, clientKey);
              atBottom.current = true;
              setSent((n) => n + 1);
            }}
          />
        )}
      </section>
    </div>
  );
}

const STATE_LABEL: Record<Escalation['state'], string> = {
  open: 'Open',
  decided: 'Decided',
  acknowledged: 'Resolved',
  withdrawn: 'Dismissed',
};

/** An escalation as a bounded thread: its question, the replies, and how it ended; it opens in full. */
function EscalationThread({
  item,
  live,
  client,
  now,
  focused = false,
  canAnswer = false,
}: {
  item: Extract<GroupFeedItem, { type: 'escalation' }>;
  live: Escalation | undefined;
  client: Client;
  now: number;
  /** The thread a push opened: on your turn, its decision is one tap away. */
  focused?: boolean;
  /** You may answer here (a person, with answering in LaneSignal on). */
  canAnswer?: boolean;
}) {
  const [esc, setEsc] = useState<Escalation | null>(null);
  // Refetched when the live copy changes (a reply, an answer), or the feed says it moved on.
  const stamp = live ? `${live.state}|${live.turn}|${live.updatedAt}|${live.messageCount}` : `${item.state}|${item.turn}|${item.decidedAt}`;
  useEffect(() => {
    let cancelled = false;
    client
      .escalation(item.id)
      .then((e) => !cancelled && setEsc(e))
      .catch(() => {
        /* the feed's summary still shows */
      });
    return () => {
      cancelled = true;
    };
  }, [client, item.id, stamp]);

  const state = esc?.state ?? item.state;
  const turn = esc?.turn ?? item.turn;
  const yourTurn = state === 'open' && turn === 'owner';
  const blocking = esc?.blocking ?? item.blocking;
  return (
    <article className={`esc-thread state-${state}${yourTurn && blocking ? ' needs-human' : ''}`}>
      <header className="esc-thread-head">
        <span>
          <code>{item.ref}</code>
          <span className="muted"> · escalation{blocking ? ' · blocking' : ''}</span>
        </span>
        <span className="esc-thread-state">
          <span className={`pill ${yourTurn ? 'tone-danger' : state === 'acknowledged' ? 'tone-ok' : ''}`}>
            {yourTurn ? 'Waiting on you' : state === 'open' ? 'Waiting on the overseer' : STATE_LABEL[state]}
          </span>
          {focused && yourTurn && canAnswer ? (
            <a className="button primary" href={`#/esc/${item.id}`}>
              {blocking ? 'Decide' : 'Open to answer'}
            </a>
          ) : (
            <a href={`#/esc/${item.id}`}>Open escalation</a>
          )}
        </span>
      </header>
      <ol className="convo-list nested">
        <li className="convo-msg from-agent">
          <div className="msg-meta">
            {esc?.createdBy ?? 'overseer'} <span title={absolute(item.at)}>· {ago(item.at, now)}</span>
          </div>
          <p className="esc-thread-question">{item.question}</p>
        </li>
        {(esc?.messages ?? []).map((m) => (
          <li key={m.id} className={`convo-msg from-${m.from}`}>
            <div className="msg-meta">
              {m.author} <span title={absolute(m.at)}>· {ago(m.at, now)}</span>
            </div>
            <RichText text={m.body} />
            {m.attachments.length > 0 && <AttachmentList client={client} files={m.attachments} />}
          </li>
        ))}
      </ol>
      {state !== 'open' && (
        <footer className="esc-thread-outcome">
          {(esc?.decision ?? item.decision) && (
            <span>
              <strong>Decided:</strong> {esc?.decision ?? item.decision}
              {(esc?.decidedBy ?? item.decidedBy) && ` · ${esc?.decidedBy ?? item.decidedBy}`}
            </span>
          )}
          {(esc?.resolution ?? item.resolution) && (
            <span>
              <strong>{state === 'withdrawn' ? 'Dismissed:' : 'Resolution:'}</strong> {esc?.resolution ?? item.resolution}
            </span>
          )}
          {state === 'decided' && <span className="muted">Waiting for the overseer to pick it up</span>}
        </footer>
      )}
    </article>
  );
}

/** Writes to the group's overseer. Each message gets its own key, so a retry after a dropped connection never posts twice. */
function GroupComposer({
  name,
  group,
  onSend,
}: {
  name: string;
  group: Group;
  onSend: (body: string, clientKey: string) => Promise<void>;
}) {
  const delivery = deliveryLine(group);
  const [body, setBody] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      try {
        await onSend(body.trim(), key);
      } catch (err) {
        // An earlier send went through (its answer was lost) and the words changed since: this is a new message.
        if (!(err instanceof Error && /already used/.test(err.message))) throw err;
        const fresh = newKey();
        setKey(fresh);
        await onSend(body.trim(), fresh);
      }
      setBody('');
      setKey(newKey());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="group-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (body.trim() && !busy) void send();
      }}
    >
      {error && <p className="error">{error}</p>}
      <div className="group-composer-row">
        <label className="sr-only" htmlFor="group-message">
          Message {name}'s overseer
        </label>
        <textarea
          id="group-message"
          placeholder={`Message ${name}'s overseer`}
          value={body}
          maxLength={2000}
          rows={2}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim() && !busy) void send();
          }}
        />
        <button className="primary" type="submit" disabled={busy || !body.trim()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {delivery && (
        <p className={`presence-line presence-${group.presence!.state}`}>
          {delivery} <PresenceSessions group={group} />
        </p>
      )}
    </form>
  );
}
