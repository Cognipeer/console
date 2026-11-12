/**
 * Integration test — the review of MCP tool definitions through a real store.
 *
 * Real SQLite backend, real `refreshMcpServerTools` / `updateMcpServer` /
 * `executeMcpToolLocal`; the upstream's tool list comes from a stubbed
 * discovery, so nothing here opens a socket or starts a process.
 *
 *  - A decision holds for the definition the reviewer saw: one that changed
 *    in the meantime keeps waiting.
 *  - A tool whose name means something to JavaScript objects is stored, held
 *    and refused like any other name.
 *  - A stdio server saved before exact versions were required stays editable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-tool-review-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_tool_review_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-tool-review-tests';

const { remoteDiscover, stdioDiscover } = vi.hoisted(() => ({
  remoteDiscover: vi.fn(),
  stdioDiscover: vi.fn(),
}));

vi.mock('@/lib/services/mcp/remoteMcpClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/mcp/remoteMcpClient')>()),
  remoteDiscover,
  remoteCallTool: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/services/mcp/stdioRunner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/mcp/stdioRunner')>()),
  stdioDiscover,
  stdioCallTool: vi.fn(async () => ({ ran: true })),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer, IMcpTool } from '@/lib/database';
import { listEnabledMcpTools, refreshMcpServerTools, updateMcpServer } from '@/lib/services/mcp';
import { executeMcpToolLocal } from '@/lib/services/mcp/mcpService';
import { getToolPins, getToolReview, toolDefinitionHash } from '@/lib/services/mcp/toolSecurity';

const TENANT_DB_NAME = 'mcp_tool_review_tenant';
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
let TENANT_ID: string;

const tool = (name: string, description = name): IMcpTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties: {} },
});

async function tenantDb() {
  const db = await getDatabase();
  await db.switchToTenant(TENANT_DB_NAME);
  return db;
}

async function insertServer(fields: Partial<IMcpServer> & Pick<IMcpServer, 'key' | 'sourceType' | 'tools'>): Promise<IMcpServer> {
  const db = await tenantDb();
  return db.createMcpServer({
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    name: fields.key,
    upstreamAuth: { type: 'none' },
    exposure: { protocols: ['streamable-http'], accessMode: 'token' },
    status: 'active',
    endpointSlug: `slug-${fields.key}`,
    totalRequests: 0,
    createdBy: USER_ID,
    ...fields,
  } as never);
}

async function stored(server: IMcpServer): Promise<IMcpServer> {
  const db = await tenantDb();
  return (await db.findMcpServerById(String(server._id)))!;
}

const remote = { remoteConfig: { url: 'https://mcp.example.com/mcp', transport: 'streamable-http' as const } };
const discovered = (tools: IMcpTool[]) => ({ tools, instructions: undefined });

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'MCP Tool Review',
    slug: 'mcp-tool-review',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  TENANT_ID = String(tenant._id);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  remoteDiscover.mockReset();
  stdioDiscover.mockReset();
});

describe('a review decision', () => {
  it('holds for the definition the reviewer saw, and a changed one keeps waiting', async () => {
    const server = await insertServer({ key: 'crm', sourceType: 'remote', ...remote, tools: [tool('lookup')] });

    remoteDiscover.mockResolvedValueOnce(discovered([tool('lookup', 'v2')]));
    await refreshMcpServerTools(TENANT_DB_NAME, String(server._id), USER_ID);
    const shown = getToolReview((await stored(server)).metadata).lookup.hash;
    expect(listEnabledMcpTools(await stored(server))).toEqual([]);

    // The upstream changes the tool again before the reviewer decides.
    remoteDiscover.mockResolvedValueOnce(discovered([tool('lookup', 'v3')]));
    await refreshMcpServerTools(TENANT_DB_NAME, String(server._id), USER_ID);

    await expect(updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolReview: { approve: [{ name: 'lookup', hash: shown }] },
    })).rejects.toThrow(/changed since it was shown/);
    expect(getToolReview((await stored(server)).metadata)).toHaveProperty('lookup');

    const current = getToolReview((await stored(server)).metadata).lookup.hash;
    expect(current).toBe(toolDefinitionHash(tool('lookup', 'v3')));
    await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolReview: { approve: [{ name: 'lookup', hash: current }] },
    });
    const approved = await stored(server);
    expect(getToolReview(approved.metadata)).toEqual({});
    expect(getToolPins(approved.metadata)?.lookup).toBe(current);
    expect(listEnabledMcpTools(approved).map((t) => t.name)).toEqual(['lookup']);
  });
});

describe('a tool named like an object property', () => {
  it('is stored under its own name, waits for review and cannot be called', async () => {
    const server = await insertServer({ key: 'odd-names', sourceType: 'remote', ...remote, tools: [tool('search')] });
    remoteDiscover.mockResolvedValueOnce(discovered([tool('search'), tool('__proto__'), tool('constructor')]));
    await refreshMcpServerTools(TENANT_DB_NAME, String(server._id), USER_ID);

    const after = await stored(server);
    const review = getToolReview(after.metadata);
    expect(Object.keys(review).sort()).toEqual(['__proto__', 'constructor']);
    expect(review.__proto__.reason).toBe('scan');
    expect(listEnabledMcpTools(after).map((t) => t.name)).toEqual(['search']);
    await expect(executeMcpToolLocal(after, '__proto__', {})).rejects.toThrow(/awaiting review/);
    await expect(executeMcpToolLocal(after, 'constructor', {})).rejects.toThrow(/awaiting review/);
  });
});

describe('a stdio server saved before exact versions were required', () => {
  const config = (packageName: string) => ({ runtime: 'npx' as const, packageName, executionMode: 'subprocess' as const });

  it('stays editable, and needs an exact version once its package changes', async () => {
    const server = await insertServer({ key: 'legacy', sourceType: 'stdio', stdioConfig: config('legacy-mcp'), tools: [tool('run')] });
    stdioDiscover.mockResolvedValue(discovered([tool('run')]));

    await expect(updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      stdioConfig: { ...config('legacy-mcp'), env: { REGION: 'eu' } },
    })).resolves.toBeTruthy();

    await expect(updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      stdioConfig: config('other-mcp'),
    })).rejects.toThrow(/exact version/);
    await expect(updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      stdioConfig: config('other-mcp@1.0.0'),
    })).resolves.toBeTruthy();
  });
});
