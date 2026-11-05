/**
 * executeMcpTool is the one entry point of an MCP tool call (HTTP routes, agent
 * tools, flows): it checks the 'mcp' quota with the server key, before any
 * work, and a refusal is thrown as QuotaExceededError.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { enforceServiceQuota } = vi.hoisted(() => ({ enforceServiceQuota: vi.fn() }));

vi.mock('@/lib/quota/serviceQuota', () => ({ enforceServiceQuota }));

vi.mock('@/lib/database', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/database')>()),
  getDatabase: vi.fn().mockResolvedValue({ getCurrentTenantDbName: () => 'tenant_acme' }),
}));

vi.mock('@/lib/services/availability/serviceAvailability', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/availability/serviceAvailability')>()),
  assertServiceEnabled: vi.fn().mockResolvedValue(undefined),
}));

import type { IMcpServer } from '@/lib/database';
import { executeMcpTool } from '@/lib/services/mcp/mcpService';

const SERVER = {
  _id: 'srv-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  key: 'crm',
  name: 'CRM',
  status: 'active',
  sourceType: 'openapi',
  tools: [],
} as unknown as IMcpServer;

class Refused extends Error {
  readonly status = 429;
  constructor() {
    super('Request quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

describe('executeMcpTool quota', () => {
  beforeEach(() => {
    enforceServiceQuota.mockReset();
  });

  it('checks the mcp domain with the server key and the caller it was given', async () => {
    enforceServiceQuota.mockRejectedValueOnce(new Refused());
    await expect(
      executeMcpTool(SERVER, 'lookup', {}, undefined, { userId: 'user-1', tokenId: 'tok-1' }, { clientIp: '203.0.113.9' }),
    ).rejects.toMatchObject({ name: 'QuotaExceededError' });

    expect(enforceServiceQuota).toHaveBeenCalledTimes(1);
    expect(enforceServiceQuota).toHaveBeenCalledWith(
      {
        tenantDbName: 'tenant_acme',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        userId: 'user-1',
        tokenId: 'tok-1',
        clientIp: '203.0.113.9',
      },
      { domain: 'mcp', resourceKey: 'crm', cost: { requests: 1 } },
    );
  });

  it('refuses before the tool is looked up or run', async () => {
    enforceServiceQuota.mockRejectedValueOnce(new Refused());
    // The server lists no tools: past the check this would be an unknown-tool error instead.
    await expect(executeMcpTool(SERVER, 'lookup', {})).rejects.toThrow('Request quota exceeded');
  });
});
