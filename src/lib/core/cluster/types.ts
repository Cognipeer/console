/**
 * Cluster module — shared types.
 *
 * Thin re-exports of the DB-layer cluster types so feature code doesn't
 * import directly from the database provider.
 */

export type {
  INodeRecord,
  IInstanceAssignment,
  NodeRole,
  NodeStatus,
  InstanceEntityType,
  InstanceAssignmentMode,
} from '@/lib/database';
