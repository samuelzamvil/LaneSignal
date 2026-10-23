import {
  ForbiddenError,
  localId,
  projectOf,
  NotFoundError,
  qualify,
  ValidationError,
  type RequirementInput,
  type Store,
  type WaitResult,
  type WaitScope,
} from './store.ts';
import type { Escalation, Group, Lane, Principal, ProjectRole, Requirement, StreamEvent } from './types.ts';

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
      if (!inProject && /^#?[A-Za-z]{1,4}\d+$/.test(idOrCode.trim())) {
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
      const keyed = /^#?[A-Za-z0-9]{1,10}[·:.-][A-Za-z]{1,4}\d+$/.test(idOrCode.trim());
      if (!e || !visible.includes(e.project) || (inProject && !keyed && e.project !== inProject)) throw notFound();
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
  },
  project: string | undefined,
  current?: Requirement,
): RequirementInput {
  const keepScope = current !== undefined && body.allProjects === undefined && body.group === undefined && !project;
  // Without a project: the group's, or the cited escalation's.
  const cited = !project && !body.group && body.sourceEscalation && !body.allProjects && !keepScope ? a.escalation(body.sourceEscalation) : null;
  const scopeProject = body.allProjects ? null : keepScope ? current.project : (cited?.project ?? a.pick(project, { group: body.group ?? undefined }));
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
    group: body.group ? qualify(scopeProject ?? a.pick(project, { group: body.group }), body.group) : keepScope ? undefined : body.group,
    sourceEscalation: source ? source.id : body.sourceEscalation,
    decidedBy: body.decidedBy ?? (human && !body.sourceEscalation ? a.principal.name : null),
  };
}

// ---- public shapes: per-project ids, as clients know them ----

export const pub = {
  group: (g: Group): Group => ({ ...g, id: localId(g.id) }),
  lane: (l: Lane): Lane => ({ ...l, id: localId(l.id), group: l.group && localId(l.group) }),
  escalation: <E extends Escalation>(e: E): E => ({ ...e, laneId: localId(e.laneId) }),
  requirement: (r: Requirement): Requirement => ({ ...r, group: r.group && localId(r.group) }),
  /**
   * A wait result for a client. `projects` is what the caller sees *now*: a long wait
   * re-checks it, so someone removed from a project meanwhile gets nothing from it.
   */
  wait: (w: WaitResult, projects?: string[]): WaitResult => {
    const keep = (laneId: string) => !projects || projects.includes(projectOf(laneId));
    return {
      ...w,
      decided: w.decided.filter((e) => keep(e.laneId)).map(pub.escalation),
      closed: w.closed.filter((e) => keep(e.laneId)).map(pub.escalation),
      open: w.open.filter((o) => keep(o.laneId)).map((o) => ({ ...o, laneId: localId(o.laneId) })),
      removedLanes: w.removedLanes.filter((l) => keep(l.laneId)).map((l) => ({ ...l, laneId: localId(l.laneId) })),
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
          ? { ...e, requirement: pub.requirement(e.requirement) }
          : null;
    }
  },
};

/**
 * An escalation as agents need it after asking: what was decided, not the whole question echoed
 * back (context can run to pages). get_escalation and GET /api/escalations/:id return everything.
 */
export const brief = (e: Escalation & { duplicate?: boolean }) =>
  compact({
    id: e.id,
    ref: e.ref,
    duplicate: e.duplicate,
    projectKey: e.projectKey,
    laneId: e.laneId,
    state: e.state,
    blocking: e.blocking ? undefined : false,
    question: e.question,
    decision: e.decision,
    decisionNote: e.decisionNote,
    decidedBy: e.decidedBy,
    resolution: e.resolution,
    positions: e.positions.length ? e.positions : undefined,
  });

/** Drops null, undefined and false-y flags an agent would pay for and learn nothing from. */
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

/** A wait result with its escalations in brief. */
export const briefWait = (w: WaitResult) => ({ ...w, decided: w.decided.map(brief), closed: w.closed.map(brief) });

/**
 * The identity an escalation records as its raiser: the key (its account and name, so overseers whose
 * keys one person created stay apart, while a rotated key of the same name still matches), or the
 * config token.
 */
export const ownerOf = (p: Principal) => (p.userId ? `user:${p.userId}:${p.name}` : `token:${p.name}`);

/**
 * Only the agent that raised an escalation acknowledges or dismisses it (or a person, on its behalf):
 * codes repeat across groups, and another overseer closing it by mistake would swallow the decision.
 */
export function requireRaiser(store: Store, a: Access, e: Escalation, verb: 'acknowledge' | 'dismiss') {
  if (a.principal.role !== 'agent') return;
  const owner = store.escalationOwner(e.id);
  const mine = owner ? owner === ownerOf(a.principal) : e.createdBy === a.principal.name;
  if (!mine) throw new ForbiddenError(`${e.ref} was raised by ${e.createdBy}; only that agent (or a person) can ${verb} it`);
}
