/**
 * Integration test — MCP per-tool enable/disable.
 *
 * The disabled-name list rides in metadata.disabledTools. Covers: sanitizing
 * unknown names on update, filtering via listEnabledMcpTools, the execution
 * guard, pruning when the spec (tool list) changes, and clearing the list.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-disabled-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_disabled_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-disabled-tests';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import {
  createMcpServer,
  updateMcpServer,
  getDisabledToolNames,
  isMcpToolEnabled,
  listEnabledMcpTools,
  serializeMcpServer,
} from '@/lib/services/mcp';
import { executeMcpToolLocal } from '@/lib/services/mcp/mcpService';

const TENANT_DB_NAME = 'mcp_disabled_tenant';
const TENANT_ID = 'tenant-mcp-disabled';
const USER_ID = 'user-1';

function specWithPaths(paths: Record<string, unknown>): string {
  return JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Test API', version: '1.0.0' },
    servers: [{ url: 'http://upstream.example.com' }],
    paths,
  });
}

const INITIAL_SPEC = specWithPaths({
  '/users': {
    get: { operationId: 'listUsers', summary: 'List users', responses: { 200: {} } },
    post: { operationId: 'createUser', summary: 'Create user', responses: { 201: {} } },
  },
  '/pets': {
    get: { operationId: 'listPets', summary: 'List pets', responses: { 200: {} } },
  },
});

let server: IMcpServer;

beforeAll(async () => {
  reloadConfig();
  server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, undefined, {
    name: 'Disabled Tools Test',
    openApiSpec: INITIAL_SPEC,
    upstreamAuth: { type: 'none' },
  });
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MCP per-tool enable/disable', () => {
  it('starts with every tool enabled and an empty disabled list in the view', () => {
    expect(server.tools.length).toBe(3);
    expect(getDisabledToolNames(server)).toEqual([]);
    expect(serializeMcpServer(server).disabledTools).toEqual([]);
    expect(listEnabledMcpTools(server).length).toBe(3);
  });

  it('persists a sanitized disabled list (unknown names dropped, duplicates removed)', async () => {
    const updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      disabledTools: ['listUsers', 'listUsers', 'not_a_real_tool'],
    });
    expect(updated).not.toBeNull();
    server = updated!;

    expect(getDisabledToolNames(server)).toEqual(['listUsers']);
    expect(isMcpToolEnabled(server, 'listUsers')).toBe(false);
    expect(isMcpToolEnabled(server, 'createUser')).toBe(true);
    expect(listEnabledMcpTools(server).map((t) => t.name).sort()).toEqual(['createUser', 'listPets']);

    // Round-trips through the DB, not just the in-memory record.
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    const reloaded = await db.findMcpServerById(String(server._id));
    expect(getDisabledToolNames(reloaded!)).toEqual(['listUsers']);
  });

  it('rejects execution of a disabled tool before any upstream call', async () => {
    await expect(executeMcpToolLocal(server, 'listUsers', {}))
      .rejects.toThrow(/disabled/i);
  });

  it('prunes disabled names that vanish when the spec is replaced', async () => {
    const updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      // New spec no longer contains listUsers.
      openApiSpec: specWithPaths({
        '/pets': {
          get: { operationId: 'listPets', summary: 'List pets', responses: { 200: {} } },
          post: { operationId: 'createPet', summary: 'Create pet', responses: { 201: {} } },
        },
      }),
    });
    expect(updated).not.toBeNull();
    server = updated!;

    expect(server.tools.map((t) => t.name).sort()).toEqual(['createPet', 'listPets']);
    expect(getDisabledToolNames(server)).toEqual([]);
  });

  it('clears the list when an empty array is sent (all tools re-enabled)', async () => {
    let updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      disabledTools: ['listPets'],
    });
    expect(getDisabledToolNames(updated!)).toEqual(['listPets']);

    updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      disabledTools: [],
    });
    server = updated!;
    expect(getDisabledToolNames(server)).toEqual([]);
    expect((server.metadata ?? {}).disabledTools).toBeUndefined();
    expect(listEnabledMcpTools(server).length).toBe(2);
  });
});
