/**
 * Cedar schema (JSON form), generated from the Action Catalog and the resource
 * registry — never hand-maintained, so a new PermissionService or registry type
 * is authorizable (and validatable in custom policies) the moment it exists.
 *
 * Entity model
 * ------------
 *   Tenant
 *   Project  in [Tenant]
 *   Group    in [Group]
 *   User     in [Group] { role, readSvcs, writeSvcs, adminSvcs: Set<String>,
 *                         projDenyRead, projDenyWrite, projDenyAdmin: Set<String>,
 *                         projects, adminProjects: Set<Project> }
 *   ApiToken { owner: User, scoped: Bool, capRead/capWrite/capAdmin: Set<String>, project?: Project }
 *   Service  { service, adminService }            // service-level checks (HTTP gate)
 *   <RegistryType> in [Project] { service, adminService, key?, tags? }
 *
 * `readSvcs/writeSvcs/adminSvcs` are the services where the principal's
 * EFFECTIVE level (role default, user override, group grants — computed by the
 * real rbac.ts functions in entities.ts) is >= read / >= write / == admin.
 * They are upward-closed, which is what lets six small managed policies express
 * the whole legacy decision.
 *
 * `projDenyRead/Write/Admin` are the services the ACTIVE project's explicit
 * settings deny at that level (project narrowing, see projectNarrowing.ts). The
 * level sets above already reflect the narrowing; these exist so the managed
 * boundary forbids can stop a CUSTOM permit from granting what the project
 * narrows away. Empty when the request has no narrowing project.
 *
 * Request context (all optional): projectId, channel, ip (ipaddr), now
 * (datetime), method, path.
 */

import {
  buildActionCatalog,
  resourceEntityTypeName,
  type ActionDefinition,
  type CatalogResourceType,
} from './actions';
import type { CedarSchemaJson } from './cedar';

type TypeJson = Record<string, unknown>;

const str = (): TypeJson => ({ type: 'String' });
const bool = (): TypeJson => ({ type: 'Boolean' });
const setOf = (element: TypeJson): TypeJson => ({ type: 'Set', element });
const entity = (name: string): TypeJson => ({ type: 'Entity', name });
const attr = (type: TypeJson, required = true): TypeJson => ({ ...type, required });
const record = (attributes: Record<string, TypeJson>): TypeJson => ({
  type: 'Record',
  attributes,
});

/**
 * Optional request context attributes a policy may reference. Always optional:
 * a call supplies only what it knows (`context has channel` guards the rest).
 * `ip` is a Cedar `ipaddr` and `now` a Cedar `datetime` (context.ts builds them).
 */
export const IAM_CONTEXT_ATTRS = ['projectId', 'channel', 'ip', 'now', 'method', 'path'] as const;

const IAM_CONTEXT_EXTENSION_TYPES: Readonly<Record<string, string>> = { ip: 'ipaddr', now: 'datetime' };

const extension = (name: string): TypeJson => ({ type: 'Extension', name });

const contextType = (): TypeJson =>
  record(
    Object.fromEntries(
      IAM_CONTEXT_ATTRS.map((name) => [
        name,
        attr(IAM_CONTEXT_EXTENSION_TYPES[name] ? extension(IAM_CONTEXT_EXTENSION_TYPES[name]) : str(), false),
      ]),
    ),
  );

export interface BuiltSchema {
  schema: CedarSchemaJson;
  /** Stable signature of the inputs; changes iff the schema content changes. */
  signature: string;
  catalog: ActionDefinition[];
  /** Cedar entity type names of the resource types, by registry type id. */
  resourceEntityTypes: Record<string, string>;
}

export function buildSchema(resourceTypes: ReadonlyArray<CatalogResourceType>): BuiltSchema {
  const catalog = buildActionCatalog(resourceTypes);
  const entityTypes: Record<string, TypeJson> = {};
  const resourceEntityTypes: Record<string, string> = {};

  entityTypes.Tenant = { shape: record({}) };
  entityTypes.Project = { memberOfTypes: ['Tenant'], shape: record({}) };
  entityTypes.Group = { memberOfTypes: ['Group'], shape: record({}) };
  entityTypes.User = {
    memberOfTypes: ['Group'],
    shape: record({
      role: attr(str()),
      readSvcs: attr(setOf(str())),
      writeSvcs: attr(setOf(str())),
      adminSvcs: attr(setOf(str())),
      projDenyRead: attr(setOf(str())),
      projDenyWrite: attr(setOf(str())),
      projDenyAdmin: attr(setOf(str())),
      projects: attr(setOf(entity('Project'))),
      adminProjects: attr(setOf(entity('Project'))),
    }),
  };
  entityTypes.ApiToken = {
    shape: record({
      owner: attr(entity('User')),
      scoped: attr(bool()),
      capRead: attr(setOf(str())),
      capWrite: attr(setOf(str())),
      capAdmin: attr(setOf(str())),
      project: attr(entity('Project'), false),
    }),
  };
  entityTypes.Service = {
    shape: record({ service: attr(str()), adminService: attr(bool()) }),
  };

  // Resource types: every type from the catalog (registry + extras) is in [Project].
  const seenTypes = new Set<string>();
  for (const action of catalog) {
    if (action.kind !== 'resource' || !action.resourceType) continue;
    if (seenTypes.has(action.resourceType)) continue;
    seenTypes.add(action.resourceType);
    const name = resourceEntityTypeName(action.resourceType);
    resourceEntityTypes[action.resourceType] = name;
    entityTypes[name] = {
      memberOfTypes: ['Project'],
      shape: record({
        service: attr(str()),
        adminService: attr(bool()),
        key: attr(str(), false),
        tags: attr(setOf(str()), false),
      }),
    };
  }

  const actions: Record<string, TypeJson> = {};
  for (const action of catalog) {
    if (action.kind === 'group') {
      actions[action.id] = {};
      continue;
    }
    actions[action.id] = {
      memberOf: [{ id: action.group }],
      appliesTo: {
        principalTypes: ['User', 'ApiToken'],
        resourceTypes: action.resourceEntityTypes,
        context: contextType(),
      },
    };
  }

  const schema = { '': { entityTypes, actions } } as unknown as CedarSchemaJson;
  const signature = [
    ...Object.keys(entityTypes).sort(),
    ...Object.keys(actions).sort(),
  ].join('|');
  return { schema, signature, catalog, resourceEntityTypes };
}
