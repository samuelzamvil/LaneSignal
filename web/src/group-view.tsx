import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Client, Escalation, Group, GroupFeedItem } from './api.ts';
import { AttachmentList } from './attachments.tsx';
import { RichText } from './components.tsx';
import { absolute, ago } from './format.ts';
import { markMessagesSeen } from './seen.ts';

/** A group's conversation: its sheet's route. */
export const groupRoute = (project: string, group: string) => `#/group/${encodeURIComponent(project)}/${encodeURIComponent(group)}`;

type Item = GroupFeedItem;
const keyOf = (i: Item) => `${i.type}:${i.id}`;

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
}) {
  // Newest first, as pages arrive: the latest page is refetched on changes, older ones stay.
  const [latest, setLatest] = useState<Item[] | null>(null);
  const [older, setOlder] = useState<Item[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const bottom = useRef<HTMLDivElement>(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    let cancelled = false;
    client
      .groupConversation(project, groupId)
      .then((page) => {
        if (cancelled) return;
        setLatest(page.items);
        // The first page decides where older pages start; later refetches keep what's loaded.
        setNext((n) => (firstLoad.current ? page.next : n));
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, project, groupId, version, sent]);

  // Read here: the chat button stops marking the overseer's messages as new.
  useEffect(() => {
    if (group) markMessagesSeen(group, group.lastAgentMessageId);
  }, [group]);

  // Opens at the newest message, like a chat.
  useLayoutEffect(() => {
    if (latest && firstLoad.current) {
      firstLoad.current = false;
      bottom.current?.scrollIntoView({ block: 'end' });
    }
  }, [latest]);

  async function loadOlder() {
    if (!next) return;
    setLoadingOlder(true);
    try {
      const page = await client.groupConversation(project, groupId, next);
      setOlder((o) => [...o, ...page.items]);
      setNext(page.next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingOlder(false);
    }
  }

  // Oldest first on screen. A message on an escalation shows in its thread, not on its own.
  const seen = new Set<string>();
  const items = [...(latest ?? []), ...older]
    .filter((i) => {
      const k = keyOf(i);
      if (seen.has(k)) return false;
      seen.add(k);
      return !(i.type === 'message' && i.escalationId);
    })
    .reverse();

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
          {latest && items.length === 0 && <p className="hint">Nothing said yet. What you write here reaches {name}'s overseer.</p>}
          <ol className="convo-list">
            {items.map((i) =>
              i.type === 'message' ? (
                <li key={keyOf(i)} className={`convo-msg from-${i.from}`}>
                  <div className="msg-meta">
                    {i.author} <span title={absolute(i.at)}>· {ago(i.at, now)}</span>
                    {i.laneId && <span> · on lane {i.laneId}</span>}
                    {i.epicId !== null && <span> · on an epic's board</span>}
                  </div>
                  <RichText text={i.body} />
                  {i.attachments.length > 0 && <AttachmentList client={client} files={i.attachments} />}
                </li>
              ) : (
                <li key={keyOf(i)} className="convo-esc">
                  <EscalationThread item={i} live={escalations.get(i.id)} client={client} now={now} />
                </li>
              ),
            )}
          </ol>
          <div ref={bottom} />
        </div>
        {canWrite && group && (
          <GroupComposer
            name={name}
            onSend={async (body, clientKey) => {
              await client.groupMessage(project, groupId, body, clientKey);
              setSent((n) => n + 1);
              requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }));
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
}: {
  item: Extract<GroupFeedItem, { type: 'escalation' }>;
  live: Escalation | undefined;
  client: Client;
  now: number;
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
          <a href={`#/esc/${item.id}`}>Open escalation</a>
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
function GroupComposer({ name, onSend }: { name: string; onSend: (body: string, clientKey: string) => Promise<void> }) {
  const [body, setBody] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await onSend(body.trim(), key);
      setBody('');
      setKey(crypto.randomUUID());
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
    </form>
  );
}
