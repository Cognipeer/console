/**
 * The quota domain registry: what each service can be limited on.
 *
 * Every place that used to keep its own list of domains reads this instead:
 * the guard (which counters a domain has, whether `global` policies reach it),
 * the policy API (which domains are accepted), the spend API, and the editor
 * (which sections and fields to show). Adding a service is one entry here plus
 * the guard call at the service's own entry point.
 *
 * Pure data, no I/O: the UI imports it too.
 */
import type { QuotaDomain, QuotaPerRequestLimits, QuotaRateLimit } from './types';

/** A counter kind of `QuotaLimits.rateLimit`. */
export type QuotaRateKind = keyof QuotaRateLimit;

/** How the editor groups services in its picker. */
export type QuotaDomainGroup = 'platform' | 'model' | 'data' | 'tool' | 'runtime';

/** What the `units` counter of a service counts. */
export type QuotaUnit = 'document' | 'page' | 'minute';

export interface QuotaDomainSpec {
  group: QuotaDomainGroup;
  /** Counter kinds a policy of this domain may set; the editor shows one section per kind. */
  rateKinds: readonly QuotaRateKind[];
  /** What `units` counts, when `rateKinds` has it. */
  unit?: QuotaUnit;
  /** Per-request fields the service checks. */
  perRequest: readonly (keyof QuotaPerRequestLimits)[];
  /** The service is checked against resource caps (`limits.quotas`). */
  resourceCaps: boolean;
  /** The service debits a realized USD cost, so a budget applies. */
  budget: boolean;
  /**
   * `global` policies apply to this domain too. False for every domain added
   * after `global` existed: a global limit sized for model calls must not
   * start refusing a service the tenant never wrote a limit for.
   */
  globalFallback: boolean;
  /** At least one guarded call site exists. A domain without one is not offered by the editor. */
  enforced: boolean;
}

const MODEL_TOKENS: readonly (keyof QuotaPerRequestLimits)[] = ['maxInputTokens', 'maxOutputTokens', 'maxTotalTokens'];

/** A service added with this registry: requests (plus what it lists), no caps, no budget, no global fallback. */
function service(
  group: QuotaDomainGroup,
  extra: Partial<Pick<QuotaDomainSpec, 'rateKinds' | 'unit' | 'perRequest'>> = {},
): QuotaDomainSpec {
  return {
    group,
    rateKinds: extra.rateKinds ?? ['requests'],
    unit: extra.unit,
    perRequest: extra.perRequest ?? [],
    resourceCaps: false,
    budget: false,
    globalFallback: false,
    enforced: true,
  };
}

/** A model service that existed before the registry: requests only, budget, global fallback. */
function modelService(): QuotaDomainSpec {
  return {
    group: 'model',
    rateKinds: ['requests'],
    perRequest: [],
    resourceCaps: false,
    budget: true,
    globalFallback: true,
    enforced: true,
  };
}

export const QUOTA_DOMAIN_SPECS: Readonly<Record<QuotaDomain, QuotaDomainSpec>> = {
  global: {
    group: 'platform',
    rateKinds: ['requests', 'tokens', 'vectors', 'files', 'storage'],
    perRequest: [
      ...MODEL_TOKENS,
      'maxVectorsPerUpsert',
      'maxQueryResults',
      'maxFileSize',
      'maxFilesPerRequest',
      'maxEventsPerSession',
      'maxSessionDurationMs',
    ],
    resourceCaps: true,
    budget: true,
    globalFallback: true,
    enforced: true,
  },
  llm: { group: 'model', rateKinds: ['requests', 'tokens'], perRequest: MODEL_TOKENS, resourceCaps: true, budget: true, globalFallback: true, enforced: true },
  embedding: { group: 'model', rateKinds: ['requests', 'tokens'], perRequest: MODEL_TOKENS, resourceCaps: true, budget: true, globalFallback: true, enforced: true },
  image: modelService(),
  stt: modelService(),
  tts: modelService(),
  ocr: modelService(),
  decision: modelService(),
  // No realized cost is debited for a moderation call, so no budget.
  moderation: { ...modelService(), budget: false },
  vector: {
    group: 'data',
    rateKinds: ['requests', 'vectors'],
    perRequest: ['maxVectorsPerUpsert', 'maxQueryResults'],
    resourceCaps: true,
    budget: true,
    globalFallback: true,
    enforced: true,
  },
  file: {
    group: 'data',
    rateKinds: ['requests', 'files', 'storage'],
    perRequest: ['maxFileSize', 'maxFilesPerRequest'],
    resourceCaps: true,
    budget: true,
    globalFallback: true,
    enforced: true,
  },
  tracing: {
    group: 'platform',
    rateKinds: ['requests'],
    perRequest: ['maxEventsPerSession', 'maxSessionDurationMs'],
    resourceCaps: true,
    budget: true,
    globalFallback: true,
    enforced: true,
  },
  agent: { group: 'runtime', rateKinds: ['requests', 'tokens'], perRequest: [], resourceCaps: false, budget: false, globalFallback: false, enforced: true },
  rag: service('data', { rateKinds: ['requests', 'units'], unit: 'document' }),
  memory: service('data'),
  websearch: service('tool'),
  mcp: service('tool'),
  rerank: service('tool', { rateKinds: ['requests', 'units'], unit: 'document' }),
  browser: service('tool', { perRequest: ['maxConcurrentRequests'] }),
  crawler: service('tool', { rateKinds: ['requests', 'units'], unit: 'page' }),
  guardrail: service('tool'),
  jobs: service('runtime'),
  // Guarded by the enterprise overlay (the sandbox lives there): offered once it
  // registers (src/enterprise/quota-domains.ts), never in a community install.
  sandbox: {
    ...service('runtime', { rateKinds: ['requests', 'units'], unit: 'minute', perRequest: ['maxConcurrentRequests'] }),
    enforced: false,
  },
};

export const QUOTA_DOMAIN_GROUP_ORDER: readonly QuotaDomainGroup[] = ['model', 'data', 'tool', 'runtime', 'platform'];

export function quotaDomainSpec(domain: QuotaDomain): QuotaDomainSpec {
  return QUOTA_DOMAIN_SPECS[domain] ?? QUOTA_DOMAIN_SPECS.global;
}

/**
 * Domains the community core guards, in registry order. What a policy may be
 * written for at runtime also includes what the enterprise overlay registers:
 * see `offeredQuotaDomains` in src/enterprise/quota-domains.ts.
 */
export const ENFORCED_QUOTA_DOMAINS: readonly QuotaDomain[] = (Object.keys(QUOTA_DOMAIN_SPECS) as QuotaDomain[])
  .filter((domain) => QUOTA_DOMAIN_SPECS[domain].enforced);

/** Whether `global` policies reach a check in `domain`. */
export function domainFallsBackToGlobal(domain: QuotaDomain): boolean {
  return domain !== 'global' && quotaDomainSpec(domain).globalFallback;
}

/**
 * Kinds of work the `jobs` domain counts. A `resource` limit in that domain
 * names one of these (the call sites put it in `resourceKey`).
 */
export const QUOTA_JOB_KINDS = ['analysis', 'evaluation', 'redteam', 'prompt-optimizer', 'abacus', 'flow'] as const;
export type QuotaJobKind = (typeof QUOTA_JOB_KINDS)[number];

/** The job kinds the community core counts; the others are the enterprise overlay's. */
export const COMMUNITY_QUOTA_JOB_KINDS: readonly QuotaJobKind[] = ['analysis', 'evaluation', 'redteam'];
