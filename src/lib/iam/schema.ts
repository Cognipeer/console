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
 *   Report   in [Project, ReportGroup] { ... }       // a report (enterprise), under its group (reportEntities.ts)
 *   Portal   in [Project] { ..., mode?, allowedUsers?: Set<User>, allowedGroups?: Set<Group>,
 *                           embedAccess?: String, networkMode?: String, net0 ... net31?: ipaddr }
 *   ChannelDeployment in [Project] { ..., mode?, allowedUsers?: Set<User>, allowedGroups?: Set<Group> }
 *   Agent    in [Project, Portal, ChannelDeployment] { ..., portal?: Portal, channelDeployment?: ChannelDeployment,
 *                                                        approvers?: String, owners?: Set<User> }
 *   McpServer, Skill in [Project] { ..., mode?, allowedUsers?: Set<User>, allowedGroups?: Set<Group> }
 *            the access list of a shared resource (accessListCatalog.ts): who may use it in an agent run
 *
 * `owners` and `approvers` describe the SESSION an agent is asked about (agentEntities.ts): the
 * people who started it, and whose answer the agent accepts for a pending approval. The managed
 * agent rules (managedPolicies.ts) and the session actions read them.
 *
 * The portal's access list is part of the Portal entity (mode / allowedUsers /
 * allowedGroups, built by portalEntities.ts), so the managed portal policies
 * (managedPolicies.ts) can read it and nothing is stored per portal. An Agent that
 * is run through a portal is `in` that portal and names it in `portal`. A deployment of an agent
 * on a Slack / Teams connection carries the same three attributes (messagingEntities.ts); an Agent
 * run through one is `in` it and names it in `channelDeployment`.
 *
 * `readSvcs/writeSvcs/adminSvcs` are the services where the principal's
 * EFFECTIVE level (role default, user override, group grants — computed by the
 * real rbac.ts functions in entities.ts) is >= read / >= write / == admin.
 * They are upward-closed, which is what lets six small managed policies express
 * the whole role-based decision.
 *
 * `projDenyRead/Write/Admin` are the services the ACTIVE project's explicit
 * settings deny at that level (project narrowing, see projectNarrowing.ts). The
 * level sets above already reflect the narrowing; these exist so the managed
 * boundary forbids can stop a CUSTOM permit from granting what the project
 * narrows away. Empty when the request has no narrowing project.
 *
 * `embedAccess` ('access_list' | 'any_verified') and `networkMode` ('any' | 'allow_list') plus the
 * numbered ranges `net0` ... `net31` are the portal's embed-access and network-boundary settings
 * (portalEntities.ts, portalNetworks.ts); the managed portal rules read them.
 *
 * Request context (all optional): projectId, channel, ip (ipaddr), now
 * (datetime), method, path, embedded (Boolean: reached through an embed with a host-verified
 * identity), test (Boolean: a test session of a portal).
 */

import {
  buildActionCatalog,
  resourceEntityTypeName,
  type ActionDefinition,
  type CatalogResourceType,
} from './actions';
import type { CedarSchemaJson } from './cedar';
import { PORTAL_NETWORK_SLOTS } from './portalNetworks';
import { ACCESS_LIST_RESOURCE_TYPES } from './accessListCatalog';
import { REPORT_GROUP_ENTITY, REPORT_GROUP_RESOURCE_TYPE, REPORT_RESOURCE_TYPE } from './reportEntities';

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
export const IAM_CONTEXT_ATTRS = ['projectId', 'channel', 'ip', 'now', 'method', 'path', 'embedded', 'test'] as const;

const IAM_CONTEXT_EXTENSION_TYPES: Readonly<Record<string, string>> = { ip: 'ipaddr', now: 'datetime' };
/** Context attributes that are flags (Cedar Boolean). */
const IAM_CONTEXT_BOOLEANS: ReadonlySet<string> = new Set(['embedded', 'test']);

const extension = (name: string): TypeJson => ({ type: 'Extension', name });

const contextType = (): TypeJson =>
  record(
    Object.fromEntries(
      IAM_CONTEXT_ATTRS.map((name) => [
        name,
        attr(
          IAM_CONTEXT_EXTENSION_TYPES[name]
            ? extension(IAM_CONTEXT_EXTENSION_TYPES[name])
            : IAM_CONTEXT_BOOLEANS.has(name) ? bool() : str(),
          false,
        ),
      ]),
    ),
  );

/**
 * Bumped whenever the generated schema changes in a way the NAMES of its types and
 * actions do not show (the signature below, and so the preparsed copy, follows).
 */
const SCHEMA_REVISION = 6;

type EntityTypeJson = { memberOfTypes?: string[]; shape: { attributes: Record<string, TypeJson> } };

/**
 * What the portal rules need beyond the generic resource shape (see the header).
 * Everything is optional: a Portal entity without an access list simply matches no
 * portal rule and is refused by the managed boundary (managedPolicies.ts).
 */
function applyPortalShape(entityTypes: Record<string, TypeJson>, resourceEntityTypes: Record<string, string>): void {
  const portalName = resourceEntityTypes.portal;
  const portal = portalName ? (entityTypes[portalName] as EntityTypeJson | undefined) : undefined;
  if (!portalName || !portal) return;
  Object.assign(portal.shape.attributes, {
    mode: attr(str(), false),
    allowedUsers: attr(setOf(entity('User')), false),
    allowedGroups: attr(setOf(entity('Group')), false),
    embedAccess: attr(str(), false),
    networkMode: attr(str(), false),
    ...Object.fromEntries(PORTAL_NETWORK_SLOTS.map((name) => [name, attr(extension('ipaddr'), false)])),
  });
  const agentName = resourceEntityTypes.agent;
  const agent = agentName ? (entityTypes[agentName] as EntityTypeJson | undefined) : undefined;
  if (!agent) return;
  agent.memberOfTypes = [...new Set([...(agent.memberOfTypes ?? []), portalName])];
  agent.shape.attributes.portal = attr(entity(portalName), false);
}

/**
 * What the messaging rules need beyond the generic resource shape: the same access list as a Portal's (mode / allowedUsers /
 * allowedGroups; no networks, no embed), and the agent run through a deployment is `in` it and names it in `channelDeployment`.
 * Everything is optional, like the portal's: a deployment without an access list matches no rule and the managed boundary refuses.
 */
function applyMessagingShape(entityTypes: Record<string, TypeJson>, resourceEntityTypes: Record<string, string>): void {
  const deploymentName = resourceEntityTypes['channel-deployment'];
  const deployment = deploymentName ? (entityTypes[deploymentName] as EntityTypeJson | undefined) : undefined;
  if (!deploymentName || !deployment) return;
  Object.assign(deployment.shape.attributes, {
    mode: attr(str(), false),
    allowedUsers: attr(setOf(entity('User')), false),
    allowedGroups: attr(setOf(entity('Group')), false),
  });
  const agentName = resourceEntityTypes.agent;
  const agent = agentName ? (entityTypes[agentName] as EntityTypeJson | undefined) : undefined;
  if (!agent) return;
  agent.memberOfTypes = [...new Set([...(agent.memberOfTypes ?? []), deploymentName])];
  agent.shape.attributes.channelDeployment = attr(entity(deploymentName), false);
}

/**
 * The shared resources that carry an access list (accessListCatalog.ts: an MCP server, a skill) get the same three
 * attributes as a Portal: mode / allowedUsers / allowedGroups. Optional: a record asked about without them matches
 * no `access` rule and the managed boundary refuses its `<type>.use` (accessList.ts always sends them).
 */
function applyAccessListShape(entityTypes: Record<string, TypeJson>, resourceEntityTypes: Record<string, string>): void {
  for (const type of ACCESS_LIST_RESOURCE_TYPES) {
    const name = resourceEntityTypes[type];
    const entityType = name ? (entityTypes[name] as EntityTypeJson | undefined) : undefined;
    if (!entityType) continue;
    Object.assign(entityType.shape.attributes, {
      mode: attr(str(), false),
      allowedUsers: attr(setOf(entity('User')), false),
      allowedGroups: attr(setOf(entity('Group')), false),
    });
  }
}

/**
 * What the session actions need on an Agent (see the header): who started the session and which
 * answerers the agent accepts. Optional, like the portal's: an Agent asked about without them simply
 * matches no rule that reads them.
 */
function applyAgentShape(entityTypes: Record<string, TypeJson>, resourceEntityTypes: Record<string, string>): void {
  const agentName = resourceEntityTypes.agent;
  const agent = agentName ? (entityTypes[agentName] as EntityTypeJson | undefined) : undefined;
  if (!agent) return;
  Object.assign(agent.shape.attributes, {
    approvers: attr(str(), false),
    owners: attr(setOf(entity('User')), false),
  });
}

export interface BuiltSchema {
  schema: CedarSchemaJson;
  /** Stable signature of the inputs; changes iff the schema content changes. */
  signature: string;
  catalog: ActionDefinition[];
  /** Cedar entity type names of the resource types, by registry type id. */
  resourceEntityTypes: Record<string, string>;
}

/**
 * A report sits under its group (`ReportGroup::"usage"`), so a rule can name a whole group - the group's reports of
 * today and of later. The group has no actions of its own (nobody is asked about a group), so it is added here, and
 * mapped as the `report-group` type a policy may name (reportEntities.ts).
 */
function applyReportShape(entityTypes: Record<string, TypeJson>, resourceEntityTypes: Record<string, string>): void {
  const reportName = resourceEntityTypes[REPORT_RESOURCE_TYPE];
  const report = reportName ? (entityTypes[reportName] as EntityTypeJson | undefined) : undefined;
  if (!reportName || !report) return;
  entityTypes[REPORT_GROUP_ENTITY] = { shape: record({}) };
  report.memberOfTypes = [...new Set([...(report.memberOfTypes ?? []), REPORT_GROUP_ENTITY])];
  resourceEntityTypes[REPORT_GROUP_RESOURCE_TYPE] = REPORT_GROUP_ENTITY;
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

  applyPortalShape(entityTypes, resourceEntityTypes);
  applyMessagingShape(entityTypes, resourceEntityTypes);
  applyAgentShape(entityTypes, resourceEntityTypes);
  applyAccessListShape(entityTypes, resourceEntityTypes);
  applyReportShape(entityTypes, resourceEntityTypes);

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
    `rev:${SCHEMA_REVISION}`,
  ].join('|');
  return { schema, signature, catalog, resourceEntityTypes };
}
