/**
 * Quota domain seam — COMMUNITY (open-source) edition.
 *
 * A limit may only be written for a service that checks it. The community
 * registry (`lib/quota/domains.ts`) marks the services the core guards as
 * `enforced`; services whose call sites live in the enterprise overlay (the
 * sandbox) and the job kinds it runs (flows, the prompt optimizer, Abacus) are
 * offered only once the overlay registers them here, so a community install
 * never accepts a limit that nothing would apply.
 *
 * Contract:
 *   - Nothing is registered in the community edition.
 *   - The overlay calls `registerEnterpriseQuotaDomains(...)` once at load, from
 *     its `registry.ts`. Registering twice is harmless.
 *   - The policy API validates against `offeredQuotaDomains()` /
 *     `offeredQuotaJobKinds()`, and GET /api/quota/defaults hands both to the
 *     editor.
 *
 * Leaf module: only the pure registry, so the overlay can import it at load.
 */
import {
  COMMUNITY_QUOTA_JOB_KINDS,
  ENFORCED_QUOTA_DOMAINS,
  QUOTA_DOMAIN_SPECS,
  QUOTA_JOB_KINDS,
  type QuotaJobKind,
} from '@/lib/quota/domains';
import type { QuotaDomain } from '@/lib/quota/types';

export interface EnterpriseQuotaContribution {
  /** Domains whose guarded call sites the overlay adds. */
  domains?: readonly QuotaDomain[];
  /** `jobs` kinds the overlay counts. */
  jobKinds?: readonly QuotaJobKind[];
}

const domains = new Set<QuotaDomain>();
const jobKinds = new Set<QuotaJobKind>();

export function registerEnterpriseQuotaDomains(contribution: EnterpriseQuotaContribution): void {
  for (const domain of contribution.domains ?? []) {
    if (domain in QUOTA_DOMAIN_SPECS) domains.add(domain);
  }
  for (const kind of contribution.jobKinds ?? []) {
    if ((QUOTA_JOB_KINDS as readonly string[]).includes(kind)) jobKinds.add(kind);
  }
}

/** Domains a limit may be written for, in registry order. */
export function offeredQuotaDomains(): QuotaDomain[] {
  return (Object.keys(QUOTA_DOMAIN_SPECS) as QuotaDomain[])
    .filter((domain) => ENFORCED_QUOTA_DOMAINS.includes(domain) || domains.has(domain));
}

/** Job kinds a `jobs` resource limit may name. */
export function offeredQuotaJobKinds(): QuotaJobKind[] {
  return QUOTA_JOB_KINDS.filter((kind) => (COMMUNITY_QUOTA_JOB_KINDS as readonly string[]).includes(kind) || jobKinds.has(kind));
}

/** For tests: forget what the overlay registered. */
export function resetEnterpriseQuotaDomainsForTests(): void {
  domains.clear();
  jobKinds.clear();
}
