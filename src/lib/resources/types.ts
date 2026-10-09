/**
 * Resource Registry — shared types.
 *
 * The registry is a READ-ONLY, tenant-scoped inventory over resource types that
 * already exist as their own collections/tables. Nothing here is stored: a
 * `ResourceRecord` is a provider's *mapped* view of a row, and a CRN is computed
 * from (tenant, project, type, id) on demand.
 */
import type { DatabaseProvider } from '@/lib/database';
import type { PermissionService } from '@/lib/security/rbac';

export type ResourceCategory =
  | 'agents'
  | 'knowledge'
  | 'models'
  | 'safety'
  | 'quality'
  | 'operations';

/**
 * Where instances of a type may live:
 *  - 'project'           every row belongs to one project
 *  - 'project-or-tenant' a row may be project-scoped or tenant-wide
 *  - 'tenant'            rows are always tenant-wide
 */
export type ResourceScope = 'project' | 'project-or-tenant' | 'tenant';

export type ResourceStatusTone = 'ok' | 'off' | 'warn' | 'neutral';

export type ResourceAttribute = {
  key: string;
  value: string | number | boolean | null;
};

/**
 * Provider OUTPUT. Built from an explicit whitelist — never a spread of a raw
 * document — so a credential, header, prompt body or config blob can never reach
 * the API by accident.
 */
export interface ResourceRecord {
  type: string;
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  /** null = tenant-wide (providers normalise null/undefined/'' to null). */
  projectId: string | null;
  /**
   * Every project the row is assigned to, for types that can belong to several
   * (providers). `projectId` stays the primary one (CRN/column); the project
   * filter and facets match any of them.
   */
  projectIds?: string[];
  status: string | null;
  statusTone: ResourceStatusTone;
  createdBy: string | null;
  updatedBy: string | null;
  /** ISO strings. */
  createdAt: string | null;
  updatedAt: string | null;
  /** Only when the row carries one; used solely by the service's isolation guard. */
  tenantId?: string | null;
  /** SAFE extra display facts (kind, driver, counts...) — whitelist only. */
  attributes: ResourceAttribute[];
}

export interface ResourceProviderContext {
  db: DatabaseProvider;
  tenantId: string;
  tenantDbName: string;
}

export interface ResourceTypeDefinition {
  /** Stable type id used in CRNs and URLs (e.g. 'agent', 'rag-module'). */
  type: string;
  /** RBAC service that owns this type (informational; the route is gated on 'resources'). */
  service: PermissionService;
  category: ResourceCategory;
  scope: ResourceScope;
  edition: 'community' | 'enterprise';
  /** ALL rows of the tenant: every project plus tenant-wide rows. */
  list(ctx: ResourceProviderContext): Promise<ResourceRecord[]>;
  /** Default: find in `list()`. */
  get?(ctx: ResourceProviderContext, id: string): Promise<ResourceRecord | null>;
  /**
   * Dashboard route of the resource's own page, verified to exist under
   * src/app/dashboard; null when the type has none.
   */
  detailUrl?(record: ResourceRecord): string | null;
}

// ── API shapes (what the UI receives) ────────────────────────────────────────

export interface ResourceListItem {
  crn: string;
  type: string;
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  status: string | null;
  statusTone: ResourceStatusTone;
  createdBy: string | null;
  createdByLabel: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ResourceDetail extends ResourceListItem {
  updatedBy: string | null;
  updatedByLabel: string | null;
  attributes: ResourceAttribute[];
  detailUrl: string | null;
}

export interface ResourceTypeInfo {
  type: string;
  service: PermissionService;
  category: ResourceCategory;
  scope: ResourceScope;
  edition: 'community' | 'enterprise';
}

export interface ResourceProviderError {
  type: string;
  message: string;
}

export interface ResourceTruncation {
  type: string;
  limit: number;
}

export interface ListResourcesInput {
  tenantDbName: string;
  tenantId: string;
  type?: string;
  /** A project id, or 'tenant' for tenant-wide rows only. */
  projectId?: string;
  q?: string;
  status?: string;
  /** Default 50, max 200. */
  limit?: number;
  offset?: number;
  /** Bypass the per-process cache and repopulate it. */
  refresh?: boolean;
}

export interface ListResourcesResult {
  items: ResourceListItem[];
  /** After all filters, before pagination. */
  total: number;
  /** Per type, AFTER project/q/status filters and BEFORE the type filter (facets). Every registered type is present (0 when empty). */
  counts: Record<string, number>;
  types: ResourceTypeInfo[];
  projects: Array<{ id: string; name: string }>;
  /** Distinct raw statuses, after project/q/type filters and BEFORE the status filter. */
  statuses: string[];
  errors: ResourceProviderError[];
  truncated: ResourceTruncation[];
  generatedAt: string;
}

export interface GetResourceInput {
  tenantDbName: string;
  tenantId: string;
  type: string;
  id: string;
}
