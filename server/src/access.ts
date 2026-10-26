import {
  ForbiddenError,
  localId,
  projectOf,
  NotFoundError,
  qualify,
  UUID,
  ValidationError,
  type RequirementInput,
  Store,
  type WaitResult,
  type WaitScope,
} from './store.ts';
import type { Epic, Escalation, Group, Lane, Link, Message, Principal, ProjectRole, Requirement, RequirementScope, StreamEvent, Ticket } from './types.ts';

/**
 * What a caller may see and do across projects, and the translation between
 * the store's qualified ids ("project/lane") and the per-project ids clients use.
 *
 * - Config tokens and account admins (and keys they own): every project, as admin.
 * - People: the projects they're members of, with their role there.
 * - Agent keys: their owner's projects, or only the one project the key is bound to.
 */
export interface Access {
  principal: Principal;
  /** Project ids the caller can see. */
  projects: string[];
  roleIn(project: string): ProjectRole | null;
  /** May manage the project's members and settings. */
  isAdmin(project: string): boolean;
  /**
   * The project a request acts on: the given id or key, or (when omitted) the key's bound
   * project, the caller's only project, or the one project of the caller's that has the
   * named lane or group. Unknown and inaccessible projects are both 404s.
   */
  pick(project?: string | null, hint?: { lane?: string; group?: string }): string;
  /** A project filter for listings: the given one, or every project the caller can see. */
  scope(project?: string | null): string[];
  /** Finds an escalation by id or code the caller may see (a code needs its project). */
  escalation(idOrCode: string, project?: string | null): Escalation;
  /**
   * Finds an epic the caller may see, as agents name it: any form of its ticket ref, or a group's id
   * for that group's epic. Null when nothing matches.
   */
  epic(name: string, project?: string | null): Epic | null;
  /** An epic by its number, if the caller may see it. */
  epicById(id: number): Epic;
  /** May write requirements that apply to every project: only credentials that see every project, unbound. */
  global: boolean;
  /** Throws unless the caller may change this requirement (all-projects ones need `global`). */
  requireWritable(r: { project: string | null }): void;
  /** Records the caller can see: their projects', and all-projects ones. */
  sees(r: { project: string | null }): boolean;
}

export function accessFor(store: Store, principal: Principal): Access {
  const all = !principal.userId || principal.superuser;
  const memberships = all ? null : store.membershipsOf(principal.userId!);
  let visible = all ? store.listProjects().map((p) => p.id) : [...memberships!.keys()];
  if (principal.project) visible = visible.filter((p) => p === principal.project);

  const global = !!all && !principal.project;

  const roleIn = (project: string): ProjectRole | null => {
    if (!visible.includes(project)) return null;
    if (principal.role === 'agent') return 'member';
    if (all) return 'admin';
    return memberships!.get(project)?.role ?? null;
  };

  const resolve = (project: string) => {
    const found = store.projectByKey(project);
    if (!found || !visible.includes(found.id)) throw new NotFoundError(`Project "${project}" not found`);
    return found.id;
  };

  const ask = (among: string[]) => {
    const keys = among.map((id) => store.getProject(id)?.key ?? id);
    return new ValidationError(`Say which project: ${keys.join(', ')} (the "project" parameter, by id or key)`);
  };

  const pick = (project?: string | null, hint?: { lane?: string; group?: string }) => {
    if (project) return resolve(project);
    if (principal.project) {
      // A key bound to a project its owner can't see (or that doesn't exist) reaches nothing.
      if (!visible.includes(principal.project)) throw new NotFoundError(`Project "${principal.project}" not found`);
      return principal.project;
    }
    if (visible.length === 1) return visible[0];
    if (!visible.length) throw new NotFoundError('You are not a member of any project yet; ask an admin to add you');
    // Several projects: an existing lane or group id names its project, so an overseer that
    // was running before a second project appeared keeps working without a `project`.
    const owners = (has: (p: string) => boolean) => visible.filter(has);
    // Lanes on the dashboard count before removed ones (which come back only when republished).
    const lanes = (id: string) => {
      const active = owners((p) => store.getLane(qualify(p, id)) !== null);
      return active.length ? active : owners((p) => store.laneExists(qualify(p, id)));
    };
    let found: string[] = [];
    if (hint?.group) {
      // A group decides: its project is where the lane goes (or already is) — never another project's lane.
      found = owners((p) => store.groupExists(qualify(p, hint.group!)));
      if (hint.lane && found.length > 1) {
        const withLane = found.filter((p) => store.laneExists(qualify(p, hint.lane!)));
        if (withLane.length) found = withLane;
      }
      // An unknown group: let the lane decide, so the store can say "Group … not found".
      if (!found.length && hint.lane) found = lanes(hint.lane);
    } else if (hint?.lane) {
      found = lanes(hint.lane);
    }
    if (found.length === 1) return found[0];
    if (found.length > 1) throw ask(found);
    throw ask(visible);
  };

  return {
    principal,
    projects: visible,
    roleIn,
    isAdmin: (project) => roleIn(project) === 'admin' && principal.role === 'human',
    pick,
    scope: (project) => (project ? [resolve(project)] : visible),
    escalation(idOrCode, project) {
      const notFound = () => new NotFoundError(`Escalation "${idOrCode}" not found`);
      const inProject = project ? resolve(project) : undefined;
      let e: Escalation | null;
      const text = idOrCode.trim();
      // A bare code: a lane letter's ("A12") or a ticket's or epic's ("967A", "gh:632B", "paymentsA"), not one keyed with a project.
      const bare =
        /^#?[A-Za-z]{1,4}\d+$/.test(text) || (!UUID.test(text) && /[A-Za-z]$/.test(text) && !store.isKeyedCode(text));
      if (!inProject && bare) {
        // A bare code: look only in the caller's projects; more than one match needs a project.
        const hits = visible.map((p) => store.getEscalation(idOrCode, p)).filter((x) => x !== null);
        if (hits.length > 1) {
          const keys = hits.map((h) => `${h.projectKey}-${h.ref}`);
          throw new ValidationError(`"${idOrCode}" is in several projects: say which (${keys.join(', ')})`);
        }
        e = hits[0] ?? null;
      } else {
        e = store.getEscalation(idOrCode, inProject);
      }
      // A keyed code ("SH-A1") names its own project; anything else must be in the one asked for.
      const keyed = /^#?[A-Za-z0-9]{1,10}[·:.-][A-Za-z]{1,4}\d+$/.test(text) || store.isKeyedCode(text);
      if (!e || !visible.includes(e.project) || (inProject && !keyed && e.project !== inProject)) throw notFound();
      return e;
    },
    epic(name, project) {
      const hits = (project ? [resolve(project)] : visible).flatMap((p) => store.findEpic(p, name) ?? []);
      if (hits.length > 1) throw ask(hits.map((e) => e.project));
      return hits[0] ?? null;
    },
    epicById(id) {
      const e = store.getEpic(id);
      if (!e || !visible.includes(e.project)) throw new NotFoundError(`Epic ${id} not found`);
      return e;
    },
    global,
    requireWritable(r) {
      if (r.project === null && !global) {
        throw new ForbiddenError('Only an instance admin (or a key it owns that is not bound to a project) changes requirements for all projects');
      }
    },
    sees: (r) => r.project === null || visible.includes(r.project),
  };
}

/**
 * Where a new escalation goes, from a client's `lane_id` and/or `epic`: the qualified lane it's raised
 * in (an epic's internal lane when raised on the epic directly) and the epic's number, if named.
 */
export function escalationTarget(store: Store, a: Access, raw: { laneId?: string; epic?: string }, project?: string | null) {
  if (raw.epic) {
    const e = a.epic(raw.epic, project ?? (raw.laneId ? a.pick(project, { lane: raw.laneId }) : undefined));
    if (!e) throw new NotFoundError(`Epic "${raw.epic}" not found: name it by its ticket ref, or its group's id (list_epics shows them)`);
    if (raw.laneId && !store.laneExists(qualify(e.project, raw.laneId))) {
      throw new NotFoundError(`Lane "${raw.laneId}" not found: publish it first, or leave lane_id out to raise it on the epic`);
    }
    return { laneId: raw.laneId ? qualify(e.project, raw.laneId) : Store.epicLaneId(e.project, e.id), epic: e.id };
  }
  return { laneId: qualify(a.pick(project, { lane: raw.laneId }), raw.laneId!), epic: undefined };
}

/**
 * update_epic: changes an epic named by its ref or group. A ref no epic has yet, with a `group`, adds
 * a real epic to that group; so does giving a ref to a group's stand-in epic. Either retires the stand-in.
 */
export function updateEpicFor(
  store: Store,
  a: Access,
  raw: { epic: string; group?: string; name?: string; ref?: string; links?: Link[]; statusLine?: string | null },
  project: string | null | undefined,
  actor: string,
): Epic {
  const fields = { name: raw.name, links: raw.links, statusLine: raw.statusLine };
  const found = a.epic(raw.epic, project ?? (raw.group ? a.pick(project, { group: raw.group }) : undefined));
  if (found) {
    if (found.standIn && raw.ref?.trim()) return store.upsertEpic(found.project, { groupId: found.group, ref: raw.ref, ...fields }, actor);
    return store.upsertEpic(found.project, { epic: found.id, ref: raw.ref, ...fields }, actor);
  }
  if (!raw.group) {
    throw new NotFoundError(`Epic "${raw.epic}" not found: to add it, say which group it belongs to (group); list_epics shows the epics`);
  }
  const pr = a.pick(project, { group: raw.group });
  return store.upsertEpic(pr, { groupId: qualify(pr, raw.group), ref: raw.ref?.trim() || raw.epic, ...fields }, actor);
}

/** A per-project id from a client, qualified for the store. */
export const q = qualify;

/** A wait scope from a client (per-project ids, codes), qualified and checked against what the caller can see. */
export function waitScopeFor(
  a: Access,
  raw: { ids?: string[]; laneIds?: string[]; groupId?: string; since?: string },
  project?: string | null,
): WaitScope {
  const pr = raw.laneIds?.length || raw.groupId ? a.pick(project, { group: raw.groupId, lane: raw.laneIds?.[0] }) : undefined;
  return {
    ids: raw.ids?.map((id) => a.escalation(id, project).id),
    laneIds: raw.laneIds?.map((l) => qualify(pr!, l)),
    groupId: raw.groupId ? qualify(pr!, raw.groupId) : undefined,
    since: raw.since,
    viewer: a.principal.name,
  };
}

/**
 * A requirement from a client: `allProjects` makes it an owner-wide rule, otherwise it belongs to
 * the request's project (a supersede keeps the old one's scope unless told otherwise). A person
 * recording one is the decider unless they say otherwise.
 */
export function requirementInputFor(
  a: Access,
  body: {
    requirement: string;
    justification: string;
    tags: string[];
    group?: string | null;
    sourceEscalation?: string | null;
    decidedBy?: string | null;
    allProjects?: boolean;
    scope?: RequirementScope;
    products?: string[];
  },
  project: string | undefined,
  current?: Requirement,
): RequirementInput {
  if (body.allProjects !== undefined && body.scope !== undefined && body.allProjects !== (body.scope === 'global')) {
    throw new ValidationError(`allProjects and scope "${body.scope}" disagree: a requirement for all projects is scope "global"`);
  }
  if (body.scope === 'global') body = { ...body, allProjects: true };
  const keepScope =
    current !== undefined && body.allProjects === undefined && body.scope === undefined && body.group === undefined && !project;
  // Without a project: the group's, or the cited escalation's.
  const cited = !project && !body.group && body.sourceEscalation && !body.allProjects && !keepScope ? a.escalation(body.sourceEscalation) : null;
  // A supersede naming a scope but no project stays in the old one's project.
  const sameProject = current !== undefined && current.project !== null && !project && !body.group && !body.allProjects;
  const scopeProject = body.allProjects
    ? null
    : keepScope || sameProject
      ? current!.project
      : (cited?.project ?? a.pick(project, { group: body.group ?? undefined }));
  if (current) a.requireWritable(current);
  a.requireWritable({ project: scopeProject });
  const human = a.principal.role === 'human';
  // A project's requirement can only cite that project's escalations.
  const source = body.sourceEscalation ? a.escalation(body.sourceEscalation, project ?? scopeProject) : null;
  if (source && scopeProject !== null && source.project !== scopeProject) {
    throw new ValidationError(`${source.projectKey}-${source.ref} belongs to another project`);
  }
  return {
    requirement: body.requirement,
    justification: body.justification,
    tags: body.tags,
    project: scopeProject,
    ...(body.scope !== undefined ? { scope: body.scope, products: body.products } : {}),
    ...(body.scope === undefined && body.products?.length ? { scope: 'products' as const, products: body.products } : {}),
    group: body.group ? qualify(scopeProject ?? a.pick(project, { group: body.group }), body.group) : keepScope ? undefined : body.group,
    sourceEscalation: source ? source.id : body.sourceEscalation,
    decidedBy: body.decidedBy ?? (human && !body.sourceEscalation ? a.principal.name : null),
  };
}

// ---- public shapes: per-project ids, as clients know them ----

export const pub = {
  group: (g: Group): Group => ({ ...g, id: localId(g.id) }),
  lane: (l: Lane): Lane => ({ ...l, id: localId(l.id), group: l.group && localId(l.group) }),
  // An epic's own question has no lane a client knows: its internal lane is never shown.
  escalation: <E extends Escalation>(e: E): E => ({ ...e, laneId: pubLaneId(e.laneId) }),
  requirement: (r: Requirement): Requirement => ({ ...r, group: r.group && localId(r.group) }),
  epic: (e: Epic): Epic => ({ ...e, group: localId(e.group) }),
  ticket: (t: Ticket): Ticket => ({
    ...t,
    group: t.group && localId(t.group),
    lane: t.lane && localId(t.lane),
    lastLane: t.lastLane && localId(t.lastLane),
  }),
  /**
   * A wait result for a client. `projects` is what the caller sees *now*: a long wait
   * re-checks it, so someone removed from a project meanwhile gets nothing from it.
   */
  wait: (w: WaitResult, projects?: string[]): WaitResult => {
    const keep = (laneId: string | null) => !projects || (laneId !== null && projects.includes(projectOf(laneId)));
    return {
      ...w,
      decided: w.decided.filter((e) => keep(e.laneId)).map(pub.escalation),
      closed: w.closed.filter((e) => keep(e.laneId)).map(pub.escalation),
      replies: w.replies.filter((r) => keep(r.laneId)).map((r) => ({ ...r, laneId: pubLaneId(r.laneId) })),
      open: w.open.filter((o) => keep(o.laneId)).map((o) => ({ ...o, laneId: pubLaneId(o.laneId) })),
      removedLanes: w.removedLanes.filter((l) => keep(l.laneId)).map((l) => ({ ...l, laneId: localId(l.laneId) })),
      laneMessages: w.laneMessages.filter((l) => keep(l.laneId)).map((l) => ({ ...l, laneId: localId(l.laneId) })),
      movedTickets: w.movedTickets.filter((m) => keep(m.laneId)).map((m) => ({ ...m, laneId: localId(m.laneId) })),
      boardMessages: w.boardMessages.filter((b) => !projects || projects.includes(b.project)),
    };
  },
  /** The event as a client sees it, or null when the caller can't see its project. */
  event(e: StreamEvent, projects: string[]): StreamEvent | null {
    switch (e.type) {
      case 'group':
        return projects.includes(e.group.project) ? { ...e, group: pub.group(e.group) } : null;
      case 'lane':
        return projects.includes(e.lane.project) ? { ...e, lane: pub.lane(e.lane) } : null;
      case 'escalation':
        return projects.includes(e.escalation.project) ? { ...e, escalation: pub.escalation(e.escalation) } : null;
      case 'group_deleted':
      case 'lane_deleted':
        return projects.includes(e.project) ? { ...e, id: localId(e.id) } : null;
      case 'requirement':
        return e.requirement.project === null || projects.includes(e.requirement.project)
          ? { type: 'requirement', requirement: pub.requirement(e.requirement) }
          : null;
      case 'ticket':
        return projects.includes(e.ticket.project) ? { ...e, ticket: pub.ticket(e.ticket) } : null;
      case 'product':
        return projects.includes(e.product.project) ? e : null;      case 'epic':
        return projects.includes(e.epic.project) ? { ...e, epic: pub.epic(e.epic) } : null;
    }
  },
};

/**
 * An escalation as agents need it after asking: what was decided, not the whole question echoed
 * back (context can run to pages). get_escalation and GET /api/escalations/:id return everything.
 */
export const brief = (e: Escalation & { duplicate?: boolean; upgraded?: boolean }) =>
  compact({
    id: e.id,
    ref: e.ref,
    duplicate: e.duplicate,
    upgraded: e.upgraded,
    turn: e.state === 'open' && e.turn === 'agent' ? 'agent' : undefined,
    projectKey: e.projectKey,
    laneId: e.laneId === null || isEpicLane(e.laneId) ? undefined : e.laneId,
    // An epic's question: which epic (its lane, if any, is only where it was raised).
    epic: e.epicName,
    state: e.state,
    blocking: e.blocking ? undefined : false,
    question: e.question,
    decision: e.decision,
    decisionNote: e.decisionNote,
    decidedBy: e.decidedBy,
    resolution: e.resolution,
    positions: e.positions.length ? e.positions : undefined,
    createdBy: e.createdBy,
  });

/** Drops null and undefined fields, which an agent would pay for and learn nothing from. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

/** A lane as an agent needs it back after publishing: where it stands, not everything echoed. */
export const briefLane = (l: Lane, decisions: boolean) =>
  compact({
    id: l.id,
    project: l.project,
    letter: l.letter,
    group: l.group,
    status: l.status,
    ticket: l.ticket,
    activity: l.activity,
    openEscalations: l.openEscalations || undefined,
    blockingEscalations: l.blockingEscalations || undefined,
    agentWaiting: decisions && l.agentWaiting ? true : undefined,
  });

/** A ticket as agents read it: where it is and why, without bookkeeping (takes the public shape). */
export const briefTicket = (t: Ticket) =>
  compact({
    ref: t.displayRef,
    code: t.code,
    state: t.state,
    lane: t.lane,
    group: t.group,
    status: t.status,
    parkReason: t.parkReason,
    waitingOn: t.waitingOn,
    openEscalations: t.openEscalations || undefined,
    updatedAt: t.updatedAt,
  });

/** An epic as agents read it. `epic` is how to name it in other tools: its ref, or the group's id for a stand-in. */
export const briefEpic = (e: Epic) =>
  compact({
    epic: e.displayRef ?? e.group,
    name: e.name,
    group: e.group,
    project: e.project,
    code: e.code,
    standIn: e.standIn || undefined,
    state: e.state,
    statusLine: e.statusLine,
    closeReason: e.closeReason,
    openEscalations: e.openEscalations || undefined,
    blockingEscalations: e.blockingEscalations || undefined,
    unreadNotes: e.unreadByAgent || undefined,
    updatedAt: e.updatedAt,
  });

/** A requirement as agents read it: the decision and why, without bookkeeping. */
export const briefRequirement = (r: Requirement) =>
  compact({
    id: r.id,
    project: r.project ?? 'all',
    group: r.group,
    requirement: r.requirement,
    justification: r.justification,
    tags: r.tags,
    status: r.status === 'active' ? undefined : r.status,
    supersededBy: r.supersededBy,
    decidedBy: r.decidedBy,
    sourceEscalation: r.sourceEscalation,
  });

/** Messages as agents read them: what was said, by whom, when, and any files. */
export const briefMessages = (messages: Message[]) =>
  messages.map((m) => compact({ body: m.body, by: m.author, at: m.at, attachments: m.attachments.length ? m.attachments : undefined }));

/** An epic's internal lane (its own questions are raised there), in either id form. */
export const isEpicLane = (laneId: string) => /(^|\/)~epic-\d+$/.test(laneId);

/** A lane id as clients know it; null for an epic's internal lane. */
const pubLaneId = (laneId: string | null) => (laneId === null || isEpicLane(laneId) ? null : localId(laneId));

/** The owner's messages as one text: each in full, with any files attached (name and id, for GET /api/attachments/:id). */
const ownerWords = (messages: { body: string; attachments: { id: string; name: string }[] }[]) =>
  messages
    .map((m) => (m.attachments.length ? `${m.body} [attached: ${m.attachments.map((f) => `${f.name} (id ${f.id})`).join(', ')}]` : m.body))
    .join('\n\n');

/**
 * A wait result as a digest: one item per thing to handle, `{code, kind, id, text}`, with the owner's
 * words in full in `text` and nothing of the agent's own; counts in place of the open list. `code`
 * is the escalation's (with its project key when the caller reaches several projects); `id` is the
 * escalation's id, or for the rest the lane, ticket or epic it's about. Decisions and replies are
 * listed on every wait until handled; the rest once per `since`. Takes the public shape (local lane ids).
 */
export const digestWait = (w: WaitResult, keyed = false) => {
  const code = (e: { ref: string; projectKey: string }) => (keyed ? `${e.projectKey}-${e.ref}` : e.ref);
  const items = [
    ...w.decided.map((e) => ({
      code: code(e),
      kind: 'decided',
      id: e.id,
      text: e.decisionNote ? `${e.decision}: ${e.decisionNote}` : (e.decision ?? ''),
    })),
    ...w.replies.map((r) => ({ code: code(r), kind: 'reply', id: r.id, text: ownerWords(r.messages) })),
    ...w.closed.map((e) => ({ code: code(e), kind: 'closed', id: e.id, text: e.resolution ?? e.state })),
    ...w.removedLanes.map((l) => ({ kind: 'lane_removed', id: l.laneId, text: l.removedBy ? `Removed by ${l.removedBy}` : 'Removed' })),
    ...w.laneMessages.map((l) => ({ kind: 'lane_note', id: l.laneId, text: ownerWords(l.messages) })),
    ...w.movedTickets.map((m) => ({ kind: 'ticket_moved', id: m.ticket, text: `Taken into lane ${m.laneId}${m.by ? ` by ${m.by}` : ''}` })),
    ...w.boardMessages.map((b) => ({ kind: 'board_note', id: b.epic, text: ownerWords(b.messages) })),
  ];
  return {
    // From the items themselves: `pub.wait` may have dropped some the caller no longer sees.
    ready: items.length > 0,
    items,
    counts: { open: w.open.length, decidedUnacknowledged: w.decided.length, waitingOnYou: w.replies.length },
    checkedAt: w.checkedAt,
  };
};

/** A wait result with its escalations in brief. */
export const briefWait = ({ movedTickets: _moved, ...w }: WaitResult) => ({
  ...w,
  decided: w.decided.map(brief),
  replies: w.replies.map(({ projectKey: _key, ...r }) => ({ ...r, messages: briefMessages(r.messages) })),
  closed: w.closed.map(brief),
  // Only when there are some: the wait is the call agents make most.
  laneMessages: w.laneMessages.length ? w.laneMessages.map((l) => ({ ...l, messages: briefMessages(l.messages) })) : undefined,
  boardMessages: w.boardMessages.length
    ? w.boardMessages.map(({ project: _project, ...b }) => ({ ...b, messages: briefMessages(b.messages) }))
    : undefined,
});

/**
 * The identity an escalation records as its raiser: the key (its account and name, so overseers whose
 * keys one person created stay apart, while a rotated key of the same name still matches), or the
 * config token.
 */
/**
 * Whether what this caller records about requirements counts as approved, and whether it may
 * approve: people, but not agents or personal keys (Claude writing in someone's session).
 */
export const approvesRequirements = (p: Principal) => p.role === 'human' && !p.personalKey;

export const ownerOf = (p: Principal) => (p.userId ? `user:${p.userId}:${p.name}` : `token:${p.name}`);

/**
 * Only the agent that raised an escalation acknowledges or dismisses it (or a person, on its behalf):
 * codes repeat across groups, and another overseer closing it by mistake would swallow the decision.
 */
export function requireRaiser(store: Store, a: Access, e: Escalation, verb: 'acknowledge' | 'dismiss' | 'reply to') {
  if (a.principal.role !== 'agent') return;
  const owner = store.escalationOwner(e.id);
  // Older rows recorded the account alone ("user:<id>"); those match any key of that account.
  const me = ownerOf(a.principal);
  const mine = owner ? owner === me || (a.principal.userId !== undefined && owner === `user:${a.principal.userId}`) : e.createdBy === a.principal.name;
  // A ticket moved to another overseer's group goes with its questions: that overseer may close them too.
  // An epic's questions: its group's overseer too.
  const overseer =
    (e.ticketId !== null && store.ticketOverseer(e.ticketId) === me) || (e.epicId !== null && store.epicOverseer(e.epicId) === me);
  if (!mine && !overseer) {
    throw new ForbiddenError(
      `${e.ref} was raised by ${e.createdBy}; only that agent, the overseer of the group its ${e.epicId !== null ? 'epic' : 'ticket'} is in, or a person can ${verb} it`,
    );
  }
}
