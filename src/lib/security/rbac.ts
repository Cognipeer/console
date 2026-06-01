export const SERVICE_PERMISSION_LEVELS = ['none', 'read', 'write', 'admin'] as const;

export type ServicePermissionLevel = typeof SERVICE_PERMISSION_LEVELS[number];

export type PermissionService =
  | 'models'
  | 'prompts'
  | 'vector'
  | 'memory'
  | 'files'
  | 'rag'
  | 'reranker'
  | 'agents'
  | 'config'
  | 'tracing'
  | 'inference-monitoring'
  | 'guardrails'
  | 'pii'
  | 'mcp'
  | 'tools'
  | 'js-sandbox'
  | 'sandbox'
  | 'browser'
  | 'crawler'
  | 'alerts'
  | 'automations'
  | 'members'
  | 'projects'
  | 'providers'
  | 'tokens'
  | 'license'
  | 'audit'
  | 'gpu-fleet';

/**
 * Tenant-wide roles.
 * project_admin is kept for backward compatibility with existing records.
 * New code should use IUserProject.role for project-level role assignment.
 */
export type UserRole = 'owner' | 'admin' | 'project_admin' | 'user';

/** Project-scoped role stored on IUserProject. */
export type ProjectRole = 'project_admin' | 'member';

export interface RbacProjectLike {
  role: ProjectRole;
  servicePermissions?: UserServicePermissions | null;
}

export type UserServicePermissions = Partial<Record<PermissionService, ServicePermissionLevel>>;

export interface RbacUserLike {
  role?: UserRole | string;
  servicePermissions?: UserServicePermissions | null;
}

export interface RbacServiceDefinition {
  id: PermissionService;
  label: string;
  description: string;
  category: 'build' | 'data' | 'operate' | 'admin';
  adminService?: boolean;
}

export const RBAC_SERVICE_DEFINITIONS: RbacServiceDefinition[] = [
  { id: 'models', label: 'Model Hub', description: 'Models, providers and inference setup.', category: 'build' },
  { id: 'prompts', label: 'Prompt Studio', description: 'Prompt templates and versions.', category: 'build' },
  { id: 'agents', label: 'Agents', description: 'AI agents and agent versions.', category: 'build' },
  { id: 'mcp', label: 'MCP Servers', description: 'MCP server configuration and proxy APIs.', category: 'build' },
  { id: 'tools', label: 'Tools', description: 'Tool definitions and tool execution metadata.', category: 'build' },
  { id: 'js-sandbox', label: 'JS Sandbox', description: 'Managed JavaScript runtimes and sandboxed executions.', category: 'build' },
  { id: 'vector', label: 'Knowledge Index', description: 'Vector providers, indexes and vector operations.', category: 'data' },
  { id: 'memory', label: 'Agent Memory', description: 'Memory stores and memory items.', category: 'data' },
  { id: 'files', label: 'Document Store', description: 'File buckets and file objects.', category: 'data' },
  { id: 'rag', label: 'Knowledge Engine', description: 'RAG modules, documents and chunks.', category: 'data' },
  { id: 'reranker', label: 'Reranker', description: 'Reranker services and run logs.', category: 'data' },
  { id: 'tracing', label: 'Agent Observability', description: 'Tracing sessions, threads and events.', category: 'operate' },
  { id: 'inference-monitoring', label: 'Model Monitoring', description: 'Inference servers and metrics.', category: 'operate' },
  { id: 'guardrails', label: 'Guardrail', description: 'Guardrail policies and evaluation logs.', category: 'operate' },
  { id: 'pii', label: 'PII Service', description: 'PII detection, redaction and masking policies.', category: 'operate' },
  { id: 'browser', label: 'Browsers', description: 'Managed browser profiles and sessions.', category: 'operate' },
  { id: 'crawler', label: 'Crawler', description: 'Web crawlers that ingest markdown into knowledge engines.', category: 'data' },
  { id: 'alerts', label: 'Alerts & Incidents', description: 'Alert rules, history and incidents.', category: 'operate' },
  { id: 'automations', label: 'Automations', description: 'Operational schedulers, maintenance jobs and runtime controls.', category: 'admin', adminService: true },
  { id: 'projects', label: 'Projects', description: 'Project contexts and project-scoped access.', category: 'admin' },
  { id: 'tokens', label: 'API Tokens', description: 'User and project API tokens.', category: 'admin' },
  { id: 'members', label: 'Members', description: 'Tenant users, invitations and roles.', category: 'admin', adminService: true },
  { id: 'providers', label: 'Providers', description: 'Tenant-level provider credentials and integrations.', category: 'admin', adminService: true },
  { id: 'config', label: 'Config Management', description: 'Tenant configuration and secrets.', category: 'admin', adminService: true },
  { id: 'license', label: 'License', description: 'Offline license activation and limits.', category: 'admin', adminService: true },
  { id: 'audit', label: 'Audit Log', description: 'Security and administrative audit events.', category: 'admin', adminService: true },
  { id: 'gpu-fleet', label: 'GPU Fleet', description: 'GPU hosts, MIG slices, model deployments, and terminal access.', category: 'operate', adminService: true },
  { id: 'sandbox', label: 'Agent Sandbox', description: 'Agent runtime sandboxes: runners, templates, instances, volumes, and terminal access.', category: 'operate', adminService: true },
];

const SERVICE_IDS = new Set<PermissionService>(RBAC_SERVICE_DEFINITIONS.map((service) => service.id));

const LEVEL_RANK: Record<ServicePermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const ROUTE_PREFIXES: Array<{ prefix: string; service: PermissionService }> = [
  { prefix: '/api/client/v1/browser', service: 'browser' },
  { prefix: '/api/client/v1/crawler', service: 'crawler' },
  { prefix: '/api/client/v1/automations', service: 'automations' },
  { prefix: '/api/client/v1/config', service: 'config' },
  { prefix: '/api/client/v1/files', service: 'files' },
  { prefix: '/api/client/v1/guardrails', service: 'guardrails' },
  { prefix: '/api/client/v1/mcp', service: 'mcp' },
  { prefix: '/api/client/v1/js-sandbox', service: 'js-sandbox' },
  { prefix: '/api/client/v1/sandbox', service: 'sandbox' },
  { prefix: '/api/client/v1/memory', service: 'memory' },
  { prefix: '/api/client/v1/prompts', service: 'prompts' },
  { prefix: '/api/client/v1/rag', service: 'rag' },
  { prefix: '/api/client/v1/rerank', service: 'reranker' },
  { prefix: '/api/client/v1/tools', service: 'tools' },
  { prefix: '/api/client/v1/tracing', service: 'tracing' },
  { prefix: '/api/client/v1/traces', service: 'tracing' },
  { prefix: '/api/client/v1/vector', service: 'vector' },
  { prefix: '/api/client/v1/agents', service: 'agents' },
  { prefix: '/api/client/v1/chat', service: 'models' },
  { prefix: '/api/client/v1/responses', service: 'models' },
  { prefix: '/api/client/v1/embeddings', service: 'models' },
  { prefix: '/api/models/v1', service: 'models' },
  { prefix: '/api/audit', service: 'audit' },
  { prefix: '/api/users', service: 'members' },
  { prefix: '/api/license', service: 'license' },
  { prefix: '/api/providers', service: 'providers' },
  { prefix: '/api/config', service: 'config' },
  { prefix: '/api/quota', service: 'projects' },
  { prefix: '/api/projects', service: 'projects' },
  { prefix: '/api/tokens', service: 'tokens' },
  { prefix: '/api/models', service: 'models' },
  { prefix: '/api/prompts', service: 'prompts' },
  { prefix: '/api/vector', service: 'vector' },
  { prefix: '/api/memory', service: 'memory' },
  { prefix: '/api/files', service: 'files' },
  { prefix: '/api/rag', service: 'rag' },
  { prefix: '/api/reranker', service: 'reranker' },
  { prefix: '/api/agents', service: 'agents' },
  { prefix: '/api/tracing', service: 'tracing' },
  { prefix: '/api/inference-monitoring', service: 'inference-monitoring' },
  { prefix: '/api/guardrails', service: 'guardrails' },
  { prefix: '/api/pii', service: 'pii' },
  { prefix: '/api/mcp', service: 'mcp' },
  { prefix: '/api/tools', service: 'tools' },
  { prefix: '/api/js-sandbox', service: 'js-sandbox' },
  { prefix: '/api/browser', service: 'browser' },
  { prefix: '/api/crawler', service: 'crawler' },
  { prefix: '/api/automations', service: 'automations' },
  { prefix: '/api/alerts', service: 'alerts' },
  { prefix: '/api/gpu-fleet', service: 'gpu-fleet' },
  { prefix: '/api/sandbox', service: 'sandbox' },
];

export function isPermissionService(value: unknown): value is PermissionService {
  return typeof value === 'string' && SERVICE_IDS.has(value as PermissionService);
}

export function isServicePermissionLevel(value: unknown): value is ServicePermissionLevel {
  return typeof value === 'string' && SERVICE_PERMISSION_LEVELS.includes(value as ServicePermissionLevel);
}

export function normalizeServicePermissions(value: unknown): UserServicePermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: UserServicePermissions = {};
  for (const [service, level] of Object.entries(value as Record<string, unknown>)) {
    if (isPermissionService(service) && isServicePermissionLevel(level)) {
      normalized[service] = level;
    }
  }
  return normalized;
}

export function getServiceDefinition(service: PermissionService): RbacServiceDefinition {
  return RBAC_SERVICE_DEFINITIONS.find((definition) => definition.id === service)
    ?? RBAC_SERVICE_DEFINITIONS[0];
}

export function getPermissionServiceForPath(pathname: string): PermissionService | null {
  const normalized = pathname.endsWith('/') && pathname !== '/'
    ? pathname.slice(0, -1)
    : pathname;
  const match = ROUTE_PREFIXES.find(({ prefix }) =>
    normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
  return match?.service ?? null;
}

export function getRequiredPermissionLevel(
  method: string,
  service: PermissionService,
): ServicePermissionLevel {
  const definition = getServiceDefinition(service);
  const normalizedMethod = method.toUpperCase();

  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') {
    return 'read';
  }

  return definition.adminService ? 'admin' : 'write';
}

export function getRoleDefaultPermission(
  role: string | undefined,
  service: PermissionService,
): ServicePermissionLevel {
  if (role === 'owner' || role === 'admin') {
    return 'admin';
  }

  const definition = getServiceDefinition(service);
  if (definition.adminService) {
    return 'none';
  }

  // project_admin kept for backward compat with legacy user records
  return role === 'project_admin' || role === 'user' ? 'write' : 'none';
}

/**
 * Returns the effective service permission for a user within a specific project.
 *
 * Resolution order:
 *   1. Explicit servicePermissions on the UserProject record
 *   2. Role default: project_admin → write on non-admin services, member → write
 *
 * For future Group support, call this once for the direct UserProject membership and once
 * for each GroupProject the user inherits, then take the highest level across all results.
 */
export function getEffectiveProjectPermission(
  userProject: RbacProjectLike,
  service: PermissionService,
): ServicePermissionLevel {
  const explicit = normalizeServicePermissions(userProject.servicePermissions)[service];
  if (explicit) return explicit;

  const definition = getServiceDefinition(service);
  if (definition.adminService) {
    return userProject.role === 'project_admin' ? 'read' : 'none';
  }

  return 'write';
}

/**
 * Resolves the final effective permission for a user in a project context.
 *
 * - Owners/admins bypass project-level checks entirely.
 * - Regular users inherit permissions from their UserProject record.
 * - When groups are introduced, pass groupProjects and the highest permission wins.
 */
export function resolveEffectivePermission(params: {
  tenantRole: string | undefined;
  tenantServicePermissions?: UserServicePermissions | null;
  userProject?: RbacProjectLike | null;
  /** Future: pass GroupProject memberships for group-inherited permissions. */
  groupProjects?: RbacProjectLike[];
  service: PermissionService;
}): ServicePermissionLevel {
  const { tenantRole, tenantServicePermissions, userProject, groupProjects = [], service } = params;

  if (tenantRole === 'owner' || tenantRole === 'admin') {
    return 'admin';
  }

  // Tenant-level explicit override (admin-granted exception)
  const tenantExplicit = normalizeServicePermissions(tenantServicePermissions)[service];
  if (tenantExplicit) return tenantExplicit;

  if (!userProject) {
    return 'none';
  }

  // Direct project membership
  const direct = getEffectiveProjectPermission(userProject, service);

  // Union with group-inherited permissions (future groups)
  const groupMax = groupProjects.reduce<ServicePermissionLevel>((best, gp) => {
    const gLevel = getEffectiveProjectPermission(gp, service);
    return LEVEL_RANK[gLevel] > LEVEL_RANK[best] ? gLevel : best;
  }, 'none');

  return LEVEL_RANK[direct] >= LEVEL_RANK[groupMax] ? direct : groupMax;
}

export function getEffectiveServicePermission(
  user: RbacUserLike,
  service: PermissionService,
): ServicePermissionLevel {
  if (user.role === 'owner') {
    return 'admin';
  }

  const explicit = normalizeServicePermissions(user.servicePermissions)[service];
  return explicit ?? getRoleDefaultPermission(user.role, service);
}

export function hasServicePermission(
  user: RbacUserLike,
  service: PermissionService,
  required: ServicePermissionLevel,
): boolean {
  return LEVEL_RANK[getEffectiveServicePermission(user, service)] >= LEVEL_RANK[required];
}

export function authorizeServiceRequest(
  user: RbacUserLike,
  method: string,
  pathname: string,
): { allowed: true; service: PermissionService | null; required?: ServicePermissionLevel } | {
  allowed: false;
  service: PermissionService;
  required: ServicePermissionLevel;
  current: ServicePermissionLevel;
} {
  const service = getPermissionServiceForPath(pathname);
  if (!service) {
    return { allowed: true, service: null };
  }

  const required = getRequiredPermissionLevel(method, service);
  const current = getEffectiveServicePermission(user, service);
  if (LEVEL_RANK[current] >= LEVEL_RANK[required]) {
    return { allowed: true, service, required };
  }

  return {
    allowed: false,
    current,
    required,
    service,
  };
}
