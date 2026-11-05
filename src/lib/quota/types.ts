// Scopes: from general to specific
//
// `group` (scopeId = a user-group id) applies to every member of the group; how
// the group's counters are kept is `QuotaPolicy.groupMode`.
//
// `ip` matches the caller's address against `QuotaPolicy.ipRanges` (CIDR). It
// never joins the merge of the other scopes: an IP limit keeps counters of its
// own (`QuotaPolicy.ipMode`), checked next to the caller's — see quotaGuard.ts.
export type QuotaScope = 'tenant' | 'group' | 'user' | 'token' | 'resource' | 'provider' | 'ip';

// Domains: service areas
//
// `agent` limits agent RUNS (requests and tokens per caller). Unlike the other
// domains it does not fall back to `global` policies, and a `resource`-scoped
// policy (scopeId = the agent key) narrows it to one agent — see quotaGuard.ts.
export type QuotaDomain =
  | 'global'
  | 'llm'
  | 'embedding'
  | 'vector'
  | 'file'
  | 'tracing'
  | 'stt'
  | 'tts'
  | 'ocr'
  | 'image'
  | 'moderation'
  | 'decision'
  | 'agent'
  // Services added with the domain registry (domains.ts). None of them falls
  // back to `global` policies: a limit on them has to name them.
  | 'websearch'
  | 'rag'
  | 'mcp'
  | 'rerank'
  | 'memory'
  | 'browser'
  | 'crawler'
  | 'guardrail'
  | 'jobs'
  | 'sandbox';

/**
 * How a `group`-scoped policy counts.
 *  - perMember (default): every member gets the limit; counters are per user.
 *  - shared: the whole group draws from ONE counter.
 */
export type QuotaGroupMode = 'perMember' | 'shared';

/**
 * How an `ip`-scoped policy counts.
 *  - perAddress (default): every client address in the ranges has its own
 *    counter (an IPv6 address is counted by its /64).
 *  - shared: the whole range list draws from ONE counter.
 */
export type QuotaIpMode = 'perAddress' | 'shared';

export const QUOTA_SCOPES: readonly QuotaScope[] = [
  'tenant',
  'group',
  'user',
  'token',
  'resource',
  'provider',
  'ip',
];

export const QUOTA_DOMAINS: readonly QuotaDomain[] = [
  'global',
  'llm',
  'embedding',
  'vector',
  'file',
  'tracing',
  'stt',
  'tts',
  'ocr',
  'image',
  'moderation',
  'decision',
  'agent',
  'websearch',
  'rag',
  'mcp',
  'rerank',
  'memory',
  'browser',
  'crawler',
  'guardrail',
  'jobs',
  'sandbox',
];

export const QUOTA_GROUP_MODES: readonly QuotaGroupMode[] = ['perMember', 'shared'];

export const QUOTA_IP_MODES: readonly QuotaIpMode[] = ['perAddress', 'shared'];

/** Most CIDR ranges one `ip` policy may list (the token allowlist uses the same bound). */
export const MAX_QUOTA_IP_RANGES = 100;

// Human-readable labels for UI
export const QUOTA_SCOPE_LABELS: Record<QuotaScope, string> = {
  tenant: 'Tenant',
  group: 'Group',
  user: 'User',
  token: 'API Token',
  resource: 'Resource',
  provider: 'Provider',
  ip: 'IP address',
};

export const QUOTA_DOMAIN_LABELS: Record<QuotaDomain, string> = {
  global: 'Global',
  llm: 'LLM / Chat',
  embedding: 'Embeddings',
  vector: 'Vector Store',
  file: 'Files',
  tracing: 'Agent Observability',
  stt: 'Speech-to-Text',
  tts: 'Text-to-Speech',
  ocr: 'OCR / Document AI',
  image: 'Image Generation',
  moderation: 'Moderation',
  decision: 'Decision',
  agent: 'Agent runs',
  websearch: 'Web Search',
  rag: 'Knowledge (RAG)',
  mcp: 'MCP tools',
  rerank: 'Reranker',
  memory: 'Memory',
  browser: 'Browser',
  crawler: 'Crawler',
  guardrail: 'Guardrails',
  jobs: 'Jobs',
  sandbox: 'Sandbox',
};

export interface QuotaRequestWindow {
  perSecond?: number;
  perMinute?: number;
  perHour?: number;
  perDay?: number;
  perMonth?: number;
}

export interface QuotaRateLimit {
  requests?: QuotaRequestWindow;
  tokens?: QuotaRequestWindow;
  vectors?: QuotaRequestWindow;
  files?: QuotaRequestWindow;
  storage?: QuotaRequestWindow;
  /** What a service counts besides requests (pages, documents, minutes); see `QUOTA_DOMAIN_SPECS[domain].unit`. */
  units?: QuotaRequestWindow;
}

export interface QuotaPerRequestLimits {
  // LLM / Embedding
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  
  // Vector
  maxVectorsPerUpsert?: number;
  maxQueryResults?: number;
  maxDimensions?: number;
  
  // File
  maxFileSize?: number;
  maxFilesPerRequest?: number;
  
  // Tracing
  maxEventsPerSession?: number;
  maxSessionDurationMs?: number;
  
  // General
  maxConcurrentRequests?: number;
}

export interface QuotaResourceCaps {
  // Projects
  maxProjects?: number;

  // Models
  maxModels?: number;
  
  // Vector
  maxVectorIndexes?: number;
  maxVectorsTotal?: number;
  
  // Files
  maxFileBuckets?: number;
  maxStorageBytes?: number;
  maxFilesTotal?: number;
  
  // Tracing
  maxTracingSessions?: number;
  maxTracingRetentionDays?: number;
  
  // Users/Tokens
  maxApiTokens?: number;
  maxUsers?: number;
  maxAgents?: number;

  // Agent execution (background runs) — each an upper bound under the env ceiling
  maxAgentSyncTimeoutSeconds?: number;
  maxAgentBackgroundDurationMinutes?: number;
  maxConcurrentAgentRuns?: number;
  /** Agent reminders waiting to fire across the tenant. */
  maxActiveAgentReminders?: number;
  /** Agent reminders set in any rolling 24 hours. */
  maxAgentRemindersPerDay?: number;
}

export interface QuotaBudget {
  dailySpendLimit?: number;
  monthlySpendLimit?: number;
  alertThresholds?: number[];
}

export interface QuotaLimits {
  rateLimit?: QuotaRateLimit;
  perRequest?: QuotaPerRequestLimits;
  quotas?: QuotaResourceCaps;
  budget?: QuotaBudget;
}

export interface QuotaPolicy {
  _id?: string;
  tenantId: string;
  /**
   * The project the policy belongs to. A policy of a kind listed in
   * `isTenantWideKind` may leave it out and then applies in every project; for
   * every other kind a missing projectId means the guard never loads it (the
   * behaviour that predates groups, kept so existing tenants decide as before).
   */
  projectId?: string;
  scope: QuotaScope;
  scopeId?: string;
  /** Only meaningful for `scope: 'group'`; absent means `perMember`. */
  groupMode?: QuotaGroupMode;
  /** `scope: 'ip'` only: the CIDR ranges the caller's address is matched against. */
  ipRanges?: string[];
  /** `scope: 'ip'` only; absent means `perAddress`. */
  ipMode?: QuotaIpMode;
  domain: QuotaDomain;
  priority: number;
  limits: QuotaLimits;
  enabled: boolean;
  label?: string;
  description?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export type QuotaPolicyInput = Omit<QuotaPolicy, '_id' | 'tenantId' | 'createdAt' | 'updatedAt'>;

/**
 * Kinds of policy that may omit `projectId` and then apply tenant-wide: group
 * limits (a group spans projects), IP limits (an address spans projects) and
 * everything in the agent domain.
 *
 * Deliberately NOT "every policy without a project": the guard has only ever
 * loaded project-bound policies, so a legacy tenant-wide row of an older kind
 * (created through the API without a project) is inert today. Making it live
 * would change decisions for existing tenants, which this additive feature must
 * not do.
 */
export function isTenantWideKind(policy: Pick<QuotaPolicy, 'scope' | 'domain'>): boolean {
  return policy.scope === 'group' || policy.scope === 'ip' || policy.domain === 'agent';
}

/** The effective group mode of a policy (`perMember` unless it says `shared`). */
export function quotaGroupMode(policy: Pick<QuotaPolicy, 'scope' | 'groupMode'>): QuotaGroupMode | undefined {
  if (policy.scope !== 'group') return undefined;
  return policy.groupMode === 'shared' ? 'shared' : 'perMember';
}

/** The effective IP mode of a policy (`perAddress` unless it says `shared`). */
export function quotaIpMode(policy: Pick<QuotaPolicy, 'scope' | 'ipMode'>): QuotaIpMode | undefined {
  if (policy.scope !== 'ip') return undefined;
  return policy.ipMode === 'shared' ? 'shared' : 'perAddress';
}
