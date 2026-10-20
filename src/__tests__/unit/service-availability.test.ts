/**
 * Unit tests — service switches (environment + license `services` claim).
 *
 * The claim is additive: a license without it (every license issued before it
 * existed) and an empty environment must leave every service on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { getConfig } from '@/lib/core/config';
import { LicenseManager, normalizeLicenseServiceClaim } from '@/lib/license/license-manager';
import { ALWAYS_ON_SERVICES, listSwitchableServices } from '@/lib/services/availability/catalog';
import {
  computeDisabledServices,
  ServiceDisabledError,
  unknownLicenseServiceIds,
  validateServiceSwitchConfig,
} from '@/lib/services/availability/serviceAvailability';

const NO_ENV = { disabled: [], enabled: [] };

function offIds(off: ReadonlyMap<string, unknown>): string[] {
  return [...off.keys()].sort();
}

describe('computeDisabledServices', () => {
  it('switches nothing off with an empty environment and no license claim', () => {
    expect(computeDisabledServices({ env: NO_ENV }).size).toBe(0);
    expect(computeDisabledServices({ env: NO_ENV, license: null }).size).toBe(0);
  });

  it('switches the listed services off from the environment', () => {
    const off = computeDisabledServices({ env: { disabled: ['browser', 'crawler'], enabled: [] } });
    expect(offIds(off)).toEqual(['browser', 'crawler']);
    expect(off.get('browser')).toEqual({ service: 'browser', source: 'env' });
  });

  it('keeps only the listed services on when the environment names an allow list', () => {
    const off = computeDisabledServices({ env: { disabled: [], enabled: ['models', 'agents'] } });
    expect(off.has('models')).toBe(false);
    expect(off.has('agents')).toBe(false);
    expect(off.get('rag')?.source).toBe('env');
  });

  it('applies the license allow and deny lists', () => {
    const allow = computeDisabledServices({ env: NO_ENV, license: { allow: ['models', 'agents', 'mcp'] } });
    expect(allow.has('agents')).toBe(false);
    expect(allow.get('rag')).toEqual({ service: 'rag', source: 'license' });

    const deny = computeDisabledServices({ env: NO_ENV, license: { deny: ['websearch'] } });
    expect(offIds(deny)).toEqual(['websearch']);
  });

  it('treats the environment as a ceiling a license cannot lift', () => {
    const off = computeDisabledServices({ env: { disabled: ['mcp'], enabled: [] }, license: { allow: ['models', 'mcp'] } });
    expect(off.get('mcp')?.source).toBe('env');
  });

  it('switches off what requires a switched-off service, to any depth', () => {
    const off = computeDisabledServices({ env: { disabled: ['models'], enabled: [] } });
    expect(off.get('agents')).toEqual({ service: 'agents', source: 'env', via: 'models' });
    expect(off.get('portals')).toEqual({ service: 'portals', source: 'env', via: 'agents' });
    expect(off.get('rag')?.via).toBe('models');
    // A service with no hard need keeps running.
    expect(off.has('mcp')).toBe(false);
  });

  it('never switches the administration services off', () => {
    const off = computeDisabledServices({ env: NO_ENV, license: { allow: ['models'] } });
    for (const service of ALWAYS_ON_SERVICES) expect(off.has(service)).toBe(false);
    expect(listSwitchableServices()).not.toContain('license');
  });

  it('ignores service ids it does not know', () => {
    const off = computeDisabledServices({ env: NO_ENV, license: { deny: ['some-future-service'] } });
    expect(off.size).toBe(0);
    expect(unknownLicenseServiceIds({ deny: ['some-future-service', 'mcp'] })).toEqual(['some-future-service']);
  });
});

describe('validateServiceSwitchConfig', () => {
  it('accepts an empty environment and known ids', () => {
    expect(validateServiceSwitchConfig(NO_ENV)).toEqual([]);
    expect(validateServiceSwitchConfig({ disabled: ['browser', 'mcp-hub'], enabled: [] })).toEqual([]);
  });

  it('reports an unknown id and an always-on id', () => {
    const errors = validateServiceSwitchConfig({ disabled: ['brwoser', 'license'], enabled: ['modles'] });
    expect(errors.map((error) => error.key)).toEqual([
      'CONSOLE_DISABLED_SERVICES',
      'CONSOLE_ENABLED_SERVICES',
      'CONSOLE_DISABLED_SERVICES',
    ]);
    expect(errors[0].message).toContain('brwoser');
    expect(errors[2].message).toContain('license');
  });
});

describe('ServiceDisabledError', () => {
  it('is a 403 service_disabled for the environment and a 402 service_not_licensed for the license', () => {
    const env = new ServiceDisabledError({ service: 'rag', source: 'env' });
    expect([env.status, env.statusCode, env.code]).toEqual([403, 403, 'service_disabled']);
    const license = new ServiceDisabledError({ service: 'agents', source: 'license', via: 'models' });
    expect([license.status, license.code]).toEqual([402, 'service_not_licensed']);
    expect(license.toBody()).toMatchObject({ code: 'service_not_licensed', service: 'agents', source: 'license', via: 'models' });
  });
});

describe('normalizeLicenseServiceClaim', () => {
  it('leaves a license without the claim unchanged', () => {
    expect(normalizeLicenseServiceClaim(undefined)).toBeUndefined();
    expect(normalizeLicenseServiceClaim(null)).toBeUndefined();
  });

  it('refuses an empty allow list rather than reading it as "nothing is allowed"', () => {
    expect(() => normalizeLicenseServiceClaim({ allow: [] })).toThrow(/at least one service/);
  });

  it('refuses a claim of the wrong shape', () => {
    expect(() => normalizeLicenseServiceClaim(['mcp'])).toThrow();
    expect(() => normalizeLicenseServiceClaim({ allow: 'mcp' })).toThrow();
    expect(() => normalizeLicenseServiceClaim({ deny: [1] })).toThrow();
  });

  it('trims, de-duplicates and drops an empty deny list', () => {
    expect(normalizeLicenseServiceClaim({ allow: [' models ', 'models', 'agents'], deny: [] })).toEqual({ allow: ['models', 'agents'] });
    expect(normalizeLicenseServiceClaim({ deny: [] })).toBeUndefined();
  });
});

// Every license issued before the claim existed has one of these two shapes
// (with or without `customerName`). Values are made up; the shapes are real.
const EXISTING_PAYLOAD_SHAPES = [
  { licenseId: 'ent-example-1', licenseType: 'ENTERPRISE', customerName: 'Example Co', tenantSlug: 'example' },
  { licenseId: 'ent-example-2', licenseType: 'ENTERPRISE', tenantSlug: 'example' },
];

describe('existing licenses keep every service on', () => {
  it.each(EXISTING_PAYLOAD_SHAPES)('stored license %#', (payload) => {
    const effective = LicenseManager.getEffectiveLicenseForTenant({
      _id: 'tenant-1',
      licenseStatus: 'active',
      licensePayload: payload,
      licenseType: 'ENTERPRISE',
      licenseId: payload.licenseId,
      licenseExpiresAt: new Date(Date.now() + 86_400_000),
    } as never);
    expect(effective.status).toBe('active');
    expect(effective.services).toBeUndefined();
    expect(computeDisabledServices({ env: NO_ENV, license: effective.services }).size).toBe(0);
  });

  describe('activation', () => {
    let publicKeyPem: string;
    let privateKey: CryptoKey;

    beforeEach(async () => {
      const pair = await generateKeyPair('ES256', { extractable: true });
      privateKey = pair.privateKey as CryptoKey;
      publicKeyPem = await exportSPKI(pair.publicKey);
      vi.spyOn(LicenseManager as unknown as { getPublicKeyPem(): string | null }, 'getPublicKeyPem').mockReturnValue(publicKeyPem);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function sign(payload: Record<string, unknown>): Promise<string> {
      const { issuer, audience } = getConfig().license;
      return new SignJWT(payload)
        .setProtectedHeader({ alg: 'ES256' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(privateKey);
    }

    it.each(EXISTING_PAYLOAD_SHAPES)('activates an existing license with no service switched off %#', async (payload) => {
      const verified = await LicenseManager.verifyOfflineLicenseKey(await sign(payload), { _id: 'tenant-1', slug: 'example' } as never);
      expect(verified.licenseType).toBe('ENTERPRISE');
      expect(verified.services).toBeUndefined();
      expect(computeDisabledServices({ env: NO_ENV, license: verified.services }).size).toBe(0);
    });

    it('activates a license that restricts services, and refuses one with an empty allow list', async () => {
      const verified = await LicenseManager.verifyOfflineLicenseKey(
        await sign({ ...EXISTING_PAYLOAD_SHAPES[1], services: { allow: ['models', 'agents'], deny: ['agents'] } }),
        { _id: 'tenant-1', slug: 'example' } as never,
      );
      expect(verified.services).toEqual({ allow: ['models', 'agents'], deny: ['agents'] });
      const off = computeDisabledServices({ env: NO_ENV, license: verified.services });
      expect(off.has('models')).toBe(false);
      expect(off.get('agents')?.source).toBe('license');

      await expect(LicenseManager.verifyOfflineLicenseKey(
        await sign({ ...EXISTING_PAYLOAD_SHAPES[1], services: { allow: [] } }),
        { _id: 'tenant-1', slug: 'example' } as never,
      )).rejects.toThrow(/at least one service/);
    });
  });
});
