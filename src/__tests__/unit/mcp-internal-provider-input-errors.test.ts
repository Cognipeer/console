/**
 * The internal MCP providers (Knowledge Base, Agent Observability) report a
 * problem with the caller's arguments as an input error — a message written for
 * any caller, answered as JSON-RPC "invalid params" and not counted against the
 * server's health — and keep a plain error for a problem with the server's own
 * configuration. What a caller's text echoes back in such a message is bounded.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const rag = vi.hoisted(() => ({
  getRagDocument: vi.fn(),
  getRagDocumentFullText: vi.fn(async () => ({ documentId: 'doc', text: 'WHOLE TEXT' })),
  getRagDocumentTextLines: vi.fn(async () => ({ documentId: 'doc', text: 'LINES' })),
  listRagModules: vi.fn(),
  getRagModule: vi.fn(),
  queryRag: vi.fn(),
}));

const tracing = vi.hoisted(() => ({
  getSessionDetail: vi.fn(),
  listSessions: vi.fn(),
  // Who a session was made for and what it is marked with: nothing restricted here.
  getSessionAccessFacts: vi.fn(async () => null),
}));

vi.mock('@/lib/services/rag/ragService', () => rag);
vi.mock('@/lib/services/agentTracing', () => ({ AgentTracingService: tracing }));

import { McpToolInputError } from '@/lib/services/mcp/errors';
import { agentObservabilityProvider } from '@/lib/services/mcp/internal/agentObservabilityProvider';
import { knowledgeBaseProvider } from '@/lib/services/mcp/internal/knowledgeBaseProvider';

const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'project-a' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Knowledge Base provider', () => {
  const run = (tool: string, args: Record<string, unknown>) => knowledgeBaseProvider.execute(CTX, 'docs', {}, tool, args);

  it.each([
    ['search without a query', 'search', {}, '"query" is required'],
    ['search with a blank query', 'search', { query: '   ' }, '"query" is required'],
    ['read_document without a documentId', 'read_document', {}, '"documentId" is required'],
    ['read_document_lines with a non-string documentId', 'read_document_lines', { documentId: 5 }, '"documentId" is required'],
  ])('reports %s as an input error', async (_name, tool, args, message) => {
    const error = await run(tool, args).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolInputError);
    expect((error as Error).message).toBe(message);
    expect(rag.queryRag).not.toHaveBeenCalled();
  });

  it('reports a switched-off knowledge base as an input error', async () => {
    const { RagModuleInactiveError } = await import('@/lib/services/rag/errors');
    rag.queryRag.mockRejectedValueOnce(new RagModuleInactiveError());
    const error = await run('search', { query: 'hello' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolInputError);
    expect((error as Error).message).toBe('Knowledge Engine module is not active');
  });

  it('reports an unknown or foreign document as an input error', async () => {
    rag.getRagDocument.mockResolvedValueOnce(null);
    const error = await run('read_document', { documentId: 'doc-404' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolInputError);
    expect((error as Error).message).toBe('Document "doc-404" not found in this knowledge base');
  });

  it('repeats only the first 100 characters of a document id', async () => {
    rag.getRagDocument.mockResolvedValueOnce(null);
    const error = await run('read_document', { documentId: 'x'.repeat(5000) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolInputError);
    expect((error as Error).message.length).toBeLessThan(200);
  });

  it('keeps a plain error for problems that are not the caller\'s', async () => {
    const unknownTool = await run('drop_everything', {}).catch((caught: unknown) => caught);
    expect(unknownTool).toBeInstanceOf(Error);
    expect(unknownTool).not.toBeInstanceOf(McpToolInputError);

    rag.getRagDocument.mockResolvedValueOnce({ _id: 'd', ragModuleKey: 'docs', projectId: 'project-a' });
    rag.getRagDocumentFullText.mockResolvedValueOnce(null as never);
    const noText = await run('read_document', { documentId: 'd' }).catch((caught: unknown) => caught);
    expect(noText).toBeInstanceOf(Error);
    expect(noText).not.toBeInstanceOf(McpToolInputError);

    rag.getRagModule.mockResolvedValueOnce(null);
    const missingModule = await knowledgeBaseProvider.validateInstance(CTX, 'gone', {}).catch((caught: unknown) => caught);
    expect(missingModule).not.toBeInstanceOf(McpToolInputError);
  });

  it('still answers a valid search', async () => {
    rag.queryRag.mockResolvedValueOnce({ query: 'q', matches: [{ documentId: 'd' }] });
    await expect(run('search', { query: ' q ' })).resolves.toEqual({ query: 'q', matches: [{ documentId: 'd' }] });
  });
});

describe('Agent Observability provider', () => {
  const run = (tool: string, args: Record<string, unknown>, ctx = CTX) =>
    agentObservabilityProvider.execute(ctx, 'project', {}, tool, args);

  it('reports a missing session id as an input error', async () => {
    const error = await run('get_session_detail', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolInputError);
    expect((error as Error).message).toBe('"sessionId" is required');
    expect(tracing.getSessionDetail).not.toHaveBeenCalled();
  });

  it('reports an unknown session as an input error, repeating only the start of the id', async () => {
    tracing.getSessionDetail.mockResolvedValueOnce(null);
    const error = await run('get_session_detail', { sessionId: 'sess-404' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpToolInputError);
    expect((error as Error).message).toBe('Session sess-404 not found');

    tracing.getSessionDetail.mockResolvedValueOnce(null);
    const long = await run('get_session_detail', { sessionId: 's'.repeat(5000) }).catch((caught: unknown) => caught);
    expect((long as Error).message.length).toBeLessThan(200);
  });

  it('keeps a plain error for problems that are not the caller\'s', async () => {
    const noProject = await run('list_agents', {}, { tenantDbName: 'tenant_db', tenantId: 'tenant-1' } as never)
      .catch((caught: unknown) => caught);
    expect(noProject).toBeInstanceOf(Error);
    expect(noProject).not.toBeInstanceOf(McpToolInputError);

    const unknownTool = await run('drop_everything', {}).catch((caught: unknown) => caught);
    expect(unknownTool).toBeInstanceOf(Error);
    expect(unknownTool).not.toBeInstanceOf(McpToolInputError);
  });

  it('still returns a session', async () => {
    tracing.getSessionDetail.mockResolvedValueOnce({ session: { id: 's1' }, events: [{}, {}] });
    await expect(run('get_session_detail', { sessionId: 's1' })).resolves.toEqual({ session: { id: 's1' }, eventCount: 2 });
  });
});
