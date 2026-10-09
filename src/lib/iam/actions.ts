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
 *     `model.infer` (Write: they are POSTs at the gate) and `portal.use` (Read).
 *     Used from C3 on; defined now so policies written today stay valid.
 *
 * Pure data + pure functions: no Cedar, no database. UIs import `describeActions`
 * / `ACTION_LEVEL_GROUPS` for labels and grouping.
 */

import { RBAC_SERVICE_DEFINITIONS, type PermissionService } from '@/lib/security/rbac';

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
  { type: 'tool', verb: 'execute', level: 'write' },
  { type: 'mcp-server', verb: 'call', level: 'write' },
  { type: 'rag-module', verb: 'query', level: 'write' },
  { type: 'model', verb: 'infer', level: 'write' },
  { type: 'portal', verb: 'use', level: 'read' },
];

/**
 * Types that exist in the product but are not (yet) in the resource registry
 * because they have no inventory provider. They are still real authorization
 * resources, so the schema and catalog always carry them.
 */
export const EXTRA_RESOURCE_TYPES: ReadonlyArray<CatalogResourceType> = [
  { type: 'portal', service: 'portals' },
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

/** Merge registry types with the always-present extras (deduplicated by type id). */
export function withExtraResourceTypes(types: ReadonlyArray<CatalogResourceType>): CatalogResourceType[] {
  const seen = new Set<string>();
  const out: CatalogResourceType[] = [];
  for (const t of [...types, ...EXTRA_RESOURCE_TYPES]) {
    if (seen.has(t.type)) continue;
    seen.add(t.type);
    out.push({ type: t.type, service: t.service });
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
