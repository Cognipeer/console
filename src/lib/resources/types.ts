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
  | 'operations'
  // Sandbox, GPU fleet and other platform resources (enterprise types).
  | 'infrastructure';

/**
 * Where instances of a type may live:
 *  - 'project'           every row belongs to one project
 *  - 'project-or-tenant' a row may be project-scoped or tenant-wide
 *  - 'tenant'            rows are always tenant-wide
 */
export type ResourceScope = 'project' | 'project-or-tenant' | 'tenant';

/**
 * How a resource relates to projects, computed on the server (the UI must not
 * guess it from `projectId === null`, which means four different things).
 *  - 'project'        belongs to exactly one project
 *  - 'multi-project'  assigned to several projects (e.g. a provider)
 *  - 'all-projects'   scope 'project-or-tenant' without a project: a tenant-wide
 *                     row that every project can use
 *  - 'tenant-level'   scope 'tenant': the type has no project concept at all
 *                     (GPU host, inference server, sandbox volume...)
 *  - 'unassigned'     scope 'project' without a project (provider assigned to
 *                     none, legacy row): usable from no project
 */
export type ProjectDisplay =
  | { kind: 'project'; projectId: string; projectName: string | null }
  | { kind: 'multi-project'; projectIds: string[]; projectNames: string[] }
  | { kind: 'all-projects' }
  | { kind: 'tenant-level' }
  | { kind: 'unassigned' };

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
  /**
   * INTERNAL, outgoing references to other resources (keys/ids only, never a
   * secret). The service folds them into the reference graph while building a
   * snapshot and then drops them: they are never cached on the record, never
   * serialised, and no API mapper may copy them.
   */
  edges?: ResourceEdgeInput[];
}

/**
 * One outgoing reference, as a provider extracts it from the raw document.
 * `kind` must be registered in references.ts (EDGE_KINDS); `toType`/`by` are
 * filled from that registration by the edge collector.
 */
export interface ResourceEdgeInput {
  kind: string;
  toType: string;
  by: 'key' | 'id';
  /** The referenced key (or id). Never empty. */
  target: string;
  /** Where in the referrer's document the reference lives, e.g. `config.modelKey`. */
  field: string;
  /** For composite targets only: a vector index is addressed by providerKey + indexKey, the providerKey being the qualifier. */
  qualifier?: string;
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
  /**
   * Per-tenant entitlement. When it resolves false (or throws) the type is
   * skipped for this tenant: no list() call, not in the type facets, and edges
   * that point at it are dropped like those to a type of another edition. Used
   * by enterprise types so a tenant without the license neither pays the reads
   * nor sees modules it cannot use. Omitted = always available.
   */
  isAvailable?(ctx: ResourceProviderContext): Promise<boolean>;
  /** ALL rows of the tenant: every project plus tenant-wide rows. */
  list(ctx: ResourceProviderContext): Promise<ResourceRecord[]>;
  /**
   * Unused by the service since R2: a detail is served from the full snapshot
   * (the reference graph needs the whole tenant), never from a per-type read.
   */
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
  /** Server-computed; render this instead of inferring from `projectId`. */
  projectDisplay: ProjectDisplay;
  status: string | null;
  statusTone: ResourceStatusTone;
  createdBy: string | null;
  createdByLabel: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Health issues this resource is the subject of (broken references, duplicate key...). */
  issueCount: number;
  issueSeverity: HealthSeverity | null;
}

export interface ResourceDetail extends ResourceListItem {
  updatedBy: string | null;
  updatedByLabel: string | null;
  attributes: ResourceAttribute[];
  detailUrl: string | null;
  /** Outgoing references, in the order they appear in the document. */
  uses: ResourceEdgeView[];
  /** Incoming references (who points at this resource), capped; see `usedByTruncated`. */
  usedBy: ResourceEdgeView[];
  usedByTruncated: boolean;
  issues: HealthIssue[];
}

// ── Reference graph + health (API shapes) ────────────────────────────────────

export type HealthSeverity = 'error' | 'warning';

export type ResourceEdgeStatus = 'ok' | 'missing' | 'cross-project' | 'inactive' | 'ambiguous';

/** A resource pointer. For a target that does not exist only `type` + `key` (or `id`) are set. */
export interface ResourceRefView {
  type: string;
  id: string | null;
  key: string | null;
  name: string | null;
  projectId: string | null;
  projectName: string | null;
  /** null for a target that does not (uniquely) exist: there is no row to describe. */
  projectDisplay: ProjectDisplay | null;
  crn: string | null;
}

export interface ResourceEdgeView {
  kind: string;
  field: string;
  direction: 'out' | 'in';
  status: ResourceEdgeStatus;
  /** null when the edge is ok. */
  severity: HealthSeverity | null;
  /** 'out': the target; 'in': the referrer. A missing/ambiguous/cross-project target is a bare type + key. */
  other: ResourceRefView;
  /** Ambiguous matches or the other-project copies of a cross-project target (max 10). */
  candidates?: ResourceRefView[];
}

export type HealthIssueKind =
  | 'broken-reference'
  | 'cross-project-reference'
  | 'inactive-reference'
  | 'ambiguous-reference'
  | 'duplicate-key'
  | 'mcp-dual-registration';

export interface HealthIssue {
  /** Stable hash of kind + resource + target, so a UI can keep selection across refreshes. */
  id: string;
  kind: HealthIssueKind;
  severity: HealthSeverity;
  resource: ResourceRefView;
  related?: ResourceRefView[];
  edgeKind?: string;
  field?: string;
  targetType?: string;
  targetKey?: string;
}

export interface ResourceHealthResult {
  /** Scope filters (type/projectId) applied; severity/kind filters NOT, so facets stay stable. */
  summary: { error: number; warning: number; byKind: Record<string, number> };
  /** Max 1000, errors first, then by resource name. */
  issues: HealthIssue[];
  truncated: boolean;
  /** Present (true) when the reference analysis failed: an empty `issues` then means "not checked". */
  graphUnavailable?: boolean;
  generatedAt: string;
}

export interface GetResourceHealthInput {
  tenantDbName: string;
  tenantId: string;
  severity?: HealthSeverity;
  kind?: HealthIssueKind;
  type?: string;
  /** A project id, or 'tenant' for resources not bound to a single project. */
  projectId?: string;
  refresh?: boolean;
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
  /**
   * A project id, or 'tenant' for rows not bound to a single project
   * (all-projects + tenant-level + unassigned).
   */
  projectId?: string;
  q?: string;
  status?: string;
  /** 'issues' = only resources that are the subject of a health issue. */
  health?: 'issues';
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

// ── Usage (delete / rename impact) ───────────────────────────────────────────

/** An incoming reference as served by the usage endpoint. */
export interface ResourceUsageEdgeView extends ResourceEdgeView {
  /**
   * What deleting (or renaming the key of) the target does to this referrer:
   * 'error' = it fails or loses a safety control at run time, 'warning' = it
   * runs with reduced capability, null = already unresolved or ambiguous, so a
   * delete changes nothing for it. Only on `usedBy` edges.
   */
  impact?: HealthSeverity | null;
}

export interface ResourceUsageSummary {
  /** Referrers that would FAIL if the resource were deleted. Counts hidden referrers too. */
  error: number;
  /** Referrers that would lose a capability. Counts hidden referrers too. */
  warning: number;
}

/** GET /api/resource-usage/:type/:id */
export interface ResourceUsage {
  resource: ResourceRefView;
  /** Outgoing references; visibility-filtered. */
  uses: ResourceEdgeView[];
  /** Incoming references the caller may see, capped at MAX_USED_BY. */
  usedBy: ResourceUsageEdgeView[];
  /** Referrers in projects the caller cannot access (not listed). */
  hiddenUsedByCount: number;
  /** hiddenUsedByCount per referrer resource type. */
  hiddenByType: Record<string, number>;
  summary: ResourceUsageSummary;
  usedByTruncated: boolean;
}

export interface GetResourceUsageInput {
  tenantDbName: string;
  tenantId: string;
  type: string;
  id: string;
  /**
   * Projects the caller may see. null = everything (tenant owner / admin).
   * Tenant-wide and tenant-level rows are always visible.
   */
  visibleProjectIds: ReadonlySet<string> | null;
  /**
   * Whether the caller may read resources of a type (their permission on the
   * service that owns it). Referrers / targets of other types fail closed:
   * they are counted, not listed. Omitted = every type is visible.
   */
  canViewType?: (type: string) => boolean;
}
