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
    // Bare collection path (list/create) must be gated too, not only '/…/' sub-paths.
    expect(getEnterpriseModuleForPath('/api/prompt-optimizer')).toBe('prompt-optimizer');
    expect(getEnterpriseModuleForPath('/api/gpu-fleet')).toBe('gpu-fleet');
    expect(getEnterpriseModuleForPath('/api/prompt-optimizerx')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/reports/dashboard')).toBe('reports');
  });

  it('gates the connectors API, bare collection path included', () => {
    expect(getEnterpriseModuleForPath('/api/connectors')).toBe('connectors');
    expect(getEnterpriseModuleForPath('/api/connectors/abc/accounts')).toBe('connectors');
    expect(getEnterpriseModuleForPath('/api/connectors/oauth/callback')).toBe('connectors');
    expect(getEnterpriseModuleForPath('/api/connectorsx')).toBeNull();
  });

  it('gates the portal admin API and the end-user runtime, bare collection path included', () => {
    expect(getEnterpriseModuleForPath('/api/portals')).toBe('portals');
    expect(getEnterpriseModuleForPath('/api/portals/abc123/stats')).toBe('portals');
    expect(getEnterpriseModuleForPath('/api/portals/agent-options')).toBe('portals');
    expect(getEnterpriseModuleForPath('/api/portal/branch-assistant/info')).toBe('portals');
    expect(getEnterpriseModuleForPath('/api/portal/branch-assistant/agents')).toBe('portals');
    // Near-misses stay ungated.
    expect(getEnterpriseModuleForPath('/api/portalsx')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/portalish/foo')).toBeNull();
  });

  it('gates the channels admin API, bare collection paths included', () => {
    expect(getEnterpriseModuleForPath('/api/channels')).toBe('channels');
    expect(getEnterpriseModuleForPath('/api/channels/connections')).toBe('channels');
    expect(getEnterpriseModuleForPath('/api/channels/connections/abc/deployments')).toBe('channels');
    // The public Teams webhook checks the licence in-handler (public prefix); near-misses stay ungated.
    expect(getEnterpriseModuleForPath('/api/public/channels/teams/t/c')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/channelsx')).toBeNull();
  });

  it('gates the entity health API, bare collection path included', () => {
    expect(getEnterpriseModuleForPath('/api/entity-health')).toBe('health');
    expect(getEnterpriseModuleForPath('/api/entity-health/summary')).toBe('health');
    expect(getEnterpriseModuleForPath('/api/entity-health/digests/config')).toBe('health');
    // The community tracing health reads (agents list and detail) stay on the tracing surface.
    expect(getEnterpriseModuleForPath('/api/tracing/agents/health')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/tracing/agents/pulse/health')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/entity-healthx')).toBeNull();
    expect(checkEnterpriseApiAccess('/api/entity-health/summary', 'FREE')?.body.module).toBe('health');
    expect(checkEnterpriseApiAccess('/api/entity-health/summary', 'ENTERPRISE')).toBeNull();
  });

  it('does not gate community paths', () => {
    expect(getEnterpriseModuleForPath('/api/models')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/rag/documents')).toBeNull();
  });

  it('maps every ai-app-gateway surface, including per-instance data-plane paths', () => {
    expect(getEnterpriseModuleForPath('/api/ai-app-gateway/gateways')).toBe('ai-app-gateway');
    expect(getEnterpriseModuleForPath('/api/client/v1/ai-app-gateway/gateways')).toBe('ai-app-gateway');
    // One prefix must cover an unbounded number of instances: the instance key
    // is a path segment beneath /api/appgw/.
    expect(getEnterpriseModuleForPath('/api/appgw/platform-team-a7f3k2/v1/messages')).toBe('ai-app-gateway');
    expect(getEnterpriseModuleForPath('/api/appgw/data-eng-91bc2f/v1/chat/completions')).toBe('ai-app-gateway');
    // Nothing outside the module's own prefixes may be captured by it.
    expect(getEnterpriseModuleForPath('/api/appgateway')).toBeNull();
  });

  it('exempts machine/self-serve sub-paths', () => {
    expect(getEnterpriseModuleForPath('/api/gpu-fleet/installer.sh')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/gpu-fleet/agent-bundle/x.tar.gz')).toBeNull();
    expect(getEnterpriseModuleForPath('/api/sandbox/agent/heartbeat')).toBeNull();
  });
});

describe('checkEnterpriseApiAccess', () => {
  it('denies FREE on an enterprise path', () => {
    const denial = checkEnterpriseApiAccess('/api/gpu-fleet/hosts', 'FREE');
    expect(denial?.status).toBe(402);
    expect(denial?.body.module).toBe('gpu-fleet');
  });

  it('allows ENTERPRISE on an enterprise path', () => {
    expect(checkEnterpriseApiAccess('/api/gpu-fleet/hosts', 'ENTERPRISE')).toBeNull();
  });

  it('never gates community paths', () => {
    expect(checkEnterpriseApiAccess('/api/models', 'FREE')).toBeNull();
  });

  it('blocks LDAP with 404 on SaaS even for an active ENTERPRISE license', () => {
    const denial = checkEnterpriseApiAccess('/api/ldap/config', 'ENTERPRISE', undefined, false);
    expect(denial?.status).toBe(404);
    expect(denial?.body).toMatchObject({ module: 'ldap', requiresOnPrem: true });
  });

  it('still requires ENTERPRISE for LDAP once onprem', () => {
    const denial = checkEnterpriseApiAccess('/api/ldap/config', 'FREE', undefined, true);
    expect(denial?.status).toBe(402);
    expect(denial?.body).toMatchObject({ module: 'ldap', requiresEnterprise: true });
  });

  it('allows LDAP only when both onprem and ENTERPRISE', () => {
    expect(checkEnterpriseApiAccess('/api/ldap/config', 'ENTERPRISE', undefined, true)).toBeNull();
  });

  it('does not require onprem for modules that never set requiresOnPrem', () => {
    expect(checkEnterpriseApiAccess('/api/gpu-fleet/hosts', 'ENTERPRISE', undefined, false)).toBeNull();
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
