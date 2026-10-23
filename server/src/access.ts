import {
  localId,
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
   * project or the caller's only project. Unknown and inaccessible projects are both 404s.
   */
  pick(project?: string | null): string;
  /** A project filter for listings: the given one, or every project the caller can see. */
  scope(project?: string | null): string[];
  /** Finds an escalation by id or code the caller may see (a code needs its project). */
  escalation(idOrCode: string, project?: string | null): Escalation;
}

export function accessFor(store: Store, principal: Principal): Access {
  const all = !principal.userId || principal.superuser;
  const memberships = all ? null : store.membershipsOf(principal.userId!);
  let visible = all ? store.listProjects().map((p) => p.id) : [...memberships!.keys()];
  if (principal.project) visible = visible.filter((p) => p === principal.project);

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

  const pick = (project?: string | null) => {
    if (project) return resolve(project);
    if (principal.project) return principal.project;
    if (visible.length === 1) return visible[0];
    if (!visible.length) throw new NotFoundError('You are not a member of any project yet; ask an admin to add you');
    const keys = visible.map((id) => store.getProject(id)?.key ?? id);
    throw new ValidationError(`Say which project: ${keys.join(', ')} (the "project" parameter, by id or key)`);
  };

  return {
    principal,
    projects: visible,
    roleIn,
    isAdmin: (project) => roleIn(project) === 'admin' && principal.role === 'human',
    pick,
    scope: (project) => (project ? [resolve(project)] : visible),
    escalation(idOrCode, project) {
      const found = store.getEscalation(idOrCode, project ? resolve(project) : undefined);
      // A bare code is ambiguous across projects; try the caller's default project.
      const e =
        found ??
        (!project && visible.length > 0 && /^#?[A-Za-z]{1,4}\d+$/.test(idOrCode.trim())
          ? (() => {
              try {
                return store.getEscalation(idOrCode, pick());
              } catch {
                return null;
              }
            })()
          : null);
      if (!e || !visible.includes(e.project)) throw new NotFoundError(`Escalation "${idOrCode}" not found`);
      return e;
    },
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
  const pr = raw.laneIds?.length || raw.groupId ? a.pick(project) : undefined;
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
  const scopeProject = body.allProjects ? null : keepScope ? current.project : a.pick(project);
  const human = a.principal.role === 'human';
  return {
    requirement: body.requirement,
    justification: body.justification,
    tags: body.tags,
    project: scopeProject,
    group: body.group ? qualify(a.pick(project), body.group) : keepScope ? undefined : body.group,
    sourceEscalation: body.sourceEscalation ? a.escalation(body.sourceEscalation, project).id : body.sourceEscalation,
    decidedBy: body.decidedBy ?? (human && !body.sourceEscalation ? a.principal.name : null),
  };
}

// ---- public shapes: per-project ids, as clients know them ----

export const pub = {
  group: (g: Group): Group => ({ ...g, id: localId(g.id) }),
  lane: (l: Lane): Lane => ({ ...l, id: localId(l.id), group: l.group && localId(l.group) }),
  escalation: <E extends Escalation>(e: E): E => ({ ...e, laneId: localId(e.laneId) }),
  requirement: (r: Requirement): Requirement => ({ ...r, group: r.group && localId(r.group) }),
  wait: (w: WaitResult): WaitResult => ({
    ...w,
    decided: w.decided.map(pub.escalation),
    closed: w.closed.map(pub.escalation),
    open: w.open.map((o) => ({ ...o, laneId: localId(o.laneId) })),
    removedLanes: w.removedLanes.map((l) => ({ ...l, laneId: localId(l.laneId) })),
  }),
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
