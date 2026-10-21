/**
 * MCP server `instructions` end to end on a real (SQLite) database: what a
 * source supplies at discovery, the operator's text winning over it, a
 * composite stitching its members' texts together, and tool titles.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-instructions-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_instructions_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-instructions-tests';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import {
  createMcpServer,
  getMcpServer,
  listMcpToolDescriptors,
  refreshMcpServerTools,
  resolveMcpInstructions,
  serializeMcpServer,
  updateMcpServer,
} from '@/lib/services/mcp';

const TENANT_DB_NAME = 'mcp_instructions_tenant';
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
let TENANT_ID: string;

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Pets', version: '1' },
  servers: [{ url: 'https://pets.example.test' }],
  paths: {
    '/pets': { get: { operationId: 'listPets', summary: 'List pets' } },
    '/pets/{id}': { delete: { operationId: 'deletePet', parameters: [{ name: 'id', in: 'path', required: true }] } },
  },
});

function observability(name: string): Promise<IMcpServer> {
  return createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name,
    sourceType: 'internal',
    upstreamAuth: { type: 'none' },
    internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
  });
}

async function reload(server: IMcpServer): Promise<IMcpServer> {
  return (await getMcpServer(TENANT_DB_NAME, String(server._id)))!;
}

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'MCP Instructions Test',
    slug: 'mcp-instructions-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  TENANT_ID = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MCP server instructions', () => {
  it('serves what an internal provider supplies when the operator wrote nothing', async () => {
    const server = await observability('Obs plain');
    expect(resolveMcpInstructions(server)).toContain('list_sessions');
    expect(serializeMcpServer(server)).toMatchObject({ instructions: undefined });
    expect(serializeMcpServer(server).discoveredInstructions).toContain('get_session_detail');
  });

  it('serves the operator\'s text over the source\'s, and the source\'s again once it is cleared', async () => {
    const server = await observability('Obs edited');
    const edited = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      instructions: '  Use list_sessions with a time range.  ',
    });
    expect(resolveMcpInstructions(edited!)).toBe('Use list_sessions with a time range.');
    expect(serializeMcpServer(edited!).discoveredInstructions).toContain('list_agents');

    // A refresh replaces what the source said, never the operator's text.
    const refreshed = await refreshMcpServerTools(TENANT_DB_NAME, String(server._id), USER_ID);
    expect(resolveMcpInstructions(refreshed!)).toBe('Use list_sessions with a time range.');

    const cleared = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, { instructions: null });
    expect(resolveMcpInstructions(cleared!)).toContain('list_agents');
  });

  it('takes the operator\'s text at create', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Obs created with text',
      instructions: 'Created with text.',
      sourceType: 'internal',
      upstreamAuth: { type: 'none' },
      internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
    });
    expect(resolveMcpInstructions(server)).toBe('Created with text.');
  });

  it('gives a composite one headed section per member, and follows a member\'s edit', async () => {
    const a = await observability('Member A');
    const b = await observability('Member B');
    const composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Both members',
      sourceType: 'composite',
      upstreamAuth: { type: 'none' },
      compositeConfig: { members: [{ serverId: String(a._id) }, { serverId: String(b._id) }] },
    });
    const text = resolveMcpInstructions(composite)!;
    expect(text).toMatch(/^## Member A\n/);
    expect(text).toContain('\n\n## Member B\n');

    await updateMcpServer(TENANT_DB_NAME, String(a._id), USER_ID, { instructions: 'A, rewritten.' });
    expect(resolveMcpInstructions(await reload(composite))).toMatch(/^## Member A\nA, rewritten\.\n\n## Member B\n/);
  });
});

describe('tool titles', () => {
  it('takes an OpenAPI operation\'s summary as the title, and falls back to the name', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Pets API',
      sourceType: 'openapi',
      openApiSpec: SPEC,
      upstreamAuth: { type: 'none' },
    });
    const byName = Object.fromEntries(listMcpToolDescriptors(server).map((t) => [t.name, t]));
    expect(byName.listPets).toMatchObject({ title: 'List pets', annotations: { title: 'List pets' } });
    expect(byName.deletePet.title).toBe('deletePet');
  });

  it('lets the operator\'s title override win', async () => {
    const server = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
      name: 'Pets API 2',
      sourceType: 'openapi',
      openApiSpec: SPEC,
      upstreamAuth: { type: 'none' },
    });
    const updated = await updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      toolAnnotations: { listPets: { title: 'Browse the pet list' } },
    });
    const listPets = listMcpToolDescriptors(updated!).find((t) => t.name === 'listPets')!;
    expect(listPets.title).toBe('Browse the pet list');
    expect(listPets.annotations.title).toBe('Browse the pet list');
  });
});
