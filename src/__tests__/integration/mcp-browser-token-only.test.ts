/**
 * A browser server is called with an API token only. Create and update refuse
 * every way of putting one behind a public URL: the browser server itself, a
 * composite that includes it, and an internal server that becomes a browser
 * server while a public composite includes it. Real SQLiteProvider, no
 * Chromium (the browser provider only reads the browser row here).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-browser-token-only-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_browser_token_only_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-browser-token-only';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, type IMcpExposureConfig, type IMcpServer } from '@/lib/database';
import { createBrowser } from '@/lib/services/browser/browserProfileService';
import {
  createMcpServer,
  getMcpServer,
  isTokenOnlyServer,
  reachesTokenOnlyServer,
  updateMcpServer,
} from '@/lib/services/mcp';
import { McpServerConfigError } from '@/lib/services/mcp/errors';

const TENANT_DB_NAME = 'mcp_browser_token_only_tenant';
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';

const PUBLIC: IMcpExposureConfig = { protocols: ['streamable-http'], accessMode: 'public' };
const TOKEN: IMcpExposureConfig = { protocols: ['streamable-http'], accessMode: 'token' };

let TENANT_ID: string;
let browserKey: string;
let browserServer: IMcpServer;

async function createBrowserServer(name: string, exposure?: IMcpExposureConfig): Promise<IMcpServer> {
  return createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name,
    sourceType: 'internal',
    upstreamAuth: { type: 'none' },
    internalConfig: { provider: 'browser', instanceKey: browserKey, config: {} },
    exposure,
  });
}

async function createAgentObsServer(name: string, exposure?: IMcpExposureConfig): Promise<IMcpServer> {
  return createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name,
    sourceType: 'internal',
    upstreamAuth: { type: 'none' },
    internalConfig: { provider: 'agent-observability', instanceKey: 'project' },
    exposure,
  });
}

async function createComposite(name: string, members: IMcpServer[], exposure?: IMcpExposureConfig): Promise<IMcpServer> {
  return createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name,
    sourceType: 'composite',
    upstreamAuth: { type: 'none' },
    compositeConfig: { members: members.map((m) => ({ serverId: String(m._id) })) },
    exposure,
  });
}

const tokenOnly = (promise: Promise<unknown>) => expect(promise).rejects.toThrow(McpServerConfigError);

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'MCP Browser Token Only',
    slug: 'mcp-browser-token-only',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  TENANT_ID = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);

  const browser = await createBrowser(
    { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID, projectId: PROJECT_ID },
    { name: 'Back office', createdBy: USER_ID },
  );
  browserKey = browser.key;
  browserServer = await createBrowserServer('Back office browser');
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a browser server', () => {
  it('is created with an API token', () => {
    expect(browserServer.exposure?.accessMode).toBe('token');
    expect(isTokenOnlyServer(browserServer)).toBe(true);
  });

  it('cannot be created public', async () => {
    await tokenOnly(createBrowserServer('Public browser', PUBLIC));
  });

  it('cannot be made public', async () => {
    await tokenOnly(updateMcpServer(TENANT_DB_NAME, String(browserServer._id), USER_ID, { exposure: PUBLIC }));
    expect((await getMcpServer(TENANT_DB_NAME, String(browserServer._id)))?.exposure?.accessMode).toBe('token');
  });

  it('cannot replace the provider of a public server', async () => {
    const server = await createAgentObsServer('Public observability', PUBLIC);
    await tokenOnly(updateMcpServer(TENANT_DB_NAME, String(server._id), USER_ID, {
      internalConfig: { provider: 'browser', instanceKey: browserKey, config: {} },
    }));
    expect(isTokenOnlyServer((await getMcpServer(TENANT_DB_NAME, String(server._id)))!)).toBe(false);
  });

  it('can still be edited while it keeps the token', async () => {
    const updated = await updateMcpServer(TENANT_DB_NAME, String(browserServer._id), USER_ID, {
      description: 'Drives the back office',
      exposure: TOKEN,
    });
    expect(updated?.description).toBe('Drives the back office');
  });
});

describe('a composite with a browser member', () => {
  it('cannot be created public', async () => {
    const other = await createAgentObsServer('Observability for public composite');
    await tokenOnly(createComposite('Public with browser', [other, browserServer], PUBLIC));
  });

  it('is created with an API token and cannot be made public', async () => {
    const composite = await createComposite('Token with browser', [browserServer]);
    expect(await reachesTokenOnlyServer(await getDatabase(), composite)).toBe(true);
    await tokenOnly(updateMcpServer(TENANT_DB_NAME, String(composite._id), USER_ID, { exposure: PUBLIC }));
  });

  it('cannot be formed by adding the browser to a public composite', async () => {
    const member = await createAgentObsServer('Observability member');
    const composite = await createComposite('Public without browser', [member], PUBLIC);
    expect(await reachesTokenOnlyServer(await getDatabase(), composite)).toBe(false);
    await tokenOnly(updateMcpServer(TENANT_DB_NAME, String(composite._id), USER_ID, {
      compositeConfig: { members: [{ serverId: String(member._id) }, { serverId: String(browserServer._id) }] },
    }));
  });

  it('cannot be formed by a member of a public composite becoming a browser server', async () => {
    const member = await createAgentObsServer('Observability member of a public composite');
    await createComposite('Public observability composite', [member], PUBLIC);
    await expect(updateMcpServer(TENANT_DB_NAME, String(member._id), USER_ID, {
      internalConfig: { provider: 'browser', instanceKey: browserKey, config: {} },
    })).rejects.toThrow(/public composite server "Public observability composite"/);
    expect(isTokenOnlyServer((await getMcpServer(TENANT_DB_NAME, String(member._id)))!)).toBe(false);
  });

  it('lets a member of a token composite become a browser server', async () => {
    const member = await createAgentObsServer('Observability member of a token composite');
    await createComposite('Token observability composite', [member]);
    const updated = await updateMcpServer(TENANT_DB_NAME, String(member._id), USER_ID, {
      internalConfig: { provider: 'browser', instanceKey: browserKey, config: {} },
    });
    expect(isTokenOnlyServer(updated!)).toBe(true);
  });
});

describe('a public server without a browser', () => {
  it('stays public', async () => {
    const server = await createAgentObsServer('Public observability only', PUBLIC);
    expect(server.exposure?.accessMode).toBe('public');
    const composite = await createComposite('Public composite only', [server], PUBLIC);
    expect(composite.exposure?.accessMode).toBe('public');
  });
});
