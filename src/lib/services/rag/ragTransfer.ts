import { createLogger } from '@/lib/core/logger';
import type { IRagChunkConfig, IRagDocument } from '@/lib/database';
import { listRagDocuments, getRagModule, ingestDocument } from './ragService';
import { loadSourceText } from './ragSource';
import { validateChunkConfig } from './chunking';

const logger = createLogger('rag-transfer');

/**
 * Knowledge Engine export/import as JSONL (one JSON object per line).
 *
 * Why JSONL and not CSV: each document carries multi-line text, a nested
 * metadata object and an optional chunkConfig. CSV would need escaping for
 * newlines and quotes and would flatten the nested fields; JSONL keeps each
 * document as one self-contained line, so it streams, diffs and survives a
 * partial edit.
 *
 * Vectors are deliberately not exported. They are tied to the embedding model
 * and dimension of the module that produced them, so the import re-chunks and
 * re-embeds the source text with the target module's own configuration.
 */

export const RAG_EXPORT_FORMAT = 'cognipeer.rag-module';
export const RAG_EXPORT_VERSION = 1;
/** Upper bound on documents in one import, so one request can't queue unbounded work. */
export const RAG_IMPORT_MAX_DOCUMENTS = 5_000;

export interface RagExportHeader {
  format: typeof RAG_EXPORT_FORMAT;
  version: typeof RAG_EXPORT_VERSION;
  exportedAt: string;
  module: { key: string; name: string; description?: string };
  documentCount: number;
  skippedDocuments: number;
}

export interface RagExportDocumentLine {
  type: 'document';
  fileName: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  chunkConfig?: IRagChunkConfig;
  content: string;
}

export interface RagExportResult {
  fileName: string;
  body: string;
  documentCount: number;
  skippedDocuments: number;
}

export interface RagImportError {
  line: number;
  fileName?: string;
  message: string;
}

export interface RagImportResult {
  total: number;
  imported: number;
  failed: number;
  errors: RagImportError[];
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function exportRagModule(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  ragModuleKey: string,
): Promise<RagExportResult | undefined> {
  const ragModule = await getRagModule(tenantDbName, ragModuleKey, projectId);
  if (!ragModule) return undefined;

  const documents = await listRagDocuments(tenantDbName, ragModuleKey, { projectId });
  const lines: string[] = [];
  let skippedDocuments = 0;

  for (const document of documents as IRagDocument[]) {
    // listRagDocuments trims inline source text, so the full text is loaded per
    // document here. Only the body is kept in memory, one document at a time.
    const content = await loadSourceText(tenantDbName, tenantId, projectId, document);
    if (!content) {
      skippedDocuments += 1;
      continue;
    }
    const line: RagExportDocumentLine = {
      type: 'document',
      fileName: document.fileName,
      contentType: document.contentType,
      metadata: document.metadata,
      chunkConfig: document.chunkConfig,
      content,
    };
    lines.push(JSON.stringify(line));
  }

  const header: RagExportHeader = {
    format: RAG_EXPORT_FORMAT,
    version: RAG_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    module: {
      key: ragModule.key,
      name: ragModule.name,
      description: ragModule.description,
    },
    documentCount: lines.length,
    skippedDocuments,
  };

  const safeKey = ragModule.key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    fileName: `${safeKey}.rag.jsonl`,
    body: [JSON.stringify(header), ...lines].join('\n') + '\n',
    documentCount: lines.length,
    skippedDocuments,
  };
}

/** Parses one JSONL line into a document, or throws with a reason the user can act on. */
function parseDocumentLine(raw: string): RagExportDocumentLine {
  const value = JSON.parse(raw) as unknown;
  const obj = plainObject(value);
  if (!obj) throw new Error('line is not a JSON object');
  if (typeof obj.fileName !== 'string' || obj.fileName === '') {
    throw new Error('fileName is required');
  }
  if (typeof obj.content !== 'string' || obj.content === '') {
    throw new Error('content is required');
  }
  return {
    type: 'document',
    fileName: obj.fileName,
    contentType: typeof obj.contentType === 'string' ? obj.contentType : undefined,
    metadata: plainObject(obj.metadata),
    chunkConfig: obj.chunkConfig === undefined
      ? undefined
      : validateChunkConfig(obj.chunkConfig, 'chunkConfig'),
    content: obj.content,
  };
}

/**
 * Imports a JSONL export into an existing module. Each document goes through the
 * normal ingest path, so unchanged content is skipped by hash and the rest is
 * chunked and embedded in the background (deferIndexing).
 */
export async function importRagModuleJsonl(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  ragModuleKey: string,
  createdBy: string,
  data: string,
): Promise<RagImportResult> {
  const target = await getRagModule(tenantDbName, ragModuleKey, projectId);
  if (!target) throw new Error(`Knowledge Engine module "${ragModuleKey}" not found`);
  if (target.status !== 'active') throw new Error('Knowledge Engine module is not active');

  const rawLines = data.split(/\r?\n/);
  const result: RagImportResult = { total: 0, imported: 0, failed: 0, errors: [] };

  const entries: Array<{ line: number; raw: string }> = [];
  rawLines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    entries.push({ line: index + 1, raw: trimmed });
  });

  // The header is optional: a plain JSONL of {fileName, content} also imports.
  if (entries.length > 0) {
    const first = plainObject(safeParse(entries[0].raw));
    if (first?.format === RAG_EXPORT_FORMAT) {
      if (first.version !== RAG_EXPORT_VERSION) {
        throw new Error(`Unsupported export version: ${String(first.version)}`);
      }
      entries.shift();
    }
  }

  if (entries.length > RAG_IMPORT_MAX_DOCUMENTS) {
    throw new Error(`An import may contain at most ${RAG_IMPORT_MAX_DOCUMENTS} documents`);
  }

  result.total = entries.length;

  for (const entry of entries) {
    let parsed: RagExportDocumentLine;
    try {
      parsed = parseDocumentLine(entry.raw);
    } catch (error) {
      result.failed += 1;
      result.errors.push({ line: entry.line, message: error instanceof Error ? error.message : 'invalid line' });
      continue;
    }

    try {
      await ingestDocument(tenantDbName, tenantId, projectId, {
        ragModuleKey,
        fileName: parsed.fileName,
        content: parsed.content,
        contentType: parsed.contentType,
        metadata: parsed.metadata,
        chunkConfig: parsed.chunkConfig,
        deferIndexing: true,
        createdBy,
      });
      result.imported += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        line: entry.line,
        fileName: parsed.fileName,
        message: error instanceof Error ? error.message : 'ingest failed',
      });
    }
  }

  logger.info('RAG module JSONL import finished', {
    ragModuleKey,
    total: result.total,
    imported: result.imported,
    failed: result.failed,
  });
  return result;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
