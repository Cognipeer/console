/**
 * Integration test — persisted MCP request logs never store echoed secrets.
 *
 * Regression guard for the leak where an upstream that echoes a passthrough
 * runtime-header value (or the server's static credential) round-trips it into
 * `responsePayload`, which was persisted verbatim. `logMcpRequest` must scrub
 * the supplied secret values and sensitive-named keys before write. Exercises
 * the full write → persist → read path on a real SQLite backend.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-logredact-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_logredact_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-logredact-tests';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase } from '@/lib/database';
import { logMcpRequest, listMcpRequestLogs } from '@/lib/services/mcp';
import { LOG_SECRET_MASK } from '@/lib/services/logRedaction';

const TENANT_DB_NAME = 'mcp_logredact_tenant';
const TENANT_ID = 'tenant-logredact';
const SERVER_KEY = 'srv-logredact';
const SECRET = 'Bearer sk-live-echoed-credential-1234567890';

beforeAll(() => {
  reloadConfig();
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('logMcpRequest — secret scrubbing at the persistence boundary', () => {
  it('masks an echoed secret value and sensitive-named keys in the stored response', async () => {
    await logMcpRequest(
      TENANT_DB_NAME,
      {
        tenantId: TENANT_ID,
        serverKey: SERVER_KEY,
        toolName: 'reflectHeaders',
        status: 'success',
        latencyMs: 5,
        requestPayload: { tool: 'reflectHeaders', arguments: { q: 'hi' } },
        // Upstream echoed the forwarded auth back in its body.
        responsePayload: {
          received: { forwarded: SECRET },
          authorization: SECRET,
          data: { ok: true },
        },
        callerType: 'api',
        transport: 'rest',
        sourceType: 'remote',
      },
      [SECRET],
    );

    const logs = await listMcpRequestLogs(TENANT_DB_NAME, SERVER_KEY, { limit: 10 });
    expect(logs.length).toBe(1);

    const stored = JSON.stringify(logs[0].responsePayload);
    expect(stored).not.toContain('sk-live-echoed-credential-1234567890');
    expect(logs[0].responsePayload?.authorization).toBe(LOG_SECRET_MASK);
    expect((logs[0].responsePayload?.received as Record<string, unknown>).forwarded).toBe(LOG_SECRET_MASK);
    // Non-secret data is preserved.
    expect((logs[0].responsePayload?.data as Record<string, unknown>).ok).toBe(true);
  });

  it('scrubs an echoed secret from the error message on the failure path', async () => {
    await logMcpRequest(
      TENANT_DB_NAME,
      {
        tenantId: TENANT_ID,
        serverKey: SERVER_KEY,
        toolName: 'failing',
        status: 'error',
        latencyMs: 0,
        requestPayload: { tool: 'failing', arguments: {} },
        errorMessage: `MCP server error (401): rejected token ${SECRET}`,
        callerType: 'api',
        transport: 'rest',
        sourceType: 'remote',
      },
      [SECRET],
    );

    const errorLog = (await listMcpRequestLogs(TENANT_DB_NAME, SERVER_KEY, { limit: 10 }))
      .find((l) => l.toolName === 'failing');
    expect(errorLog?.errorMessage).toBeDefined();
    expect(errorLog?.errorMessage).not.toContain('sk-live-echoed-credential-1234567890');
    expect(errorLog?.errorMessage).toContain(LOG_SECRET_MASK);
  });
});
