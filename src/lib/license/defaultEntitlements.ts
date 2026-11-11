/**
 * Default entitlements for tenants on the free tier.
 *
 * A deployment can register a provider that supplies a default service claim
 * and project limit for every tenant whose effective license type is FREE (no
 * license, an inactive or expired one, or a stored license of type FREE). A
 * license's own `services` claim or project limit always wins, and paid license
 * types are never affected. Nothing is registered in the community build, so
 * behaviour there is unchanged.
 *
 * The provider is read synchronously on hot paths: it must answer from memory.
 * This module imports types only, so it cannot take part in an import cycle.
 */

import type { LicenseServiceClaim } from '@/lib/license/license-manager';

export interface DefaultEntitlements {
  services?: LicenseServiceClaim;
  maxProjects?: number;
}

export type DefaultEntitlementsProvider = () => DefaultEntitlements | null;

let provider: DefaultEntitlementsProvider | null = null;

export function registerDefaultEntitlementsProvider(fn: DefaultEntitlementsProvider | null): void {
  provider = fn;
}

/** The registered defaults, or null when nothing is registered (or the provider fails or has none). */
export function getDefaultEntitlements(): DefaultEntitlements | null {
  if (!provider) return null;
  try {
    return provider() ?? null;
  } catch {
    // A failing provider must never break license resolution: fall back to no defaults.
    return null;
  }
}

/** Test hook: forget the registered provider. */
export function resetDefaultEntitlementsForTests(): void {
  provider = null;
}
