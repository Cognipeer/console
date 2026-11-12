/**
 * Smaller MCP gateway safeguards: tool names in an agent run, exact package
 * versions for stdio servers, the caller-header allowlist, publishing at the
 * public URL, the security fields of a server update, the approval settings
 * of a renamed tool, and the Security tab's helpers.
 */
import { describe, expect, it, vi } from 'vitest';

import { exposedMcpToolNames } from '@/lib/services/agents/boundToolNames';
import { applyToolApprovals, resolveHitlConfig } from '@/lib/services/agents/agentHumanInTheLoop';
import { MCP_PROTECTION_GUARDRAIL_KEY as ENGINE_KEY } from '@/lib/services/guardrail/hooks/engine';
import { pinnedPackageSpecError } from '@/lib/services/mcp/stdioRunner';
import { mcpRuntimeHeaderPolicyError, resolveRuntimeHeaders } from '@/lib/services/runtimeContext';
import { publishesPublicly, readMcpSecurityUpdate } from '@/server/api/plugins/mcp-shared';
import { lineDiff } from '@/components/mcp/lineDiff';
import { MCP_PROTECTION_GUARDRAIL_KEY, withMcpProtectionOption } from '@/components/mcp/mcpProtectionOption';

describe('MCP tool names in an agent run', () => {
  it('keeps a unique name and gives clashing ones their server key', () => {
    expect(exposedMcpToolNames(
      [
        { serverKey: 'github', name: 'search' },
        { serverKey: 'jira', name: 'search' },
        { serverKey: 'jira', name: 'create_issue' },
      ],
      [],
    )).toEqual(['github__search', 'jira__search', 'create_issue']);
  });

  it('never shadows a tool that is not an MCP tool', () => {
    expect(exposedMcpToolNames([{ serverKey: 'files', name: 'web_search' }], ['web_search'])).toEqual(['files__web_search']);
  });

  it('makes an invalid or overlong name valid, and keeps every name unique', () => {
    const [dotted] = exposedMcpToolNames([{ serverKey: 'docs', name: 'pages.read' }], []);
    expect(dotted).toBe('docs__pages_read');
    const long = exposedMcpToolNames([{ serverKey: 'k'.repeat(40), name: 'n'.repeat(40) }], []);
    expect(long[0]).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    const twins = exposedMcpToolNames([{ serverKey: 'a', name: 'x' }, { serverKey: 'a', name: 'x' }], []);
    expect(new Set(twins).size).toBe(2);
  });
});

describe('stdio package pinning', () => {
  it('accepts exact versions', () => {
    for (const spec of ['@scope/server@1.2.3', 'server-x@0.4.0-beta.1']) {
      expect(pinnedPackageSpecError(spec, 'npx'), spec).toBeUndefined();
    }
    for (const spec of ['mcp-server-fetch==2025.4.7', 'pkg[extra]==1.0.0', 'pkg==1.2.3rc1']) {
      expect(pinnedPackageSpecError(spec, 'uvx'), spec).toBeUndefined();
    }
  });

  it('refuses ranges, tags and missing versions', () => {
    for (const spec of ['@scope/server', '@scope/server@latest', 'server@^1.2.3', 'server@1.x']) {
      expect(pinnedPackageSpecError(spec, 'npx'), spec).toMatch(/exact version|not a valid/);
    }
    for (const spec of ['mcp-server-fetch', 'pkg>=1.0', 'pkg~=1.0']) {
      expect(pinnedPackageSpecError(spec, 'uvx'), spec).toMatch(/exact version|not a valid/);
    }
  });
});

describe('caller headers for MCP servers', () => {
  const ctx = { headers: { 'X-Region': 'eu', Authorization: 'Bearer caller' } };

  it('passes only listed names, and nothing when no list is set', () => {
    expect(resolveRuntimeHeaders(ctx, 'mcp', 'crm', { allow: true, allowedNames: ['X-Region'] })).toEqual({ 'X-Region': 'eu' });
    expect(resolveRuntimeHeaders(ctx, 'mcp', 'crm', { allow: true })).toBeUndefined();
  });

  it('validates the policy a server is saved with', () => {
    expect(mcpRuntimeHeaderPolicyError(undefined)).toBeUndefined();
    expect(mcpRuntimeHeaderPolicyError(null)).toBeUndefined();
    expect(mcpRuntimeHeaderPolicyError({ allow: true, allowedNames: ['X-Region'] })).toBeUndefined();
    expect(mcpRuntimeHeaderPolicyError({ allow: true })).toBeDefined();
    expect(mcpRuntimeHeaderPolicyError({ allow: true, allowedNames: ['Host'] })).toBeDefined();
    expect(mcpRuntimeHeaderPolicyError({ allow: true, allowedNames: ['bad header'] })).toBeDefined();
    expect(mcpRuntimeHeaderPolicyError({ allow: 'yes' })).toBeDefined();
  });
});

describe('publishing at the public URL', () => {
  const tokenOnly = { exposure: { accessMode: 'token' }, endpointSlug: 'crm' } as never;
  const published = { exposure: { accessMode: 'public' }, endpointSlug: 'crm' } as never;

  it('is a publish when a server becomes public or a public one moves to another URL', () => {
    expect(publishesPublicly({ exposure: { accessMode: 'public' } })).toBe(true);
    expect(publishesPublicly({ exposure: { accessMode: 'public' } }, tokenOnly)).toBe(true);
    expect(publishesPublicly({ endpointSlug: 'crm-2' }, published)).toBe(true);
  });

  it('is not a publish otherwise', () => {
    expect(publishesPublicly({})).toBe(false);
    expect(publishesPublicly({ name: 'CRM' }, published)).toBe(false);
    expect(publishesPublicly({ endpointSlug: 'crm' }, published)).toBe(false);
    expect(publishesPublicly({ exposure: { accessMode: 'token' } }, published)).toBe(false);
  });
});

describe('security fields of a server update', () => {
  const scope = { tenantDbName: 'tenant_acme', projectId: 'proj-1' };

  it('reads valid fields', async () => {
    await expect(readMcpSecurityUpdate({
      runtimeHeaders: { allow: true, allowedNames: [' X-Region '] },
      piiPassthroughTools: ['send_mail'],
      toolChangePolicy: 'notify',
      toolReview: { approve: ['a'] },
    }, scope)).resolves.toEqual({
      fields: {
        runtimeHeaders: { allow: true, allowedNames: ['X-Region'] },
        piiPassthroughTools: ['send_mail'],
        toolChangePolicy: 'notify',
        toolReview: { approve: ['a'] },
      },
    });
    await expect(readMcpSecurityUpdate({ piiProtection: null }, scope)).resolves.toEqual({ fields: { piiProtection: null } });
    const hash = 'a'.repeat(64);
    await expect(readMcpSecurityUpdate({ toolReview: { reject: [{ name: 'b', hash, extra: 1 }, 'c'] } }, scope)).resolves.toEqual({
      fields: { toolReview: { reject: [{ name: 'b', hash }, 'c'] } },
    });
  });

  it('refuses malformed fields', async () => {
    for (const body of [
      { runtimeHeaders: { allow: true } },
      { piiPassthroughTools: 'send_mail' },
      { toolChangePolicy: 'never' },
      { toolReview: { approve: 'a' } },
      { toolReview: [] },
      { toolReview: { approve: [{ name: 'a' }] } },
      { toolReview: { approve: [{ name: 'a', hash: 'not-a-hash' }] } },
      { toolReview: { approve: [7] } },
      { piiProtection: { policyKey: '' } },
    ]) {
      expect(await readMcpSecurityUpdate(body, scope), JSON.stringify(body)).toHaveProperty('error');
    }
  });
});

describe('approval settings of a renamed MCP tool', () => {
  it('are looked up under the tool’s own name', () => {
    const resolved = resolveHitlConfig({ toolApproval: { enabled: true, defaultPolicy: 'never', tools: { search: 'always' } } });
    const [renamed] = applyToolApprovals(
      [{ name: 'jira__search', hitlPolicyName: 'search', func: vi.fn() } as { name: string; hitlPolicyName: string; func: () => void; needsApproval?: unknown }],
      resolved,
      new Set(),
    );
    expect((renamed.needsApproval as (args: unknown) => boolean)({})).toBe(true);
  });
});

describe('Security tab helpers', () => {
  it('mirror the managed preset key and offer it before it exists', () => {
    expect(MCP_PROTECTION_GUARDRAIL_KEY).toBe(ENGINE_KEY);
    const data = withMcpProtectionOption([{ value: '__default__', label: 'Default' }, { value: 'mine', label: 'Mine' }]);
    expect(data.map((item) => item.value)).toEqual(['__default__', MCP_PROTECTION_GUARDRAIL_KEY, 'mine']);
    const listed = [{ value: MCP_PROTECTION_GUARDRAIL_KEY, label: 'MCP protection' }];
    expect(withMcpProtectionOption(listed)).toBe(listed);
  });

  it('diff two definitions by line', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
    expect(lineDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
    const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
    expect(lineDiff(big.join('\n'), big.map((line) => `${line}!`).join('\n'))).toBeNull();
  });
});
