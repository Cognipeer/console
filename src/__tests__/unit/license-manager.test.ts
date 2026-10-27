/**
 * Unit tests — LicenseManager
 * Covers: feature lookup, endpoint access, license tier boundaries.
 */

import { describe, it, expect } from 'vitest';
import { LicenseManager, type LicenseType } from '@/lib/license/license-manager';

// ── getFeaturesForLicense ────────────────────────────────────────────────────

describe('LicenseManager.getFeaturesForLicense', () => {
  const tiers: LicenseType[] = ['FREE', 'STARTER', 'PROFESSIONAL', 'ENTERPRISE', 'ON_PREMISE'];

  it.each(tiers)('%s tier returns a non-empty feature array', (tier) => {
    const features = LicenseManager.getFeaturesForLicense(tier);
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBeGreaterThan(0);
  });

  it('returns empty array for an unknown license type', () => {
    const features = LicenseManager.getFeaturesForLicense('UNKNOWN' as LicenseType);
    expect(features).toEqual([]);
  });

  it('FREE tier includes core features', () => {
    const features = LicenseManager.getFeaturesForLicense('FREE');
    expect(features).toContain('LLM_CHAT');
    expect(features).toContain('MODEL_MANAGEMENT');
    expect(features).toContain('AGENT_TRACING');
    expect(features).toContain('VECTOR_STORE');
  });
});

// ── hasFeature ───────────────────────────────────────────────────────────────

describe('LicenseManager.hasFeature', () => {
  it('returns true for a feature the license has', () => {
    expect(LicenseManager.hasFeature('FREE', 'LLM_CHAT')).toBe(true);
  });

  it('returns false for a feature the license does NOT have', () => {
    // If a made-up feature is not in any tier it should be false
    expect(LicenseManager.hasFeature('FREE', 'NONEXISTENT_FEATURE')).toBe(false);
  });

  it('is case-sensitive (correct key must be used)', () => {
    expect(LicenseManager.hasFeature('FREE', 'llm_chat' as never)).toBe(false);
  });
});

// ── hasEndpointAccess ────────────────────────────────────────────────────────

describe('LicenseManager.hasEndpointAccess', () => {
  it('grants access to endpoints covered by license features', () => {
    expect(LicenseManager.hasEndpointAccess('FREE', '/api/models')).toBe(true);
    expect(LicenseManager.hasEndpointAccess('FREE', '/api/models/some-model')).toBe(true);
  });

  it('grants access to wildcard sub-paths', () => {
    // AGENT_TRACING covers /api/tracing/*
    expect(LicenseManager.hasEndpointAccess('FREE', '/api/tracing/sessions')).toBe(true);
    expect(LicenseManager.hasEndpointAccess('FREE', '/api/tracing/sessions/abc/events')).toBe(true);
  });

  it('denies access to endpoints not covered by any feature', () => {
    expect(LicenseManager.hasEndpointAccess('FREE', '/api/completely-unknown-endpoint')).toBe(false);
  });

  it('exact endpoint match works', () => {
    expect(LicenseManager.hasEndpointAccess('FREE', '/api/models')).toBe(true);
  });
});

// ── Cross-tier escalation ────────────────────────────────────────────────────

describe('License tier escalation', () => {
  const featureTierPairs: Array<[LicenseType, string]> = [
    ['FREE', 'LLM_CHAT'],
    ['FREE', 'VECTOR_STORE'],
    ['FREE', 'AGENT_TRACING'],
  ];

  it.each(featureTierPairs)(
    'tier %s has feature %s',
    (tier, feature) => {
      expect(LicenseManager.hasFeature(tier, feature)).toBe(true);
    },
  );
});

// ── Offline license limits ───────────────────────────────────────────────────

describe('LicenseManager.getEffectiveLicenseForTenant', () => {
  it('only applies project limits from active offline licenses', () => {
    const license = LicenseManager.getEffectiveLicenseForTenant({
      _id: 'tenant-1',
      licenseId: 'lic-1',
      licensePayload: {
        licenseId: 'lic-1',
        licenseType: 'ENTERPRISE',
        limits: {
          maxApiTokens: 12,
          maxProjects: 8,
        },
      },
      licenseStatus: 'active',
      licenseType: 'ENTERPRISE',
    } as never);

    expect(license.limits.maxProjects).toBe(8);
    expect((license.limits as Record<string, unknown>).maxApiTokens).toBeUndefined();
    expect((license.limits as Record<string, unknown>).quotas).toBeUndefined();
  });

  it('accepts legacy nested quota payloads without exposing limits.quotas', () => {
    const license = LicenseManager.getEffectiveLicenseForTenant({
      _id: 'tenant-1',
      licenseId: 'lic-1',
      licensePayload: {
        licenseId: 'lic-1',
        licenseType: 'ENTERPRISE',
        limits: {
          quotas: {
            maxProjects: 10,
          },
        },
      },
      licenseStatus: 'active',
      licenseType: 'ENTERPRISE',
    } as never);

    expect(license.limits.maxProjects).toBe(10);
    expect((license.limits as Record<string, unknown>).quotas).toBeUndefined();
  });

  describe('licenseExpiresAt that is not a Date (a tenant read back from the Redis auth cache)', () => {
    const tenant = (licenseExpiresAt: unknown) => ({
      _id: 'tenant-1',
      licenseId: 'lic-1',
      licensePayload: { licenseId: 'lic-1', licenseType: 'ENTERPRISE' },
      licenseStatus: 'active',
      licenseType: 'ENTERPRISE',
      licenseExpiresAt,
    }) as never;
    const future = new Date(Date.now() + 365 * 86_400_000);
    const past = new Date(Date.now() - 86_400_000);

    it.each([
      ['ISO string', future.toISOString()],
      ['epoch milliseconds', future.getTime()],
    ])('keeps an unexpired license active when the expiry is an %s', (_label, value) => {
      const license = LicenseManager.getEffectiveLicenseForTenant(tenant(value));
      expect(license.status).toBe('active');
      expect(license.expiresAt?.getTime()).toBe(future.getTime());
    });

    it('still expires a license whose string expiry is in the past', () => {
      const license = LicenseManager.getEffectiveLicenseForTenant(tenant(past.toISOString()));
      expect(license.status).toBe('expired');
    });

    it('ignores an unparseable expiry instead of throwing', () => {
      const license = LicenseManager.getEffectiveLicenseForTenant(tenant('not-a-date'));
      expect(license.status).toBe('active');
      expect(license.expiresAt).toBeUndefined();
    });

    it('treats an empty-string expiry as no expiry', () => {
      const license = LicenseManager.getEffectiveLicenseForTenant(tenant(''));
      expect(license.status).toBe('active');
      expect(license.expiresAt).toBeUndefined();
    });
  });
});
