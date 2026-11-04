import { useEffect, useState } from 'react';
import type { Client, Epic, Escalation, Group, LaneMessage } from './api.ts';
import { AttachmentList } from './attachments.tsx';
import { LaneComposer, RichText } from './components.tsx';
import { DecisionForm, EscHead } from './escalations.tsx';
import { absolute, ago } from './format.ts';
import { openItem } from './nav.ts';
import { toast } from './toast.tsx';

/** One entry in the group's transcript: a message, or an escalation shown as its thread. */
type Item = { kind: 'msg'; at: string; key: string; m: LaneMessage } | { kind: 'esc'; at: string; key: string; esc: Escalation };

/**
 * Prototype of the unified group conversation: the group's messages and its escalations' threads in
 * one transcript. Built client-side from the existing board, lane and escalation APIs.
 */
export function GroupConversation({
  client,
  epic,
  laneIds,
  group,
  version,
  now,
  canWrite,
  decisions,
}: {
  client: Client;
  epic: Epic;
  laneIds: string[];
  group: Group | undefined;
  version: string;
  now: number;
  canWrite: boolean;
  decisions: boolean;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const board = await client.epicDetail(epic.id);
      const lanes = await Promise.all(laneIds.map((id) => client.laneDetail(epic.project, id)));
      const ids = new Set([...board.escalations, ...lanes.flatMap((l) => l.escalations)].map((e) => e.id));
      const escs = await Promise.all([...ids].map((id) => client.escalation(id)));
      const msgs = [...board.messages, ...lanes.flatMap((l) => l.messages)];
      const all: Item[] = [
        ...msgs.map((m) => ({ kind: 'msg' as const, at: m.at, key: `m${m.at}${m.id}`, m })),
        ...escs.map((esc) => ({ kind: 'esc' as const, at: esc.createdAt, key: `e${esc.id}`, esc })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      if (!cancelled) (setItems(all), setError(null));
    })().catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, epic.id, epic.project, laneIds.join(','), version, sent]);

  return (
    <div className="convo">
      {error && <p className="error">{error}</p>}
      {items && items.length === 0 && <p className="hint">No messages yet.</p>}
      <ol className="convo-list">
        {items?.map((it) =>
          it.kind === 'msg' ? (
            <Msg key={it.key} m={it.m} now={now} client={client} />
          ) : (
            <li key={it.key} className="convo-esc">
              <EscThread esc={it.esc} group={group} now={now} client={client} decisions={decisions} />
            </li>
          ),
        )}
      </ol>
      {canWrite && (
        <LaneComposer
          placeholder="Message the overseer"
          onSend={async (body) => {
            await client.epicMessage(epic.id, body);
            toast({ text: 'Sent to the overseer' });
            setSent((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function Msg({ m, now, client }: { m: LaneMessage; now: number; client: Client }) {
  return (
    <li className={`convo-msg from-${m.from}`}>
      <div className="msg-meta">
        {m.from === 'owner' ? 'You' : m.author} <span title={absolute(m.at)}>· {ago(m.at, now)}</span>
      </div>
      <RichText text={m.body} />
      {m.attachments.length > 0 && <AttachmentList client={client} files={m.attachments} />}
    </li>
  );
}

/** An escalation as a bounded thread: its question, the messages on it, and how it ended. */
function EscThread({
  esc,
  group,
  now,
  client,
  decisions,
}: {
  esc: Escalation;
  group: Group | undefined;
  now: number;
  client: Client;
  decisions: boolean;
}) {
  const open = esc.state === 'open';
  const closed = esc.state === 'acknowledged' || esc.state === 'withdrawn';
  return (
    <article className={`esc-card esc-thread ${esc.state}${esc.blocking ? '' : ' fyi'}${open && esc.turn === 'agent' ? ' agent-turn' : ''}`}>
      <EscHead esc={esc} lane={undefined} group={group} now={now} showProject={false} />
      <h3>{esc.question}</h3>
      {open && esc.recommendation && (
        <p className="rec-line">
          <span className="label">Recommends</span> {esc.recommendation}
        </p>
      )}
      {(esc.messages?.length ?? 0) > 0 && (
        <ol className="convo-list nested">
          {esc.messages!.map((m) => (
            <Msg key={m.id} m={{ ...m, attachments: m.attachments ?? [] } as LaneMessage} now={now} client={client} />
          ))}
        </ol>
      )}
      {open && esc.turn === 'agent' && <p className="hint">Waiting for the overseer to reply.</p>}
      {open && esc.turn === 'owner' && decisions && <DecisionForm esc={esc} client={client} compact onMore={() => openItem(`#/esc/${esc.id}`)} />}
      {!open && (
        <footer className="esc-outcome">
          {esc.decision ? (
            <span>
              Decided <strong>{esc.decision}</strong> by {esc.decidedBy}
              {esc.decidedAt && <span title={absolute(esc.decidedAt)}> · {ago(esc.decidedAt, now)}</span>}
            </span>
          ) : (
            esc.state === 'withdrawn' && <span>Dismissed</span>
          )}
          {closed && esc.resolution && <span>{esc.resolution}</span>}
          {esc.state === 'decided' && <span>Waiting for the overseer to acknowledge</span>}
          <a href={`#/esc/${esc.id}`}>Open</a>
        </footer>
      )}
    </article>
  );
}
