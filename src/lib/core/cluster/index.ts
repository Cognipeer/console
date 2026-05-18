/**
 * Cluster Module — public entry point.
 *
 * The cluster module gives a process its identity (NODE_NAME + NODE_ROLE),
 * tracks all running nodes in the shared DB, and lets the admin assign
 * individual instances (agents, MCP servers, browsers, ...) to specific
 * nodes.
 *
 * All exports here are safe to call from any node. Calls reduce to a
 * single-row table on a single-node deployment — zero behavioural change
 * versus the pre-cluster code path.
 */

export * from './types';
export {
  getThisNodeName,
  getThisNodeRole,
  registerThisNode,
  deregisterThisNode,
  listClusterNodes,
  findClusterNode,
  resetNodeRegistryForTests,
} from './nodeRegistry';
export {
  findInstanceAssignment,
  resolveInstancePlacement,
  setInstanceAssignment,
  deleteInstanceAssignment,
  listInstanceAssignments,
  clearInstanceAssignmentCache,
} from './instanceAssignmentStore';
export {
  resolveDefaultNodeName,
  clearDefaultNodeCache,
} from './defaultNode';
export {
  routeInstanceCall,
  queueNameFor,
  type RouteContext,
  type RouteOptions,
} from './serviceRouter';
