/**
 * How policies are presented through the API: the `PolicyRow` of a custom
 * policy, the plain-language description of a managed one, and the "who does
 * this policy mention" index behind `policyCount` and the principal detail.
 */

import { policyToJson, splitPolicyText } from './cedar';
import { resolvePrincipalLabels } from './labels';
import { listManagedPolicies } from './managedPolicies';
import type { PolicySpec } from './policySpec';
import type { IIamPolicy } from './store';

// ── managed policies ─────────────────────────────────────────────────────

export interface ManagedPolicyView {
  id: string;
  name: string;
  description: string;
  /** i18n keys of the same texts (`iamApi.managed.<slug>.name|description`). */
  nameKey: string;
  descriptionKey: string;
  group: 'rbac' | 'boundary' | 'portal';
  effect: 'permit' | 'forbid';
  cedar: string;
}

const MANAGED_TEXT: Record<string, { name: string; description: string }> = {
  'managed:rbac:user-read': {
    name: 'Members can view what their access allows',
    description: 'A member may view a service when their role, their own permissions or the permissions of their groups give them at least view access to it.',
  },
  'managed:rbac:user-write': {
    name: 'Members can change what their access allows',
    description: 'A member may create, edit or delete in a service when their access to it is at least "write". Administration services (members, providers, configuration, ...) additionally require "admin".',
  },
  'managed:rbac:user-admin': {
    name: 'Members can administer what their access allows',
    description: 'A member may administer a service when their access to it is "admin".',
  },
  'managed:rbac:token-read': {
    name: 'API tokens view what their owner and their scope allow',
    description: 'An API token may view a service when its owner can and the token\'s own scope (if it has one) includes it. A token never has more access than its owner.',
  },
  'managed:rbac:token-write': {
    name: 'API tokens change what their owner and their scope allow',
    description: 'An API token may change things in a service when its owner can and the token\'s scope (if it has one) allows it. Administration services need "admin" on both.',
  },
  'managed:rbac:token-admin': {
    name: 'API tokens administer what their owner and their scope allow',
    description: 'An API token may administer a service when its owner can and the token\'s scope (if it has one) allows it.',
  },
  'managed:boundary:token-cap-read': {
    name: 'Token scope limit (view)',
    description: 'An API token with a scope can never view a service outside that scope, whatever a custom policy says.',
  },
  'managed:boundary:token-cap-write': {
    name: 'Token scope limit (change)',
    description: 'An API token with a scope can never change a service outside that scope, whatever a custom policy says.',
  },
  'managed:boundary:token-cap-admin': {
    name: 'Token scope limit (administer)',
    description: 'An API token with a scope can never administer a service outside that scope, whatever a custom policy says.',
  },
  'managed:boundary:project-read': {
    name: 'Project limit (view)',
    description: 'When the active project\'s own permissions deny viewing a service, no custom policy can grant it. Project permissions only ever narrow workspace access.',
  },
  'managed:boundary:project-write': {
    name: 'Project limit (change)',
    description: 'When the active project\'s own permissions deny changing a service, no custom policy can grant it. Project permissions only ever narrow workspace access.',
  },
  'managed:boundary:project-admin': {
    name: 'Project limit (administer)',
    description: 'When the active project\'s own permissions deny administering a service, no custom policy can grant it. Project permissions only ever narrow workspace access.',
  },
  'managed:portal:use': {
    name: 'People on a portal\'s access list can open it',
    description: 'A person may open a portal when its access list names them or one of their groups, or when the portal is open to everyone in the workspace. The list is edited on the portal; no rule is stored per portal.',
  },
  'managed:portal:use-boundary': {
    name: 'Only the access list opens a portal',
    description: 'Nobody can open a portal that its access list does not admit, whatever their role or any allow rule says. Deny rules can still block people who are on the list.',
  },
  'managed:portal:agent': {
    name: 'People on a portal\'s access list can run its agents',
    description: 'In a portal, a person may run the agents it offers when the portal\'s access list admits them. Deny rules can still block a person, a group or a single agent.',
  },
  'managed:portal:agent-boundary': {
    name: 'Only the access list runs agents in a portal',
    description: 'In a portal, nobody can run an agent unless the portal\'s access list admits them, whatever their role or any allow rule says.',
  },
};

const slugOf = (id: string): string => id.replace(/^managed:/, '').replace(/[^A-Za-z0-9]+/g, '-');

/** Plain-language name / description / effect of a managed Cedar id (a safe fallback for an unknown one). */
export function describeManagedPolicy(id: string): ManagedPolicyView {
  const info = listManagedPolicies().find((p) => p.id === id);
  const text = MANAGED_TEXT[id];
  return {
    id,
    name: text?.name ?? id,
    description: text?.description ?? '',
    nameKey: `iamApi.managed.${slugOf(id)}.name`,
    descriptionKey: `iamApi.managed.${slugOf(id)}.description`,
    group: info?.group ?? 'rbac',
    effect: info?.effect ?? 'permit',
    cedar: info?.cedar ?? '',
  };
}

export function listManagedPolicyViews(): ManagedPolicyView[] {
  return listManagedPolicies().map((p) => describeManagedPolicy(p.id));
}

// ── Cedar statements ─────────────────────────────────────────────────────

export type PolicyEffectSummary = 'permit' | 'forbid' | 'mixed';

interface StatementInfo {
  effect: 'permit' | 'forbid';
  principal: { op: string; entity?: { type: string; id: string }; entityType?: string } | null;
}

const statementCache = new Map<string, StatementInfo[]>();
const STATEMENT_CACHE_MAX = 1_000;
/** Longer texts are parsed each time rather than kept as cache keys. */
const STATEMENT_CACHE_MAX_TEXT = 8 * 1024;

/** Effect and principal scope of every statement of a policy text (empty when it does not parse). */
export function statementInfos(cedar: string): StatementInfo[] {
  const hit = statementCache.get(cedar);
  if (hit) return hit;
  const parts = splitPolicyText(cedar);
  const infos: StatementInfo[] = [];
  if (parts.ok) {
    for (const statement of parts.policies) {
      const json = policyToJson(statement);
      if (!json.ok) continue;
      const principal = (json.json as unknown as { principal?: Record<string, unknown> }).principal ?? null;
      const entity = principal && typeof principal.entity === 'object' && principal.entity
        ? principal.entity as { type: string; id: string }
        : undefined;
      infos.push({
        effect: json.json.effect === 'forbid' ? 'forbid' : 'permit',
        principal: principal
          ? { op: String(principal.op ?? 'All'), entity, entityType: typeof principal.entity_type === 'string' ? principal.entity_type : undefined }
          : null,
      });
    }
  }
  if (cedar.length <= STATEMENT_CACHE_MAX_TEXT) {
    if (statementCache.size >= STATEMENT_CACHE_MAX) statementCache.clear();
    statementCache.set(cedar, infos);
  }
  return infos;
}

export function summarizeEffect(cedar: string): { effect: PolicyEffectSummary; statementCount: number } {
  const infos = statementInfos(cedar);
  const permits = infos.filter((i) => i.effect === 'permit').length;
  const forbids = infos.length - permits;
  const effect: PolicyEffectSummary = forbids === 0 ? 'permit' : permits === 0 ? 'forbid' : 'mixed';
  // A text that does not parse still counts the statements the splitter saw (none); report 0.
  return { effect: infos.length === 0 ? 'permit' : effect, statementCount: infos.length };
}

// ── rows ─────────────────────────────────────────────────────────────────

export interface PolicyRow {
  policyId: string;
  name: string;
  description: string;
  effect: PolicyEffectSummary;
  /** A policy is either enabled (it takes part in decisions) or disabled. */
  enabled: boolean;
  spec: PolicySpec | null;
  cedar: string;
  statementCount: number;
  createdAt: string;
  updatedAt: string;
  /** Id of the user who last saved the policy. */
  updatedBy: string;
  /** Their name or email when they still exist, else the id. */
  updatedByLabel: string;
  /** Only in a list filtered by a resource (see `policiesReaching`): `this` names it, `all` applies to every resource of its kind. */
  scope?: 'this' | 'all';
}

export function toPolicyRow(
  policy: IIamPolicy,
  labels?: ReadonlyMap<string, string>,
): PolicyRow {
  const { effect, statementCount } = summarizeEffect(policy.cedar);
  return {
    policyId: policy.policyId,
    name: policy.name,
    description: policy.description ?? '',
    effect,
    enabled: policy.enabled,
    spec: policy.spec ?? null,
    cedar: policy.cedar,
    statementCount,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    updatedBy: policy.updatedBy,
    updatedByLabel: labels?.get(policy.updatedBy) ?? policy.updatedBy,
  };
}

/** Rows for a list of policies, with the editor names of the tenant attached. */
export async function toPolicyRows(
  tenant: { tenantDbName: string; tenantId: string },
  policies: IIamPolicy[],
): Promise<PolicyRow[]> {
  let labels: Map<string, string> | undefined;
  try {
    labels = (await resolvePrincipalLabels(tenant, { users: policies.map((p) => p.updatedBy).filter(Boolean) })).users;
  } catch {
    labels = undefined;
  }
  return policies.map((p) => toPolicyRow(p, labels));
}

// ── who a policy mentions ────────────────────────────────────────────────

export interface PolicyReferences {
  users: Set<string>;
  groups: Set<string>;
  tokens: Set<string>;
  /** Applies to every principal. */
  any: boolean;
  anyUser: boolean;
  anyToken: boolean;
}

const ENTITY_RE = /\b(User|Group|ApiToken)::"((?:[^"\\]|\\.)*)"/g;

const unescape = (s: string): string => s.replace(/\\(.)/g, '$1');

/**
 * The principals a policy mentions. A spec is exact. Raw Cedar is read from its
 * statements' principal scope plus every `User::"x"` / `Group::"x"` /
 * `ApiToken::"x"` literal in the text - good enough to answer "which policies
 * touch this person" without evaluating anything.
 */
export function policyReferences(policy: Pick<IIamPolicy, 'cedar' | 'spec'>): PolicyReferences {
  const refs: PolicyReferences = { users: new Set(), groups: new Set(), tokens: new Set(), any: false, anyUser: false, anyToken: false };
  const spec = policy.spec;
  if (spec) {
    const p = spec.principals;
    if ('any' in p && p.any === true) refs.any = true;
    else {
      const sel = p as { users?: string[]; groups?: string[]; tokens?: string[]; anyUser?: boolean; anyToken?: boolean };
      sel.users?.forEach((id) => refs.users.add(id));
      sel.groups?.forEach((id) => refs.groups.add(id));
      sel.tokens?.forEach((id) => refs.tokens.add(id));
      refs.anyUser = sel.anyUser === true;
      refs.anyToken = sel.anyToken === true;
    }
    return refs;
  }

  for (const info of statementInfos(policy.cedar)) {
    const scope = info.principal;
    if (!scope || scope.op === 'All') refs.any = true;
    else if (scope.op === 'is' && scope.entityType === 'User') refs.anyUser = true;
    else if (scope.op === 'is' && scope.entityType === 'ApiToken') refs.anyToken = true;
  }
  for (const match of policy.cedar.matchAll(ENTITY_RE)) {
    const id = unescape(match[2]);
    if (match[1] === 'User') refs.users.add(id);
    else if (match[1] === 'Group') refs.groups.add(id);
    else refs.tokens.add(id);
  }
  return refs;
}

/** How many custom policies mention each principal directly (`user:<id>` / `group:<id>` / `token:<id>`). */
export function countDirectReferences(policies: ReadonlyArray<Pick<IIamPolicy, 'cedar' | 'spec'>>): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const policy of policies) {
    const refs = policyReferences(policy);
    refs.users.forEach((id) => bump(`user:${id}`));
    refs.groups.forEach((id) => bump(`group:${id}`));
    refs.tokens.forEach((id) => bump(`token:${id}`));
  }
  return counts;
}

// ── which policies concern one resource ──────────────────────────────────

/**
 * How a custom policy concerns one resource: `this` (it names that very resource),
 * `all` (it applies to every resource of the kind), or null (it does not reach it).
 * Used to answer "which policies also apply to this portal" without evaluating
 * anything. Only portals are judged for now: a policy reaches a portal through
 * `portal.use` (opening it), `agent.invoke` (running its agents) or the Read / Write
 * levels that contain them, in the portal channel. A spec is exact; raw Cedar is
 * read best-effort from the entity literals and action names in its text.
 */
export function policyReach(
  policy: Pick<IIamPolicy, 'cedar' | 'spec'>,
  resource: { type: string; id: string },
): 'this' | 'all' | null {
  if (resource.type !== 'portal') return null;
  const spec = policy.spec;
  if (spec) {
    const portalActions = spec.actions.filter((a) => a === 'portal.use' || a === 'agent.invoke' || a === 'Read' || a === 'Write');
    if (portalActions.length === 0) return null;
    const channels = spec.conditions?.channels;
    if (channels && channels.length > 0 && !channels.includes('portal')) return null;
    if ('any' in spec.resources && spec.resources.any === true) return 'all';
    const sel = spec.resources as { services?: string[]; resources?: Array<{ type: string; id: string }> };
    if (sel.resources?.some((r) => r.type === 'portal' && r.id === resource.id)) return 'this';
    if (sel.services?.some((service) => service === 'portals' || service === 'agents')) return 'all';
    return null;
  }
  const text = policy.cedar;
  const literal = [...text.matchAll(/\bPortal::"((?:[^"\\]|\\.)*)"/g)].map((m) => unescape(m[1]));
  if (literal.includes(resource.id)) return 'this';
  if (literal.length > 0) return null;
  return /\bAction::"(?:portal\.use|agent\.invoke|Read|Write)"|\bresource is Portal\b/.test(text) ? 'all' : null;
}

/**
 * The policies that concern one resource, each with how (see `policyReach`), in the
 * order given. The portal page lists them next to the portal's access list.
 */
export function policiesReaching<T extends Pick<IIamPolicy, 'cedar' | 'spec'>>(
  policies: readonly T[],
  resource: { type: string; id: string },
): Array<{ policy: T; scope: 'this' | 'all' }> {
  const out: Array<{ policy: T; scope: 'this' | 'all' }> = [];
  for (const policy of policies) {
    const scope = policyReach(policy, resource);
    if (scope) out.push({ policy, scope });
  }
  return out;
}
