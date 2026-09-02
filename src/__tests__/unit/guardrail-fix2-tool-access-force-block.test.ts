/**
 * Review finding #9 — a policy's `denyPrivateNetworks: true` was a SILENT
 * NO-OP under `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=false` or an allowlisted
 * host.
 *
 * `tool_access` called `assertPublicUrl` with no way to insist, and the guard
 * returned early before any resolution. A self-hosted deployment that turns
 * the global block off so its rerankers can reach in-network services thereby
 * turned every tenant's `denyPrivateNetworks` tool policy off — no finding,
 * no degraded entry, and the policy editor still showing it on.
 *
 * Now the family passes `{ forceBlock: true }`: the deployment switches say
 * what the CONSOLE may reach; the policy says what a TOOL may reach.
 *
 * Every target below is an IP LITERAL so the assertions are hermetic — the
 * guard classifies it without a DNS lookup.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { runToolAccessPolicy } from '@/lib/services/guardrail/families/toolAccess';
import { toolCallSubject } from '@/lib/services/guardrail/hooks/contract';
import type { HookScope, ToolAccessPolicyConfig } from '@/lib/services/guardrail/hooks/contract';

const original = getConfigSource();

function sourceWith(overrides: Record<string, string>): ConfigSource {
  return { get: (key: string) => overrides[key] ?? process.env[key] } as ConfigSource;
}

const scope: HookScope = {
  tenantId: 'tenant-a',
  tenantDbName: 't_tenant_a',
  actor: { id: 'u1', kind: 'user', roles: ['developer'] },
  surface: 'sandbox',
  source: 'unit-test',
  traceId: 'trace-force-block',
};

const TOOL = 'sandbox.git.clone';

function policy(overrides: Partial<ToolAccessPolicyConfig> = {}): ToolAccessPolicyConfig {
  return {
    id: 'tp1',
    family: 'tool_access',
    enabled: true,
    hooks: ['tool.pre'],
    schedule: { timing: 'sync', onFail: 'block' },
    urlArgPaths: { [TOOL]: ['url'] },
    denyPrivateNetworks: true,
    // 'read' so the side-effect rule does not add a finding of its own.
    sideEffects: { [TOOL]: 'read' },
    ...overrides,
  };
}

async function evaluate(config: ToolAccessPolicyConfig, url: string) {
  const outcome = await runToolAccessPolicy({
    policy: config,
    hook: 'tool.pre',
    subject: toolCallSubject({ toolName: TOOL, args: { url }, providerRef: 'sandbox:test', sandboxAvailable: true }),
    scope,
    action: 'block',
  });
  return {
    codes: outcome.findings.map((finding) => finding.category),
    degraded: outcome.degraded ?? [],
  };
}

beforeEach(() => {
  setConfigSource(sourceWith({}));
});

afterEach(() => {
  setConfigSource(original);
});

describe('tool_access denyPrivateNetworks is enforced regardless of deployment egress settings', () => {
  it('fires under OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=false', async () => {
    setConfigSource(sourceWith({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' }));
    const { codes, degraded } = await evaluate(policy(), 'http://10.0.0.5/admin');
    expect(codes).toContain('egress_private_network');
    expect(degraded).toEqual([]);
  });

  it('fires for the cloud metadata address under the same setting', async () => {
    setConfigSource(sourceWith({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' }));
    const { codes } = await evaluate(policy(), 'http://169.254.169.254/latest/meta-data/');
    expect(codes).toContain('egress_private_network');
  });

  it('fires for a host on OUTBOUND_HTTP_ALLOWED_HOSTS', async () => {
    setConfigSource(sourceWith({ OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5' }));
    const { codes } = await evaluate(policy(), 'http://10.0.0.5/admin');
    expect(codes).toContain('egress_private_network');
  });

  it('fires for a DISCOVERED url argument too, not only a declared one', async () => {
    setConfigSource(sourceWith({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' }));
    const { codes } = await evaluate(policy({ urlArgPaths: undefined }), 'http://192.168.1.10/');
    expect(codes).toContain('egress_private_network');
  });

  it('still passes a public target, and stays quiet when the policy does not ask', async () => {
    setConfigSource(sourceWith({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' }));
    expect((await evaluate(policy(), 'https://93.184.216.34/repo.git')).codes).not.toContain('egress_private_network');
    expect((await evaluate(policy({ denyPrivateNetworks: false }), 'http://10.0.0.5/admin')).codes).not.toContain(
      'egress_private_network',
    );
  });
});
