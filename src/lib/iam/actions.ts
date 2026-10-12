/**
 * Action Catalog.
 *
 * Three kinds of Cedar actions, all registered in the schema:
 *
 *  1. LEVEL GROUPS  `Read`, `Write`, `Admin` — pure groups (no appliesTo). The
 *     managed RBAC policies are written against these (`action in
 *     Action::"Write"`), so any action placed in a group is governed by the
 *     principal's service level without a per-action policy.
 *
 *  2. SERVICE ACTIONS  `<service>.read|write|admin` for EVERY PermissionService
 *     (resource: `Service::"<id>"`). The HTTP gate uses these: GET/HEAD/OPTIONS
 *     -> `<svc>.read`, any other verb -> `<svc>.write`. The "adminService needs
 *     admin for mutations" rule is NOT encoded here but in the managed Write
 *     policy via `resource.adminService` — exactly like getRequiredPermissionLevel.
 *     `<svc>.admin` exists for explicit admin-level checks and for custom policies.
 *
 *  3. RESOURCE ACTIONS  `<type>.<verb>` derived from the resource registry
 *     (`get|list` in Read, `create|update|delete` in Write) plus the execution
 *     verbs `agent.invoke`, `tool.execute`, `mcp-server.call`, `rag-module.query`,
 *     `model.infer` (Write: they are POSTs at the gate), `portal.use` (Read) and the
 *     session verbs of an agent: `agent.approve` (Write: answer somebody's pending
 *     approval or question), `agent.session_view_others` (Read) and
 *     `agent.session_manage_others` (Write: look at / act on a session somebody else
 *     started). `portal.use` and `agent.invoke` are decided by the portal runtime, the
 *     session verbs by the agent routes (RUNTIME_ENFORCED_ACTIONS); the rest are
 *     evaluated by the Access check only.
 *
 * Pure data + pure functions: no Cedar, no database. UIs import `describeActions`
 * / `ACTION_LEVEL_GROUPS` for labels and grouping.
 */

import { RBAC_SERVICE_DEFINITIONS, type PermissionService } from '@/lib/security/rbac';
import type { IamChannel } from './context';

export type ActionLevel = 'read' | 'write' | 'admin';
export type ActionLevelGroup = 'Read' | 'Write' | 'Admin';
export type ActionKind = 'group' | 'service' | 'resource';

export const ACTION_LEVEL_GROUPS: readonly ActionLevelGroup[] = ['Read', 'Write', 'Admin'];

export const LEVEL_TO_GROUP: Record<ActionLevel, ActionLevelGroup> = {
  read: 'Read',
  write: 'Write',
  admin: 'Admin',
};

export interface ActionDefinition {
  /** Cedar action id, used as `Action::"<id>"`. */
  id: string;
  kind: ActionKind;
  level: ActionLevel;
  /** The level group the action belongs to (`null` for the groups themselves). */
  group: ActionLevelGroup | null;
  /** i18n key for the label; `labelParams` are its interpolation values. */
  labelKey: string;
  labelParams: Record<string, string>;
  /** Owning RBAC service (service + resource actions). */
  service?: PermissionService;
  /** Registry resource type (resource actions). */
  resourceType?: string;
  /** Verb part of a resource action (get, list, invoke...). */
  verb?: string;
  /** Cedar resource entity types this action applies to. */
  resourceEntityTypes: string[];
}

/** Minimal view of a registry type the catalog needs. */
export interface CatalogResourceType {
  /** Registry type id (e.g. `rag-module`). */
  type: string;
  service: PermissionService;
}

// ── verbs ────────────────────────────────────────────────────────────────

export const RESOURCE_CRUD_VERBS: ReadonlyArray<{ verb: string; level: ActionLevel }> = [
  { verb: 'get', level: 'read' },
  { verb: 'list', level: 'read' },
  { verb: 'create', level: 'write' },
  { verb: 'update', level: 'write' },
  { verb: 'delete', level: 'write' },
];

/** Execution verbs bound to one specific resource type. */
export const RESOURCE_EXTRA_VERBS: ReadonlyArray<{ type: string; verb: string; level: ActionLevel }> = [
  { type: 'agent', verb: 'invoke', level: 'write' },
  // Session verbs. A session is the conversation of one person with an agent; these decide what
  // somebody ELSE may do with it. They sit in the Read / Write groups, so by default every
  // `agents` reader / writer holds them (today's behaviour) and a deny rule narrows them.
  { type: 'agent', verb: 'approve', level: 'write' },
  { type: 'agent', verb: 'session_view_others', level: 'read' },
  { type: 'agent', verb: 'session_manage_others', level: 'write' },
  { type: 'tool', verb: 'execute', level: 'write' },
  { type: 'mcp-server', verb: 'call', level: 'write' },
  { type: 'rag-module', verb: 'query', level: 'write' },
  { type: 'model', verb: 'infer', level: 'write' },
  { type: 'portal', verb: 'use', level: 'read' },
];

/**
 * Resource actions that something other than the HTTP gates decides, and the
 * channels they are decided in. Opening a portal and running an agent through one
 * are asked by the portal runtime (enterprise overlay) with `channel: 'portal'`
 * (resourceAuthz.ts). Answering a pending approval is asked by the agent routes
 * (dashboard, API) and by the portal runtime; looking at / acting on a session
 * somebody else started is asked by the agent routes; choosing the bucket an agent
 * keeps its session files in asks the bucket's own actions (`file-bucket.get` to list it
 * as a choice, `file-bucket.update` to name it - saving an agent's Files settings).
 * Every other resource action is evaluated by the Access check only: no request of the
 * product asks for it yet.
 *
 * Pure data; whether the runtime exists in THIS build is runtimeEnforced.ts: the
 * `portal` channel exists only where the enterprise overlay registered its resolver,
 * the other channels always. A policy rule about these actions is accepted (and said
 * to take effect) only where it does.
 */
export const RUNTIME_ENFORCED_ACTIONS: Readonly<Record<string, readonly IamChannel[]>> = Object.freeze({
  'portal.use': ['portal'],
  'agent.invoke': ['portal'],
  'agent.approve': ['dashboard', 'api', 'portal'],
  'agent.session_view_others': ['dashboard', 'api'],
  'agent.session_manage_others': ['dashboard', 'api'],
  // Where an agent keeps its session files is a Files decision about THAT bucket (agents routes ask it).
  'file-bucket.get': ['dashboard', 'api'],
  'file-bucket.update': ['dashboard', 'api'],
});

/** The Document Store bucket actions the agents routes ask about: choosing (listing) a bucket, and naming it in an agent's settings. */
export const BUCKET_RESOURCE_ACTIONS: readonly string[] = Object.freeze(['file-bucket.get', 'file-bucket.update']);

/**
 * The actions an agent is asked about with the SESSION it concerns: who started it
 * (`owners`) and, for an approval, whose answer the agent accepts (`approvers`).
 * Their resource carries those two attributes (agentEntities.ts).
 */
export const SESSION_RESOURCE_ACTIONS: readonly string[] = Object.freeze([
  'agent.approve',
  'agent.session_view_others',
  'agent.session_manage_others',
]);

export function isSessionResourceAction(id: string): boolean {
  return SESSION_RESOURCE_ACTIONS.includes(id);
}

/**
 * Types the schema and the catalog always carry, whatever the resource registry
 * holds (and with the service given here, even when the registry says otherwise).
 *
 *  - `portal` has no inventory provider in this edition: the enterprise overlay
 *    contributes the registry entry, and its access list is not part of it.
 *  - `agent` is a core type. The managed portal policies (managedPolicies.ts) are
 *    written against `Agent`, so the managed set must validate against the schema
 *    even if the registry has not registered its types yet.
 */
export const EXTRA_RESOURCE_TYPES: ReadonlyArray<CatalogResourceType> = [
  { type: 'portal', service: 'portals' },
  { type: 'agent', service: 'agents' },
];

// ── naming ───────────────────────────────────────────────────────────────

const RESERVED_ENTITY_NAMES = new Set(['Tenant', 'Project', 'Group', 'User', 'ApiToken', 'Service', 'Action']);

/** Registry type id -> Cedar entity type name (`rag-module` -> `RagModule`). */
export function resourceEntityTypeName(type: string): string {
  const pascal = type
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const name = /^[A-Za-z]/.test(pascal) ? pascal : `T${pascal}`;
  return RESERVED_ENTITY_NAMES.has(name) ? `${name}Resource` : name;
}

export function serviceActionId(service: string, level: ActionLevel): string {
  return `${service}.${level}`;
}

export function resourceActionId(type: string, verb: string): string {
  return `${type}.${verb}`;
}

/**
 * Service levels ADD UP, the way an effective level is read (effective.ts: `admin` counts only when `write` and `read`
 * are allowed too): Admin includes Write and Read, Write includes Read. The level groups (`Read`, `Write`, `Admin`) and
 * the service actions (`<service>.read|write|admin`) are separate Cedar actions, so the engine does not add them up
 * by itself - an ALLOW rule that names only `webhooks.admin` would let nobody read a webhook. The policy compiler
 * (policySpec.ts) therefore adds the lower levels to every allow rule; a deny rule keeps naming exactly what it blocks.
 */
const LOWER_LEVELS: Readonly<Record<ActionLevel, readonly ActionLevel[]>> = Object.freeze({
  read: [],
  write: ['read'],
  admin: ['write', 'read'],
});

/** The ids an allow rule that names `def` also covers: the lower levels of the same group or service (none for Read, and for resource actions). */
export function impliedLevelActionIds(def: { kind: ActionKind; level: ActionLevel; service?: string }): string[] {
  if (def.kind === 'group') return LOWER_LEVELS[def.level].map((level) => LEVEL_TO_GROUP[level]);
  if (def.kind === 'service' && def.service) return LOWER_LEVELS[def.level].map((level) => serviceActionId(def.service as string, level));
  return [];
}

/** HTTP method -> service-level action level (mirrors getRequiredPermissionLevel's read/write split). */
export function methodToActionLevel(method: string): 'read' | 'write' {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'read' : 'write';
}

/** The action the HTTP gate checks for `(service, method)`. */
export function gateActionId(service: PermissionService | string, method: string): string {
  return serviceActionId(service, methodToActionLevel(method));
}

// ── catalog ──────────────────────────────────────────────────────────────

/**
 * Merge registry types with the always-present extras (deduplicated by type id).
 * Registry order is kept; for a type both name, the EXTRA entry's service wins, so
 * the catalog never depends on how a registry happens to file the type.
 */
export function withExtraResourceTypes(types: ReadonlyArray<CatalogResourceType>): CatalogResourceType[] {
  const extras = new Map(EXTRA_RESOURCE_TYPES.map((t) => [t.type, t]));
  const seen = new Set<string>();
  const out: CatalogResourceType[] = [];
  for (const t of [...types, ...EXTRA_RESOURCE_TYPES]) {
    if (seen.has(t.type)) continue;
    seen.add(t.type);
    const winner = extras.get(t.type) ?? t;
    out.push({ type: winner.type, service: winner.service });
  }
  return out;
}

export function buildActionCatalog(resourceTypes: ReadonlyArray<CatalogResourceType>): ActionDefinition[] {
  const catalog: ActionDefinition[] = [];

  for (const group of ACTION_LEVEL_GROUPS) {
    catalog.push({
      id: group,
      kind: 'group',
      level: group.toLowerCase() as ActionLevel,
      group: null,
      labelKey: `iam.action.group.${group.toLowerCase()}`,
      labelParams: {},
      resourceEntityTypes: [],
    });
  }

  for (const def of RBAC_SERVICE_DEFINITIONS) {
    for (const level of ['read', 'write', 'admin'] as const) {
      catalog.push({
        id: serviceActionId(def.id, level),
        kind: 'service',
        level,
        group: LEVEL_TO_GROUP[level],
        labelKey: `iam.action.service.${level}`,
        labelParams: { service: def.id },
        service: def.id,
        resourceEntityTypes: ['Service'],
      });
    }
  }

  const types = withExtraResourceTypes(resourceTypes);
  for (const { type, service } of types) {
    const entityType = resourceEntityTypeName(type);
    for (const { verb, level } of RESOURCE_CRUD_VERBS) {
      catalog.push({
        id: resourceActionId(type, verb),
        kind: 'resource',
        level,
        group: LEVEL_TO_GROUP[level],
        labelKey: `iam.action.verb.${verb}`,
        labelParams: { type },
        service,
        resourceType: type,
        verb,
        resourceEntityTypes: [entityType],
      });
    }
  }
  const typeIds = new Set(types.map((t) => t.type));
  for (const { type, verb, level } of RESOURCE_EXTRA_VERBS) {
    if (!typeIds.has(type)) continue;
    const owner = types.find((t) => t.type === type)!;
    catalog.push({
      id: resourceActionId(type, verb),
      kind: 'resource',
      level,
      group: LEVEL_TO_GROUP[level],
      labelKey: `iam.action.verb.${verb}`,
      labelParams: { type },
      service: owner.service,
      resourceType: type,
      verb,
      resourceEntityTypes: [resourceEntityTypeName(type)],
    });
  }
  return catalog;
}

/** Fast lookups over a catalog. */
export function indexCatalog(catalog: ReadonlyArray<ActionDefinition>): Map<string, ActionDefinition> {
  return new Map(catalog.map((a) => [a.id, a]));
}

/**
 * UI metadata: actions grouped by level group, each with label key/params.
 * Stable ordering: group order, then service actions in RBAC definition order,
 * then resource actions in type order.
 */
export function describeActions(catalog: ReadonlyArray<ActionDefinition>): Array<{
  group: ActionLevelGroup;
  actions: ActionDefinition[];
}> {
  return ACTION_LEVEL_GROUPS.map((group) => ({
    group,
    actions: catalog.filter((a) => a.group === group),
  }));
}
