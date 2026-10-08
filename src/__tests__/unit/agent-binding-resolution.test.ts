import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/tools', () => ({ getToolByKey: vi.fn() }));
vi.mock('@/lib/services/mcp', () => ({ getMcpServerByKey: vi.fn() }));
vi.mock('@/lib/services/rag/ragService', () => ({ getRagModule: vi.fn() }));

import { getToolByKey } from '@/lib/services/tools';
import { getMcpServerByKey } from '@/lib/services/mcp';
import { getRagModule } from '@/lib/services/rag/ragService';
import {
  resolveAgentBindingMcpServer,
  resolveAgentBindingTool,
  resolveAgentKnowledgeModule,
} from '@/lib/services/agents/bindingResolution';
import { pickAgentUpdateFields } from '@/server/api/plugins/agent-config-write';

const tool = vi.mocked(getToolByKey);
const mcp = vi.mocked(getMcpServerByKey);
const rag = vi.mocked(getRagModule);

beforeEach(() => vi.clearAllMocks());

describe('agent binding resolution stays inside the agent project', () => {
  it('prefers the agent project row', async () => {
    tool.mockImplementation(async (_db, _key, projectId) => (projectId === 'proj-a' ? { key: 'weather', projectId: 'proj-a' } as never : null));
    await expect(resolveAgentBindingTool('t', 'weather', 'proj-a')).resolves.toMatchObject({ projectId: 'proj-a' });
    expect(tool).toHaveBeenCalledWith('t', 'weather', 'proj-a');
  });

  it('falls back only to the tenant-wide row, never an unscoped lookup', async () => {
    tool.mockResolvedValue(null);
    await expect(resolveAgentBindingTool('t', 'weather', 'proj-a')).resolves.toBeNull();
    expect(tool.mock.calls.map((call) => call[2])).toEqual(['proj-a', null]);

    mcp.mockResolvedValue(null);
    await resolveAgentBindingMcpServer('t', 'jira', 'proj-a');
    expect(mcp.mock.calls.map((call) => call[2])).toEqual(['proj-a', null]);

    rag.mockResolvedValue(null);
    await resolveAgentKnowledgeModule('t', 'kb', 'proj-a');
    expect(rag.mock.calls.map((call) => call[2])).toEqual(['proj-a', '']);
  });

  it('without a project, asks for the tenant-wide row only', async () => {
    tool.mockResolvedValue(null);
    await resolveAgentBindingTool('t', 'weather', undefined);
    expect(tool.mock.calls.map((call) => call[2])).toEqual([null]);
  });
});

describe('pickAgentUpdateFields', () => {
  it('drops server-owned fields from a PATCH body', () => {
    const picked = pickAgentUpdateFields({
      name: 'n', description: 'd', config: { a: 1 }, status: 'draft', metadata: { x: 1 },
      projectId: 'other-project', tenantId: 'other-tenant', key: 'k', createdBy: 'u',
      publishedVersion: 9, latestVersion: 9, _id: 'id', createdAt: 'now',
    });
    expect(Object.keys(picked).sort()).toEqual(['config', 'description', 'metadata', 'name', 'status']);
  });
});
