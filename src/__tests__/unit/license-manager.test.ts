/**
 * Unit tests — LicenseManager
 * Covers: feature lookup, endpoint access, license tier boundaries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { getConfig } from '@/lib/core/config';
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

  describe('plan claim', () => {
    const plan = {
      id: 'team',
      name: 'Team',
      seats: { console: 3 },
      limits: { apiRequestsPerMinute: 120, monthly: { searches: 500 } },
    };
    const tenant = (licenseExpiresAt?: Date) => ({
      _id: 'tenant-1',
      licenseId: 'lic-1',
      licensePayload: { licenseId: 'lic-1', licenseType: 'ENTERPRISE', plan },
      licenseStatus: 'active',
      licenseType: 'ENTERPRISE',
      licenseExpiresAt,
    }) as never;

    it('exposes the stored plan on an active license', () => {
      const license = LicenseManager.getEffectiveLicenseForTenant(tenant(new Date(Date.now() + 86_400_000)));
      expect(license.status).toBe('active');
      expect(license.plan).toEqual(plan);
    });

    it('has no plan when the license carries none', () => {
      const license = LicenseManager.getEffectiveLicenseForTenant({
        _id: 'tenant-1',
        licenseId: 'lic-1',
        licensePayload: { licenseId: 'lic-1', licenseType: 'ENTERPRISE' },
        licenseStatus: 'active',
        licenseType: 'ENTERPRISE',
      } as never);
      expect(license.plan).toBeUndefined();
    });

    it('reads a malformed stored plan as absent instead of throwing', () => {
      const license = LicenseManager.getEffectiveLicenseForTenant({
        _id: 'tenant-1',
        licenseId: 'lic-1',
        licensePayload: { licenseId: 'lic-1', licenseType: 'ENTERPRISE', plan: { id: '' } },
        licenseStatus: 'active',
        licenseType: 'ENTERPRISE',
      } as never);
      expect(license.status).toBe('active');
      expect(license.plan).toBeUndefined();
    });

    it('drops the plan when the license has expired', () => {
      const license = LicenseManager.getEffectiveLicenseForTenant(tenant(new Date(Date.now() - 86_400_000)));
      expect(license.status).toBe('expired');
      expect(license.plan).toBeUndefined();
    });

    describe('activation', () => {
      let privateKey: CryptoKey;

      beforeEach(async () => {
        const pair = await generateKeyPair('ES256', { extractable: true });
        privateKey = pair.privateKey as CryptoKey;
        const publicKeyPem = await exportSPKI(pair.publicKey);
        vi.spyOn(LicenseManager as unknown as { getPublicKeyPem(): string | null }, 'getPublicKeyPem').mockReturnValue(
          publicKeyPem,
        );
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      async function sign(extra: Record<string, unknown>): Promise<string> {
        const { issuer, audience } = getConfig().license;
        return new SignJWT({
          licenseId: 'lic-1',
          licenseType: 'ENTERPRISE',
          tenantId: 'tenant-1',
          ...extra,
        })
          .setProtectedHeader({ alg: 'ES256' })
          .setIssuer(issuer)
          .setAudience(audience)
          .setIssuedAt()
          .setExpirationTime('30d')
          .sign(privateKey);
      }

      const tenantRef = { _id: 'tenant-1', slug: 'example' } as never;

      it('keeps a valid plan claim (and ignores unknown keys inside it)', async () => {
        const verified = await LicenseManager.verifyOfflineLicenseKey(
          await sign({ plan: { ...plan, futureKey: 1 } }),
          tenantRef,
        );
        expect(verified.plan).toEqual(plan);
        expect(verified.payload?.plan).toEqual(plan);
      });

      it('activates a license with no plan claim', async () => {
        const verified = await LicenseManager.verifyOfflineLicenseKey(await sign({}), tenantRef);
        expect(verified.status).toBe('active');
        expect(verified.plan).toBeUndefined();
      });

      it('rejects a malformed plan claim, naming the field', async () => {
        await expect(
          LicenseManager.verifyOfflineLicenseKey(
            await sign({ plan: { id: 'team', seats: { console: -2 } } }),
            tenantRef,
          ),
        ).rejects.toThrow(/plan\.seats\.console/);
      });
    });
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

// ── verifyIssuerSignedToken ──────────────────────────────────────────────────

describe('LicenseManager.verifyIssuerSignedToken', () => {
  const AUD = 'example-other-audience';
  let privateKey: CryptoKey;

  beforeEach(async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    privateKey = pair.privateKey as CryptoKey;
    const publicKeyPem = await exportSPKI(pair.publicKey);
    vi.spyOn(LicenseManager as unknown as { getPublicKeyPem(): string | null }, 'getPublicKeyPem').mockReturnValue(
      publicKeyPem,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function sign(
    opts: { audience?: string; issuer?: string; exp?: number | null; key?: CryptoKey } = {},
  ): Promise<string> {
    const jwt = new SignJWT({ typ: 'example', n: 1 })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(opts.issuer ?? getConfig().license.issuer)
      .setAudience(opts.audience ?? AUD)
      .setIssuedAt();
    if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? '1d');
    return jwt.sign(opts.key ?? privateKey);
  }

  it('returns the payload of a token signed for the given audience', async () => {
    const payload = await LicenseManager.verifyIssuerSignedToken(await sign(), AUD);
    expect(payload).toMatchObject({ typ: 'example', n: 1, aud: AUD });
  });

  it('rejects a token for another audience', async () => {
    await expect(
      LicenseManager.verifyIssuerSignedToken(await sign({ audience: 'something-else' }), AUD),
    ).rejects.toThrow();
  });

  it('refuses the license audience, so a license is never accepted as another token', async () => {
    const licenseAudience = getConfig().license.audience;
    await expect(
      LicenseManager.verifyIssuerSignedToken(await sign({ audience: licenseAudience }), licenseAudience),
    ).rejects.toThrow(/audience/);
  });

  it('rejects a token from another issuer', async () => {
    await expect(
      LicenseManager.verifyIssuerSignedToken(await sign({ issuer: 'someone-else' }), AUD),
    ).rejects.toThrow();
  });

  it('requires exp and rejects an expired token', async () => {
    await expect(LicenseManager.verifyIssuerSignedToken(await sign({ exp: null }), AUD)).rejects.toThrow();
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(LicenseManager.verifyIssuerSignedToken(await sign({ exp: past }), AUD)).rejects.toThrow();
  });

  it('rejects a token signed with another key', async () => {
    const other = await generateKeyPair('ES256', { extractable: true });
    await expect(
      LicenseManager.verifyIssuerSignedToken(await sign({ key: other.privateKey as CryptoKey }), AUD),
    ).rejects.toThrow();
  });

  it('rejects an empty token', async () => {
    await expect(LicenseManager.verifyIssuerSignedToken('  ', AUD)).rejects.toThrow(/required/);
  });
});
