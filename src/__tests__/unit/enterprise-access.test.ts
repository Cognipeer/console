import { afterEach, describe, expect, it } from 'vitest';
import {
  getConfigSource,
  setConfigSource,
  type ConfigSource,
} from '@/lib/core/config';
import {
  checkEnterpriseApiAccess,
  getEnterpriseModuleForPath,
} from '@/lib/license/enterprise-access';
import { LicenseManager } from '@/lib/license/license-manager';

const original = getConfigSource();

/** A ConfigSource that forces specific keys, falling back to process env. */
function sourceWith(overrides: Record<string, string>): ConfigSource {
  return {
    get: (key: string) => overrides[key] ?? process.env[key],
  } as ConfigSource;
}

afterEach(() => {
  setConfigSource(original);
});

describe('getEnterpriseModuleForPath', () => {
  it('maps gpu-fleet / sandbox / cluster admin paths to their module', () => {
    expect(getEnterpriseModuleForPath('/api/gpu-fleet/hosts')).toBe('gpu-fleet');
    expect(getEnterpriseModuleForPath('/api/gpu-fleet/pools')).toBe('gpu-fleet');
    expect(getEnterpriseModuleForPath('/api/sandbox/runners')).toBe('sandbox');
    expect(getEnterpriseModuleForPath('/api/cluster/overview')).toBe('cluster');
    expect(getEnterpriseModuleForPath('/api/prompt-optimizer/runs')).toBe('prompt-optimizer');
  });

  it('does not gate community paths', () => {
    expect(getEnterpriseModuleForPath('/api/js-sandbox/runtimes')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/models')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/rag/documents')).toBeNull();
  });

  it('exempts machine/self-serve sub-paths', () => {
    expect(getEnterpriseModuleForPath('/api/gpu-fleet/installer.sh')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/gpu-fleet/agent-bundle/x.tar.gz')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/sandbox/agent/heartbeat')).toBeNull();
  });
});

describe('checkEnterpriseApiAccess', () => {
  it('is a no-op when ENFORCE_LICENSE is off', () => {
    setConfigSource(sourceWith({ ENFORCE_LICENSE: 'false' }));
    expect(checkEnterpriseApiAccess('/api/gpu-fleet/hosts', 'FREE')).toBeNull();
  });

  it('denies FREE on an enterprise path when enforcing', () => {
    setConfigSource(sourceWith({ ENFORCE_LICENSE: 'true' }));
    const denial = checkEnterpriseApiAccess('/api/gpu-fleet/hosts', 'FREE');
    expect(denial?.status).toBe(402);
    expect(denial?.body.module).toBe('gpu-fleet');
  });

  it('allows ENTERPRISE on an enterprise path when enforcing', () => {
    setConfigSource(sourceWith({ ENFORCE_LICENSE: 'true' }));
    expect(checkEnterpriseApiAccess('/api/gpu-fleet/hosts', 'ENTERPRISE')).toBeNull();
  });

  it('never gates community paths even when enforcing', () => {
    setConfigSource(sourceWith({ ENFORCE_LICENSE: 'true' }));
    expect(checkEnterpriseApiAccess('/api/models', 'FREE')).toBeNull();
  });
});

describe('LicenseManager.isEnterpriseActive', () => {
  it('only treats ENTERPRISE as enterprise', () => {
    expect(LicenseManager.isEnterpriseActive('ENTERPRISE')).toBe(true);
    expect(LicenseManager.isEnterpriseActive('FREE')).toBe(false);
    expect(LicenseManager.isEnterpriseActive('PROFESSIONAL')).toBe(false);
  });

  it('honours expiry with the configured grace window', () => {
    setConfigSource(sourceWith({ LICENSE_GRACE_DAYS: '7' }));
    const longGone = new Date(Date.now() - 30 * 86_400_000);
    const yesterday = new Date(Date.now() - 1 * 86_400_000);
    expect(LicenseManager.isEnterpriseActive('ENTERPRISE', longGone)).toBe(false);
    expect(LicenseManager.isEnterpriseActive('ENTERPRISE', yesterday)).toBe(true); // within grace
  });
});
