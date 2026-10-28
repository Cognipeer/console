/**
 * Integration test — an MCP server over a knowledge base with access control.
 *
 * Who the call is for travels with it to the provider (directly, and inside the
 * job another node runs), and the request log keeps a summary of the response
 * instead of the response when the module has access control. Modules without
 * it log exactly as they always did. Real SQLite for the servers and the log;
 * the Knowledge Engine and its access scope are stand-ins.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-mcp-kb-access-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'mcp_kb_access_main';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-kb-access-tests';

const h = vi.hoisted(() => ({
  getRagModule: vi.fn(),
  getRagDocument: vi.fn(),
  getRagDocumentFullText: vi.fn(),
  getRagDocumentTextLines: vi.fn(),
  listRagModules: vi.fn(),
  queryRag: vi.fn(),
  resolveRagAccess: vi.fn(),
  /** The consumer another node would run (registered by `startMcpQueueConsumer`). */
  consume: undefined as undefined | ((ctx: { name: string; data: unknown }) => Promise<unknown>),
  /** When set, a call is routed to "another node": the job and the answer cross as JSON. */
  otherNode: false,
  jobs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/services/rag/ragService', () => ({
  getRagModule: h.getRagModule,
  getRagDocument: h.getRagDocument,
  getRagDocumentFullText: h.getRagDocumentFullText,
  getRagDocumentTextLines: h.getRagDocumentTextLines,
  listRagModules: h.listRagModules,
  queryRag: h.queryRag,
}));
vi.mock('@/lib/services/rag/access/scope', () => ({ resolveRagAccess: h.resolveRagAccess }));

vi.mock('@/lib/core/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/queue')>();
  return {
    ...actual,
    getQueue: vi.fn(async () => ({
      consume: (_queueName: string, handler: typeof h.consume) => {
        h.consume = handler;
      },
    })),
  };
});

vi.mock('@/lib/core/cluster', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/cluster')>();
  return {
    ...actual,
    routeInstanceCall: vi.fn(async (_ctx: unknown, payload: Record<string, unknown>, local: () => Promise<unknown>) => {
      if (!h.otherNode) return local();
      h.jobs.push(payload);
      const answer = await h.consume!({ name: 'invoke', data: JSON.parse(JSON.stringify(payload)) });
      return JSON.parse(JSON.stringify(answer));
    }),
  };
});

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import type { IMcpServer } from '@/lib/database';
import { createMcpServer, executeMcpTool, listMcpRequestLogs, logMcpRequest, resolveSourceType } from '@/lib/services/mcp';
import { startMcpQueueConsumer } from '@/lib/services/mcp/mcpConsumer';
import { responseLogSummaryOf } from '@/lib/services/mcp/responseLog';
import type { ConsoleIdentityCaller } from '@/lib/iam/consoleIdentity';

const TENANT_DB_NAME = 'mcp_kb_access_tenant';
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
const MODULE_KEY = 'docs';

const GUARDED_MODULE = { key: MODULE_KEY, name: 'Docs', projectId: PROJECT_ID, access: { enabled: true } };
const PLAIN_MODULE = { key: MODULE_KEY, name: 'Docs', projectId: PROJECT_ID };

const PASSAGE = 'CONFIDENTIAL PASSAGE ABOUT THE MERGER';
const PERSON: ConsoleIdentityCaller = { userId: 'person-1', source: 'playground' };

let TENANT_ID: string;
let kbServer: IMcpServer;
let credentialedKbServer: IMcpServer;
let composite: IMcpServer;

function openScope() {
  return { enabled: true, enforced: true, canReadDocument: () => true };
}

/** The log row a route writes after `executeMcpTool` returned `result` (same shape as client-mcp.ts). */
async function logLikeARoute(server: IMcpServer, toolName: string, args: Record<string, unknown>, result: unknown) {
  await logMcpRequest(TENANT_DB_NAME, {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    serverId: String(server._id),
    serverKey: server.key,
    toolName,
    status: 'success',
    latencyMs: 7,
    requestPayload: { tool: toolName, arguments: args },
    responsePayload: typeof result === 'object' && result !== null
      ? result as Record<string, unknown>
      : { value: result },
    callerType: 'api',
    transport: 'rest',
    sourceType: resolveSourceType(server),
  }, []);
}

/** The newest log row of a server whose request carried this marker argument. */
async function logOf(server: IMcpServer, marker: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await listMcpRequestLogs(TENANT_DB_NAME, server, { limit: 50 });
    const row = rows.find((r) => JSON.stringify(r.requestPayload ?? {}).includes(marker));
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no log row for ${marker}`);
}

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  const tenant = await db.createTenant({
    companyName: 'MCP KB Access Test',
    slug: 'mcp-kb-access-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  TENANT_ID = String(tenant._id);
  await db.switchToTenant(TENANT_DB_NAME);

  h.getRagModule.mockResolvedValue(PLAIN_MODULE);
  kbServer = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name: 'KB Server',
    sourceType: 'internal',
    upstreamAuth: { type: 'none' },
    internalConfig: { provider: 'knowledge-base', instanceKey: MODULE_KEY },
  });
  // A server that holds a credential has its results masked on the way out, which hands back a copy.
  credentialedKbServer = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name: 'KB Server With Credential',
    sourceType: 'internal',
    upstreamAuth: { type: 'token', token: 'credential-token-1234567' },
    internalConfig: { provider: 'knowledge-base', instanceKey: MODULE_KEY },
  });
  composite = await createMcpServer(TENANT_DB_NAME, TENANT_ID, USER_ID, PROJECT_ID, {
    name: 'KB Composite',
    sourceType: 'composite',
    upstreamAuth: { type: 'none' },
    compositeConfig: { members: [{ serverId: String(kbServer._id) }] },
  });
  await startMcpQueueConsumer();
});

beforeEach(() => {
  h.otherNode = false;
  h.jobs.length = 0;
  h.getRagModule.mockReset().mockResolvedValue(GUARDED_MODULE);
  h.resolveRagAccess.mockReset().mockImplementation(async () => openScope());
  h.queryRag.mockReset().mockImplementation(async () => ({
    query: 'q',
    matches: [{ id: 'v1', documentId: 'doc-1', content: PASSAGE }, { id: 'v2', documentId: 'doc-2', content: PASSAGE }],
  }));
  h.getRagDocument.mockReset().mockImplementation(async (_db: string, id: string) => ({
    _id: id, tenantId: TENANT_ID, ragModuleKey: MODULE_KEY, projectId: PROJECT_ID, fileName: 'merger.md',
  }));
  h.getRagDocumentFullText.mockReset().mockImplementation(async () => ({
    documentId: 'doc-1', fileName: 'merger.md', text: PASSAGE, totalChars: 37, totalLines: 1, truncated: false,
  }));
  h.getRagDocumentTextLines.mockReset().mockImplementation(async () => ({
    documentId: 'doc-1', fileName: 'merger.md', totalLines: 9, startLine: 1, endLine: 1, hasMore: true, lines: `1\t${PASSAGE}`,
  }));
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('who the call is for reaches the provider', () => {
  it('on this node', async () => {
    await executeMcpTool(kbServer, 'search', { query: 'q-local' }, undefined, PERSON);

    expect(h.resolveRagAccess).toHaveBeenCalledTimes(1);
    expect(h.resolveRagAccess.mock.calls[0][0].caller).toEqual({ kind: 'person', userId: 'person-1' });
    expect(h.queryRag.mock.calls[0][4].caller).toEqual({ kind: 'person', userId: 'person-1' });
  });

  it('inside the job another node runs', async () => {
    h.otherNode = true;

    await executeMcpTool(kbServer, 'search', { query: 'q-queued' }, undefined, PERSON);

    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0].identity).toEqual(PERSON);
    expect(h.resolveRagAccess).toHaveBeenCalledTimes(1);
    expect(h.resolveRagAccess.mock.calls[0][0].caller).toEqual({ kind: 'person', userId: 'person-1' });
  });

  it('as a token, a trigger and nobody, for the calls that are not a person', async () => {
    await executeMcpTool(kbServer, 'search', { query: 'q-token' }, undefined, { userId: 'owner-1', tokenId: 'tok-1', source: 'mcp' });
    await executeMcpTool(kbServer, 'search', { query: 'q-trigger' }, undefined, { userId: 'owner-1', source: 'trigger' });
    await executeMcpTool(kbServer, 'search', { query: 'q-public' });

    expect(h.resolveRagAccess.mock.calls.map((call) => call[0].caller)).toEqual([
      { kind: 'token', tokenId: 'tok-1', ownerUserId: 'owner-1' },
      { kind: 'anonymous', reason: 'trigger' },
      { kind: 'anonymous', reason: 'unknown' },
    ]);
  });

  it('is left out of the job when the call has none', async () => {
    h.otherNode = true;
    await executeMcpTool(kbServer, 'search', { query: 'q-no-identity' });
    expect(h.jobs[0]).not.toHaveProperty('identity');
  });
});

describe('a document the caller may not read, over MCP', () => {
  it('is reported like an unknown id, on this node and on another', async () => {
    h.resolveRagAccess.mockImplementation(async () => ({ ...openScope(), canReadDocument: () => false }));
    const read = (otherNode: boolean) => {
      h.otherNode = otherNode;
      return executeMcpTool(kbServer, 'read_document', { documentId: 'doc-2' }, undefined, PERSON).catch((e: Error) => e.message);
    };

    const here = await read(false);
    const there = await read(true);
    h.getRagDocument.mockResolvedValue(null);
    const missing = await read(false);

    expect(here).toBe('Document "doc-2" not found in this knowledge base');
    expect(there).toBe(here);
    expect(missing).toBe(here);
    expect(h.getRagDocumentFullText).not.toHaveBeenCalled();
  });
});

describe('the request log of a knowledge base with access control', () => {
  it.each([
    ['search', { query: 'log-search' }, 'log-search', { omitted: true, reason: 'access_controlled', matches: 2 }],
    ['read_document', { documentId: 'doc-1', marker: 'log-read' }, 'log-read', { omitted: true, reason: 'access_controlled', totalChars: 37, totalLines: 1, truncated: false }],
    ['read_document_lines', { documentId: 'doc-1', marker: 'log-lines' }, 'log-lines', { omitted: true, reason: 'access_controlled', totalLines: 9, startLine: 1, endLine: 1, hasMore: true }],
  ])('keeps a summary of %s, not the response', async (tool, args, marker, summary) => {
    const { result, latencyMs } = await executeMcpTool(kbServer, tool, args, undefined, PERSON);
    // The caller still gets the whole response.
    expect(JSON.stringify(result)).toContain(PASSAGE);

    await logLikeARoute(kbServer, tool, args, result);
    const row = await logOf(kbServer, marker);

    expect(row.responsePayload).toEqual(summary);
    expect(JSON.stringify(row)).not.toContain(PASSAGE);
    expect(JSON.stringify(row)).not.toContain('merger.md');
    // Everything else about the call is logged as it always was.
    expect(row).toMatchObject({ toolName: tool, status: 'success', latencyMs: 7, sourceType: 'internal' });
    expect(row.requestPayload).toEqual({ tool, arguments: args });
    expect(latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps the summary of a response that came back from another node', async () => {
    h.otherNode = true;
    const args = { query: 'log-other-node' };

    const { result } = await executeMcpTool(kbServer, 'search', args, undefined, PERSON);
    // A new object, built from JSON: it carries the mark again.
    expect(responseLogSummaryOf(result)).toEqual({ omitted: true, reason: 'access_controlled', matches: 2 });

    await logLikeARoute(kbServer, 'search', args, result);
    const row = await logOf(kbServer, 'log-other-node');
    expect(row.responsePayload).toEqual({ omitted: true, reason: 'access_controlled', matches: 2 });
    expect(JSON.stringify(row)).not.toContain(PASSAGE);
  });

  it('keeps the summary when the result is masked on the way out', async () => {
    const args = { query: 'log-masked' };
    h.queryRag.mockImplementation(async () => ({
      query: 'q',
      matches: [{ id: 'v1', documentId: 'doc-1', content: `${PASSAGE} credential-token-1234567` }],
    }));

    const { result } = await executeMcpTool(credentialedKbServer, 'search', args, undefined, PERSON);
    // Masked: the result is a copy of what the provider returned.
    expect(JSON.stringify(result)).toContain(PASSAGE);
    expect(JSON.stringify(result)).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('credential-token-1234567');

    await logLikeARoute(credentialedKbServer, 'search', args, result);

    expect((await logOf(credentialedKbServer, 'log-masked')).responsePayload)
      .toEqual({ omitted: true, reason: 'access_controlled', matches: 1 });
  });

  it('keeps the summary for a caller the permissions do not apply to as well', async () => {
    h.resolveRagAccess.mockImplementation(async () => ({ enabled: true, enforced: false, canReadDocument: () => true }));
    const args = { query: 'log-manager' };

    const { result } = await executeMcpTool(kbServer, 'search', args, undefined, PERSON);
    await logLikeARoute(kbServer, 'search', args, result);

    expect((await logOf(kbServer, 'log-manager')).responsePayload).toMatchObject({ omitted: true });
  });

  it('keeps the summary on both rows of a call through a composite', async () => {
    const exposed = composite.tools.find((t) => t.origin?.realName === 'search')!.name;
    const args = { query: 'log-composite' };

    const { result } = await executeMcpTool(composite, exposed, args, undefined, PERSON);
    expect(JSON.stringify(result)).toContain(PASSAGE);
    await logLikeARoute(composite, exposed, args, result);

    // The composite's own row (written like a route does) and the member's row (written by the composite).
    for (const server of [composite, kbServer]) {
      const row = await logOf(server, 'log-composite');
      expect(row.responsePayload).toEqual({ omitted: true, reason: 'access_controlled', matches: 2 });
      expect(JSON.stringify(row)).not.toContain(PASSAGE);
    }
  });

  it('logs a failed call as before', async () => {
    h.resolveRagAccess.mockImplementation(async () => ({ ...openScope(), canReadDocument: () => false }));
    const outcome = await executeMcpTool(kbServer, 'read_document', { documentId: 'doc-2' }, undefined, PERSON)
      .catch((e: Error) => e);
    expect(outcome).toBeInstanceOf(Error);

    await logMcpRequest(TENANT_DB_NAME, {
      tenantId: TENANT_ID,
      serverId: String(kbServer._id),
      serverKey: kbServer.key,
      toolName: 'read_document',
      status: 'error',
      latencyMs: 0,
      requestPayload: { tool: 'read_document', arguments: { documentId: 'doc-2', marker: 'log-failed' } },
      errorMessage: (outcome as Error).message,
      sourceType: 'internal',
    }, []);

    expect(await logOf(kbServer, 'log-failed')).toMatchObject({
      status: 'error',
      errorMessage: 'Document "doc-2" not found in this knowledge base',
    });
  });
});

describe('the request log of a knowledge base without access control', () => {
  it.each([
    ['no access setting', PLAIN_MODULE, 'log-plain-unset'],
    ['access control switched off', { ...PLAIN_MODULE, access: { enabled: false } }, 'log-plain-off'],
  ])('keeps the whole response: %s', async (_name, ragModule, query) => {
    h.getRagModule.mockResolvedValue(ragModule);
    const args = { query };

    const { result } = await executeMcpTool(kbServer, 'search', args, undefined, PERSON);
    expect(responseLogSummaryOf(result)).toBeUndefined();
    await logLikeARoute(kbServer, 'search', args, result);

    const row = await logOf(kbServer, args.query);
    expect(row.responsePayload).toEqual(result);
    expect(JSON.stringify(row.responsePayload)).toContain(PASSAGE);
    expect(h.resolveRagAccess).not.toHaveBeenCalled();
  });

  it('keeps the whole response that came back from another node', async () => {
    h.getRagModule.mockResolvedValue(PLAIN_MODULE);
    h.otherNode = true;
    const args = { query: 'log-plain-other-node' };

    const { result } = await executeMcpTool(kbServer, 'search', args, undefined, PERSON);
    await logLikeARoute(kbServer, 'search', args, result);

    expect(JSON.stringify((await logOf(kbServer, 'log-plain-other-node')).responsePayload)).toContain(PASSAGE);
  });
});
