/**
 * Integration test — MCP per-tool annotation and description overrides.
 *
 * Overrides ride in metadata.toolAnnotations / metadata.toolDescriptions so
 * they survive tool rediscovery, and `listMcpToolDescriptors` folds them over
 * the discovered definitions.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-annotations-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_annotations_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-annotation-tests';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import {
  createMcpServer,
  updateMcpServer,
  getToolAnnotationOverrides,
  getToolDescriptionOverrides,
  listMcpToolDescriptors,
  serializeMcpServerFull,
} from '@/lib/services/mcp';

const TENANT_DB_NAME = 'mcp_annotations_tenant';
const TENANT_ID = 'tenant-mcp-annotations';
const USER_ID = 'user-1';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  servers: [{ url: 'http://upstream.example.com' }],
  paths: {
    '/pets': {
      get: { operationId: 'listPets', summary: 'List pets', responses: { 200: {} } },
      post: { operationId: 'createPet', summary: 'Create pet', responses: { 201: {} } },
    },
  },
});

let server: IMcpServer;

beforeAll(async () => {
  reloadConfig();
  server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, undefined, {
    name: 'Annotations Test',
    openApiSpec: SPEC,
    upstreamAuth: { type: 'none' },
  });
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MCP tool annotation overrides', () => {
  it('derives hints when no override is stored', () => {
    const byName = Object.fromEntries(listMcpToolDescriptors(server).map((t) => [t.name, t]));
    expect(byName.listPets.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.createPet.annotations).toMatchObject({ readOnlyHint: false });
  });

  it('persists a sanitized override and applies it to tools/list', async () => {
    const updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolAnnotations: {
        createPet: { title: 'Create pet', readOnlyHint: false, openWorldHint: false, bogus: 1 } as never,
        not_a_real_tool: { readOnlyHint: true },
      },
    });
    server = updated!;

    expect(getToolAnnotationOverrides(server)).toEqual({
      createPet: { title: 'Create pet', readOnlyHint: false, openWorldHint: false },
    });
    expect(serializeMcpServerFull(server).toolAnnotations).toHaveProperty('createPet');

    const createPet = listMcpToolDescriptors(server).find((t) => t.name === 'createPet');
    expect(createPet?.annotations).toEqual({
      title: 'Create pet',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('clears an override when the entry is null', async () => {
    const updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolAnnotations: { createPet: null },
    });
    server = updated!;

    expect(getToolAnnotationOverrides(server)).toEqual({});
    const createPet = listMcpToolDescriptors(server).find((t) => t.name === 'createPet');
    expect(createPet?.annotations.title).toBe('createPet');
  });

  it('overrides the tool description and restores it when cleared', async () => {
    const discovered = listMcpToolDescriptors(server).find((t) => t.name === 'listPets')!.description;

    server = (await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolDescriptions: { listPets: '  Return every pet in the store.  ', unknown_tool: 'nope' },
    }))!;

    expect(getToolDescriptionOverrides(server)).toEqual({ listPets: 'Return every pet in the store.' });
    expect(serializeMcpServerFull(server).toolDescriptions).toEqual({
      listPets: 'Return every pet in the store.',
    });
    expect(listMcpToolDescriptors(server).find((t) => t.name === 'listPets')?.description)
      .toBe('Return every pet in the store.');

    server = (await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolDescriptions: { listPets: null },
    }))!;

    expect(getToolDescriptionOverrides(server)).toEqual({});
    expect(listMcpToolDescriptors(server).find((t) => t.name === 'listPets')?.description)
      .toBe(discovered);
  });
});
