/**
 * The "decided by" list of an access check in plain words.
 *
 * The engine answers with the ids of the policies that decided: the built-in
 * ones (`managed:rbac:user-write`, `managed:boundary:project-read`...) and the
 * custom ones. For a person a built-in id is noise; what matters is the setting
 * behind it: "Role: User", "Project limit: Retail · Model Hub = Read", "Token
 * scope: Model Hub = No access", and where that setting is changed. This module
 * turns one into the other. Pure (no React); covered by unit tests.
 */

import type { IamLevel, SimulateReason } from '../api';
import { memberHref, portalHref, projectMembersHref, TOKENS_HREF } from '../links';

/** What a built-in policy stands for. */
export type BuiltInKind =
  /** `managed:rbac:user-*`: a person's workspace access (role, own permissions, groups). */
  | 'role'
  /** `managed:rbac:token-*`: a token does what its owner can, within its scope. */
  | 'tokenOwner'
  /** `managed:boundary:project-*`: the project's own limit for this member. */
  | 'projectLimit'
  /** `managed:boundary:token-cap-*`: the token's scope. */
  | 'tokenScope'
  /** `managed:portal:use|agent`: the portal's access list admits the person. */
  | 'portalList'
  /** `managed:portal:*-boundary`: nothing but the portal's access list opens a portal or runs its agents. */
  | 'portalBoundary'
  /** `managed:agent:approve*`: the session's owner, or whoever the agent accepts, may approve its tool calls. */
  | 'approvalRule'
  | 'other';

export interface BuiltInReason {
  kind: BuiltInKind;
  /** The level the policy is about (the level of the request). */
  level: 'read' | 'write' | 'admin' | null;
}

const MANAGED = /^managed:(rbac|boundary):(user|token|token-cap|project)-(read|write|admin)$/;
const PORTAL_MANAGED = /^managed:portal:(use|agent)(-boundary)?$/;
const AGENT_MANAGED = /^managed:agent:approve(-token)?$/;

export function parseBuiltInReason(cedarId: string): BuiltInReason {
  const portal = PORTAL_MANAGED.exec(cedarId);
  if (portal) return { kind: portal[2] ? 'portalBoundary' : 'portalList', level: null };
  const agent = AGENT_MANAGED.exec(cedarId);
  if (agent) return { kind: 'approvalRule', level: null };
  const match = MANAGED.exec(cedarId);
  if (!match) return { kind: 'other', level: null };
  const [, group, who, level] = match;
  const kind: BuiltInKind =
    group === 'rbac' ? (who === 'user' ? 'role' : who === 'token' ? 'tokenOwner' : 'other')
    : who === 'project' ? 'projectLimit'
    : who === 'token-cap' ? 'tokenScope'
    : 'other';
  return { kind, level: level as BuiltInReason['level'] };
}

/** Which of a result's reasons is about project limits (the page then asks the server for the exact limit). */
export function hasProjectLimit(reasons: readonly SimulateReason[]): boolean {
  return reasons.some((r) => r.managed && parseBuiltInReason(r.cedarId).kind === 'projectLimit');
}

export interface ReasonLink {
  /** i18n key (under `iamCenter.result.change`) of the link text. */
  labelKey: 'member' | 'projectMember' | 'project' | 'token' | 'portal';
  href: string;
}

/** Where the setting behind a built-in reason is changed; `null` when there is no single place. */
export function reasonLink(
  kind: BuiltInKind,
  who: { type: 'user' | 'token'; id: string },
  projectId: string | null,
  portalId: string | null = null,
): ReasonLink | null {
  switch (kind) {
    case 'portalList':
    case 'portalBoundary':
      return portalId ? { labelKey: 'portal', href: portalHref(portalId) } : null;
    case 'role':
      return who.type === 'user' ? { labelKey: 'member', href: memberHref(who.id) } : { labelKey: 'token', href: TOKENS_HREF };
    case 'tokenOwner':
    case 'tokenScope':
      return { labelKey: 'token', href: TOKENS_HREF };
    case 'projectLimit':
      if (!projectId) return null;
      return who.type === 'user'
        ? { labelKey: 'projectMember', href: projectMembersHref(projectId, who.id) }
        : { labelKey: 'project', href: projectMembersHref(projectId) };
    default:
      return null;
  }
}

/**
 * The limit a project sets on one service for a member, from the member's
 * effective-permissions answer for that project (the `project` source of the
 * service row). `null` when the project does not limit that service.
 */
export function projectLimitFrom(
  effective: ReadonlyArray<{ service: string; sources: ReadonlyArray<{ kind: string; label: string; level: string }> }>,
  service: string,
): { level: IamLevel; projectName: string } | null {
  const row = effective.find((entry) => entry.service === service);
  const source = row?.sources.find((entry) => entry.kind === 'project');
  if (!source) return null;
  const level: IamLevel =
    source.level === 'read' || source.level === 'write' || source.level === 'admin' ? source.level : 'none';
  return { level, projectName: source.label };
}
