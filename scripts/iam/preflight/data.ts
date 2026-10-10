/**
 * The stored data the report reads, as plain structural types (the runner maps
 * database rows into them) so the pure parts - census, access, oracle - never
 * import the database layer.
 */

import type { UserServicePermissions } from '@/lib/security/rbac';
import type { AssignmentRow } from './oracle';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  /** false = a programmatic account (tokens only). */
  canLogin?: boolean;
  status?: string;
  servicePermissions?: UserServicePermissions | null;
  projectIds?: readonly string[];
}

export interface ProjectRow {
  id: string;
  key: string;
  name: string;
}

export interface GroupRow {
  id: string;
  name: string;
  source?: string;
  tenantRole?: string;
  servicePermissions?: UserServicePermissions | null;
}

export interface TokenRow {
  id: string;
  label: string;
  userId: string;
  projectId?: string | null;
  /** null / undefined = unscoped. */
  servicePermissions?: UserServicePermissions | null;
  createdAt?: Date | string | null;
  expiresAt?: Date | string | null;
}

export interface TenantData {
  users: readonly UserRow[];
  projects: readonly ProjectRow[];
  groups: readonly GroupRow[];
  /** group ids by user id, in membership order. */
  groupIdsByUser: ReadonlyMap<string, readonly string[]>;
  /** A person's own project assignments, by user id. */
  userProjects: ReadonlyMap<string, readonly AssignmentRow[]>;
  /** A group's project assignments, by group id. */
  groupProjects: ReadonlyMap<string, readonly AssignmentRow[]>;
  tokens: readonly TokenRow[];
  defaultProjectId: string | null;
}

export const isPrivilegedRole = (role: string | undefined): boolean => role === 'owner' || role === 'admin';
