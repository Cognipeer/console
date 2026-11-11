/**
 * Default entitlements for free-tier tenants: the provider registry, the
 * license manager's project limit and the service decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  license: { licenseType: 'FREE' } as { licenseType: string; services?: { allow?: string[]; deny?: string[] } },
}));

vi.mock('@/lib/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/config')>();
  return { ...actual, getConfig: () => ({ ...actual.getConfig(), services: { disabled: [], enabled: [] } }) };
});

vi.mock('@/lib/license/tenantLicense', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/license/tenantLicense')>();
  return { ...actual, resolveLiveLicenseForTenant: async () => hoisted.license };
});

import {
  getDefaultEntitlements,
  registerDefaultEntitlementsProvider,
  resetDefaultEntitlementsForTests,
} from '@/lib/license/defaultEntitlements';
import { LicenseManager } from '@/lib/license/license-manager';
import {
  clearServiceAvailabilityMemo,
  getDisabledServices,
} from '@/lib/services/availability/serviceAvailability';

const tenantWith = (licenseType: string, limits?: { maxProjects: number }, extra: Record<string, unknown> = {}) => ({
  _id: 't1',
  licenseId: 'lic-1',
  licenseStatus: 'active',
  licenseType,
  licensePayload: { licenseId: 'lic-1', licenseType, ...(limits ? { limits } : {}), ...extra },
}) as never;

beforeEach(() => {
  resetDefaultEntitlementsForTests();
  clearServiceAvailabilityMemo();
  hoisted.license = { licenseType: 'FREE' };
});
afterEach(() => resetDefaultEntitlementsForTests());

describe('provider registry', () => {
  it('is null when nothing is registered', () => {
    expect(getDefaultEntitlements()).toBeNull();
  });

  it('returns what the provider answers, and null when it throws or has none', () => {
    registerDefaultEntitlementsProvider(() => ({ maxProjects: 5 }));
    expect(getDefaultEntitlements()).toEqual({ maxProjects: 5 });
    registerDefaultEntitlementsProvider(() => null);
    expect(getDefaultEntitlements()).toBeNull();
    registerDefaultEntitlementsProvider(() => { throw new Error('boom'); });
    expect(getDefaultEntitlements()).toBeNull();
  });
});

describe('project limit', () => {
  it('is unchanged when nothing is registered', () => {
    expect(LicenseManager.getDefaultFreeLicense().limits.maxProjects).toBe(2);
    expect(LicenseManager.getLimits().maxProjects).toBe(2);
    expect(LicenseManager.getEffectiveLicenseForTenant(null).limits.maxProjects).toBe(2);
  });

  it('applies to a tenant without a license, an inactive one, an expired one and the free-tier limits', () => {
    registerDefaultEntitlementsProvider(() => ({ maxProjects: 7 }));
    expect(LicenseManager.getDefaultFreeLicense().limits.maxProjects).toBe(7);
    expect(LicenseManager.getLimits().maxProjects).toBe(7);
    expect(LicenseManager.getEffectiveLicenseForTenant(null).limits.maxProjects).toBe(7);
    expect(LicenseManager.getEffectiveLicenseForTenant({ ...(tenantWith('STARTER') as object), licenseStatus: 'inactive' } as never).limits.maxProjects).toBe(7);
    const expired = LicenseManager.getEffectiveLicenseForTenant({
      ...(tenantWith('STARTER', { maxProjects: 50 }) as object),
      licenseExpiresAt: new Date(Date.now() - 1000),
    } as never);
    expect(expired.status).toBe('expired');
    expect(expired.limits.maxProjects).toBe(7);
  });

  it('is the base of a stored FREE license, which its own limit still overrides', () => {
    registerDefaultEntitlementsProvider(() => ({ maxProjects: 7 }));
    expect(LicenseManager.getEffectiveLicenseForTenant(tenantWith('FREE')).limits.maxProjects).toBe(7);
    expect(LicenseManager.getEffectiveLicenseForTenant(tenantWith('FREE', { maxProjects: 3 })).limits.maxProjects).toBe(3);
  });

  it('never changes a paid license, with or without its own limit', () => {
    registerDefaultEntitlementsProvider(() => ({ maxProjects: 7 }));
    expect(LicenseManager.getEffectiveLicenseForTenant(tenantWith('STARTER')).limits.maxProjects).toBe(2);
    expect(LicenseManager.getEffectiveLicenseForTenant(tenantWith('ENTERPRISE', { maxProjects: 9 })).limits.maxProjects).toBe(9);
  });

  it('accepts 0 and falls back to the built-in limit for an invalid value', () => {
    registerDefaultEntitlementsProvider(() => ({ maxProjects: 0 }));
    expect(LicenseManager.getDefaultFreeLicense().limits.maxProjects).toBe(0);
    registerDefaultEntitlementsProvider(() => ({ maxProjects: -1 }));
    expect(LicenseManager.getDefaultFreeLicense().limits.maxProjects).toBe(2);
    registerDefaultEntitlementsProvider(() => ({ maxProjects: 1.5 }));
    expect(LicenseManager.getDefaultFreeLicense().limits.maxProjects).toBe(2);
  });
});

describe('service decision', () => {
  it('changes nothing when nothing is registered', async () => {
    expect((await getDisabledServices('t1')).size).toBe(0);
  });

  it('applies the default claim to a free-tier tenant without a claim', async () => {
    registerDefaultEntitlementsProvider(() => ({ services: { allow: ['models'] } }));
    const off = await getDisabledServices('t1');
    expect(off.has('rag')).toBe(true);
    expect(off.get('rag')?.source).toBe('license');
    expect(off.has('models')).toBe(false);
  });

  it('never applies to a license with its own claim', async () => {
    registerDefaultEntitlementsProvider(() => ({ services: { allow: ['models'] } }));
    hoisted.license = { licenseType: 'FREE', services: { deny: ['rag'] } };
    const off = await getDisabledServices('t1');
    expect(off.has('rag')).toBe(true);
    expect(off.has('tools')).toBe(false);
  });

  it('never applies to a paid license', async () => {
    registerDefaultEntitlementsProvider(() => ({ services: { allow: ['models'] } }));
    for (const licenseType of ['STARTER', 'PROFESSIONAL', 'ENTERPRISE']) {
      hoisted.license = { licenseType };
      clearServiceAvailabilityMemo();
      expect((await getDisabledServices('t1')).size).toBe(0);
    }
  });

  it('feeds the decision from the real effective license: expired is free without a claim, a stored FREE claim stays', () => {
    const expired = LicenseManager.getEffectiveLicenseForTenant({
      ...(tenantWith('STARTER') as object),
      licenseExpiresAt: new Date(Date.now() - 1000),
    } as never);
    expect(expired.licenseType).toBe('FREE');
    expect(expired.services).toBeUndefined();
    const stored = LicenseManager.getEffectiveLicenseForTenant(tenantWith('FREE', undefined, { services: { deny: ['rag'] } }));
    expect(stored.licenseType).toBe('FREE');
    expect(stored.services).toBeDefined();
  });

  it('follows a change after the memo is cleared', async () => {
    registerDefaultEntitlementsProvider(() => ({ services: { allow: ['models'] } }));
    expect((await getDisabledServices('t1')).has('rag')).toBe(true);
    registerDefaultEntitlementsProvider(() => null);
    expect((await getDisabledServices('t1')).has('rag')).toBe(true);
    clearServiceAvailabilityMemo();
    expect((await getDisabledServices('t1')).has('rag')).toBe(false);
  });
});
