/**
 * Shared resources that carry an ACCESS LIST (`IResourceAccessList`): who may USE them in an agent run.
 *
 * Pure data with no imports, so the action catalog (actions.ts), the Cedar schema (schema.ts) and the managed
 * policies (managedPolicies.ts) read one list without importing each other. A new shareable resource (an agent
 * shared inside the company, say) is added here with its `<type>.use` action; the schema gives its entity the
 * three access-list attributes and the managed `access` rules decide it, with no further wiring in the engine.
 */

export const ACCESS_LIST_RESOURCES = Object.freeze({
  /** The tools of an MCP server, bound to an agent. */
  'mcp-server': { service: 'mcp', action: 'mcp-server.use' },
  /** A skill of the project's library, given to an agent. */
  skill: { service: 'agents', action: 'skill.use' },
} as const);

export type AccessListResourceType = keyof typeof ACCESS_LIST_RESOURCES;

export const ACCESS_LIST_RESOURCE_TYPES = Object.freeze(Object.keys(ACCESS_LIST_RESOURCES)) as readonly AccessListResourceType[];

export type AccessListAction = (typeof ACCESS_LIST_RESOURCES)[AccessListResourceType]['action'];

export const ACCESS_LIST_ACTIONS = Object.freeze(
  ACCESS_LIST_RESOURCE_TYPES.map((type) => ACCESS_LIST_RESOURCES[type].action),
) as readonly AccessListAction[];

export function isAccessListAction(value: unknown): value is AccessListAction {
  return typeof value === 'string' && (ACCESS_LIST_ACTIONS as readonly string[]).includes(value);
}
