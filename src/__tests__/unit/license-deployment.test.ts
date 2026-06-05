import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  getConfigSource,
  setConfigSource,
  type ConfigSource,
} from '@/lib/core/config';
import { LicenseManager } from '@/lib/license/license-manager';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;

const original = getConfigSource();

async function sign(payload: Record<string, unknown>, exp = '30d'): Promise<string> {
  const pk = await importPKCS8(privatePem, 'EdDSA');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setIssuer('cognipeer')
    .setAudience('cognipeer-console')
    .setExpirationTime(exp)
    .sign(pk);
}

function configure(overrides: Record<string, string>): void {
  const base: Record<string, string> = {
    OFFLINE_LICENSE_PUBLIC_KEY: publicPem,
    LICENSE_TENANT_SLUG: 'dev',
    LICENSE_GRACE_DAYS: '0',
  };
  const merged = { ...base, ...overrides };
  setConfigSource({ get: (k: string) => merged[k] ?? process.env[k] } as ConfigSource);
}

let good: string;
let wrongTenant: string;
let freeType: string;
let expired: string;

beforeAll(async () => {
  good = await sign({ licenseId: 'dev', licenseType: 'ENTERPRISE', tenantSlug: 'dev' });
  wrongTenant = await sign({ licenseId: 'x', licenseType: 'ENTERPRISE', tenantSlug: 'other' });
  freeType = await sign({ licenseId: 'y', licenseType: 'FREE', tenantSlug: 'dev' });
  expired = await sign({ licenseId: 'z', licenseType: 'ENTERPRISE', tenantSlug: 'dev' }, '-1d');
});

afterEach(() => setConfigSource(original));

describe('LicenseManager.verifyDeploymentLicense', () => {
  it('no LICENSE_KEY → inactive (no-key)', async () => {
    configure({ LICENSE_KEY: '' });
    expect(await LicenseManager.verifyDeploymentLicense()).toMatchObject({ active: false, reason: 'no-key' });
  });

  it('valid ENTERPRISE bound to the tenant → active (ok)', async () => {
    configure({ LICENSE_KEY: good });
    const r = await LicenseManager.verifyDeploymentLicense();
    expect(r).toMatchObject({ active: true, reason: 'ok', licenseId: 'dev', tenantSlug: 'dev' });
  });

  it('tenant slug mismatch → inactive (tenant-mismatch)', async () => {
    configure({ LICENSE_KEY: wrongTenant });
    expect(await LicenseManager.verifyDeploymentLicense()).toMatchObject({ active: false, reason: 'tenant-mismatch' });
  });

  it('non-ENTERPRISE license → inactive (not-enterprise)', async () => {
    configure({ LICENSE_KEY: freeType });
    expect(await LicenseManager.verifyDeploymentLicense()).toMatchObject({ active: false, reason: 'not-enterprise' });
  });

  it('expired with grace=0 → inactive (expired)', async () => {
    configure({ LICENSE_KEY: expired, LICENSE_GRACE_DAYS: '0' });
    expect(await LicenseManager.verifyDeploymentLicense()).toMatchObject({ active: false, reason: 'expired' });
  });

  it('expired within grace window → active (grace)', async () => {
    configure({ LICENSE_KEY: expired, LICENSE_GRACE_DAYS: '10' });
    expect(await LicenseManager.verifyDeploymentLicense()).toMatchObject({ active: true, reason: 'grace' });
  });

  it('tampered token → inactive (invalid-signature)', async () => {
    configure({ LICENSE_KEY: `${good}tampered` });
    expect(await LicenseManager.verifyDeploymentLicense()).toMatchObject({ active: false, reason: 'invalid-signature' });
  });
});
