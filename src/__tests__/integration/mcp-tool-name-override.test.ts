/**
 * Integration test — MCP per-tool name overrides (renaming what a tool is
 * called in tools/list without changing which underlying tool it maps to).
 *
 * Overrides ride in metadata.toolNames, keyed by the real (discovered) tool
 * name — same pattern as toolAnnotations/toolDescriptions. The reverse
 * resolution in executeMcpToolLocal is what guarantees a call under the new
 * name always reaches the same underlying tool.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-tool-names-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_tool_names_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-tool-name-tests';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import {
  createMcpServer,
  updateMcpServer,
  getToolNameOverrides,
  listMcpToolDescriptors,
  resolveMcpToolName,
  serializeMcpServerFull,
} from '@/lib/services/mcp';
import { executeMcpToolLocal } from '@/lib/services/mcp/mcpService';

const TENANT_DB_NAME = 'mcp_tool_names_tenant';
const TENANT_ID = 'tenant-mcp-tool-names';
const USER_ID = 'user-1';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  servers: [{ url: 'http://upstream.example.com' }],
  paths: {
    '/users': {
      get: { operationId: 'listUsers', summary: 'List users', responses: { 200: {} } },
      post: { operationId: 'createUser', summary: 'Create user', responses: { 201: {} } },
    },
    '/pets': {
      get: { operationId: 'listPets', summary: 'List pets', responses: { 200: {} } },
    },
  },
});

let server: IMcpServer;

beforeAll(async () => {
  reloadConfig();
  server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, undefined, {
    name: 'Tool Name Override Test',
    openApiSpec: SPEC,
    upstreamAuth: { type: 'none' },
  });
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MCP tool name overrides', () => {
  it('starts with no overrides — tools/list uses the discovered names', () => {
    expect(getToolNameOverrides(server)).toEqual({});
    expect(listMcpToolDescriptors(server).map((t) => t.name).sort())
      .toEqual(['createUser', 'listPets', 'listUsers']);
  });

  it('renames a tool in tools/list while keeping the real name as its identity', async () => {
    const updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolNames: { listUsers: '  get_users  ', not_a_real_tool: 'nope' },
    });
    expect(updated).not.toBeNull();
    server = updated!;

    expect(getToolNameOverrides(server)).toEqual({ listUsers: 'get_users' });
    expect(serializeMcpServerFull(server).toolNames).toEqual({ listUsers: 'get_users' });

    const names = listMcpToolDescriptors(server).map((t) => t.name).sort();
    expect(names).toEqual(['createUser', 'get_users', 'listPets']);
    // The real tool list itself is untouched — only the projected view renames.
    expect(server.tools.map((t) => t.name).sort()).toEqual(['createUser', 'listPets', 'listUsers']);

    expect(resolveMcpToolName(server, 'get_users')).toBe('listUsers');
    expect(resolveMcpToolName(server, 'createUser')).toBe('createUser');
  });

  it('routes a call under the new name to the same underlying tool (disable-by-real-name proves it)', async () => {
    const withDisabled = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      disabledTools: ['listUsers'],
    });
    server = withDisabled!;

    // Disabling rides on the real name; the renamed tool must still be found
    // and rejected — proving the caller-supplied "get_users" resolves back
    // to "listUsers" before the enable check runs.
    await expect(executeMcpToolLocal(server, 'get_users', {}))
      .rejects.toThrow(/disabled/i);

    const reEnabled = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      disabledTools: [],
    });
    server = reEnabled!;
  });

  it('rejects a rename that collides with another tool\'s effective name', async () => {
    await expect(updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolNames: { createUser: 'get_users' },
    })).rejects.toThrow(/collides/i);

    await expect(updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolNames: { createUser: 'listPets' },
    })).rejects.toThrow(/collides/i);

    // Neither rejected attempt should have partially persisted.
    expect(getToolNameOverrides(server)).toEqual({ listUsers: 'get_users' });
  });

  it('silently drops a name with characters outside the allowed charset', async () => {
    const updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolNames: { createUser: 'bad name!' },
    });
    server = updated!;

    expect(getToolNameOverrides(server)).toEqual({ listUsers: 'get_users' });
    expect(listMcpToolDescriptors(server).find((t) => t.name === 'createUser')).toBeTruthy();
  });

  it('clears the override when the entry is null, restoring the discovered name', async () => {
    const updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolNames: { listUsers: null },
    });
    server = updated!;

    expect(getToolNameOverrides(server)).toEqual({});
    expect(listMcpToolDescriptors(server).map((t) => t.name).sort())
      .toEqual(['createUser', 'listPets', 'listUsers']);
    expect(resolveMcpToolName(server, 'get_users')).toBe('get_users');
  });
});
