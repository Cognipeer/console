/**
 * Knowledge Base MCP provider — `read_document` / `read_document_lines` stay
 * inside the module AND the project the MCP server was published from.
 *
 * Module keys are unique per project, not per tenant, so a document that
 * carries another project's stamp can sit in a module with the same key.
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

vi.mock('@/lib/services/rag/ragService', () => rag);

import { knowledgeBaseProvider } from '@/lib/services/mcp/internal/knowledgeBaseProvider';

const CTX = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', projectId: 'project-a' };
const MODULE_KEY = 'docs';

function doc(overrides: Record<string, unknown> = {}) {
  return { _id: 'doc-1', tenantId: 'tenant-1', ragModuleKey: MODULE_KEY, projectId: 'project-a', fileName: 'a.md', ...overrides };
}

async function read(
  tool: 'read_document' | 'read_document_lines',
  document: ReturnType<typeof doc> | null,
  ctx: typeof CTX | Omit<typeof CTX, 'projectId'> = CTX,
) {
  rag.getRagDocument.mockResolvedValueOnce(document);
  return knowledgeBaseProvider.execute(ctx, MODULE_KEY, {}, tool, { documentId: 'doc-1' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(['read_document', 'read_document_lines'] as const)('%s', (tool) => {
  const reader = tool === 'read_document' ? rag.getRagDocumentFullText : rag.getRagDocumentTextLines;

  it('reads a document of this module in this project', async () => {
    await expect(read(tool, doc())).resolves.toBeDefined();
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('reports a document stamped with another project as missing', async () => {
    await expect(read(tool, doc({ projectId: 'project-b' }))).rejects.toThrow(/not found in this knowledge base/);
    expect(reader).not.toHaveBeenCalled();
  });

  it('gives a foreign document the same answer as an unknown id', async () => {
    const missing = await read(tool, null).catch((e: Error) => e.message);
    const foreign = await read(tool, doc({ projectId: 'project-b' })).catch((e: Error) => e.message);
    expect(foreign).toBe(missing);
  });

  it('still requires the module key to match', async () => {
    await expect(read(tool, doc({ ragModuleKey: 'other-module' }))).rejects.toThrow(/not found/);
    expect(reader).not.toHaveBeenCalled();
  });

  it('reads a document that carries no project stamp', async () => {
    await expect(read(tool, doc({ projectId: undefined }))).resolves.toBeDefined();
    await expect(read(tool, doc({ projectId: null }))).resolves.toBeDefined();
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('compares project ids as strings', async () => {
    const objectIdLike = { toString: () => 'project-a' };
    await expect(read(tool, doc({ projectId: objectIdLike }), { ...CTX, projectId: 'project-a' })).resolves.toBeDefined();
  });

  it('does not restrict a legacy server that has no project', async () => {
    const legacy = { tenantDbName: CTX.tenantDbName, tenantId: CTX.tenantId };
    await expect(read(tool, doc({ projectId: 'project-b' }), legacy)).resolves.toBeDefined();
  });
});
