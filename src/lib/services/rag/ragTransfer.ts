import JSZip from 'jszip';
import { createLogger } from '@/lib/core/logger';
import type { IRagChunkConfig, IRagDocument } from '@/lib/database';
import { listRagDocuments, getRagDocument, getRagModule, ingestDocument } from './ragService';
import { loadSourceText } from './ragSource';
import { validateChunkConfig } from './chunking';
import type { RagAccessScope } from './access/scope';

const logger = createLogger('rag-transfer');

/**
 * Knowledge Engine export/import as JSONL (one JSON object per line). An export
 * is a ZIP of JSONL parts of RAG_EXPORT_PART_SIZE documents each, so a large
 * module comes out as files small enough to import one request at a time.
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
/** Documents per JSONL part inside an export ZIP. */
export const RAG_EXPORT_PART_SIZE = 150;

export interface RagExportHeader {
  format: typeof RAG_EXPORT_FORMAT;
  version: typeof RAG_EXPORT_VERSION;
  exportedAt: string;
  module: { key: string; name: string; description?: string };
  /** Documents in the whole export, across every part. */
  documentCount: number;
  skippedDocuments: number;
  /** This file's place in the export: 1-based index, part count, documents in this part. */
  part: { index: number; count: number; documentCount: number };
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
  /** ZIP of the JSONL parts. */
  body: Buffer;
  documentCount: number;
  skippedDocuments: number;
  partCount: number;
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

/**
 * `reader` is a caller whose reads are checked (a manager while the module keeps
 * the admin exception off): the export holds the documents it reads, and
 * nothing says how many were left out.
 */
export async function exportRagModule(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  ragModuleKey: string,
  reader?: Pick<RagAccessScope, 'documentFilter' | 'canReadDocument'>,
): Promise<RagExportResult | undefined> {
  const ragModule = await getRagModule(tenantDbName, ragModuleKey, projectId);
  if (!ragModule) return undefined;

  const access = reader?.documentFilter();
  const documents = await listRagDocuments(tenantDbName, ragModuleKey, {
    projectId,
    ...(access ? { access } : {}),
  });
  const lines: string[] = [];
  let skippedDocuments = 0;

  for (const listed of documents as IRagDocument[]) {
    if (reader && !reader.canReadDocument(listed)) continue;
    // listRagDocuments drops the inline source text, and a short document keeps
    // its text nowhere else, so each document's full row is read here, one at a
    // time.
    const document = (await getRagDocument(tenantDbName, String(listed._id))) ?? listed;
    const content = await loadSourceText(tenantDbName, tenantId, projectId, document);
    if (!content) {
      skippedDocuments += 1;
      continue;
    }
    // Mongo stores an unset optional field as null; `?? undefined` keeps it
    // out of the line, since the import reads `"chunkConfig":null` as a config.
    const line: RagExportDocumentLine = {
      type: 'document',
      fileName: document.fileName,
      contentType: document.contentType ?? undefined,
      metadata: document.metadata ?? undefined,
      chunkConfig: document.chunkConfig ?? undefined,
      content,
    };
    lines.push(JSON.stringify(line));
  }

  const exportedAt = new Date().toISOString();
  const safeKey = ragModule.key.replace(/[^a-zA-Z0-9_-]/g, '_');
  // An empty module still gets one part, so the header says what was exported.
  const partCount = Math.max(1, Math.ceil(lines.length / RAG_EXPORT_PART_SIZE));
  const indexWidth = Math.max(3, String(partCount).length);
  const zip = new JSZip();

  for (let index = 0; index < partCount; index += 1) {
    const partLines = lines.slice(index * RAG_EXPORT_PART_SIZE, (index + 1) * RAG_EXPORT_PART_SIZE);
    const header: RagExportHeader = {
      format: RAG_EXPORT_FORMAT,
      version: RAG_EXPORT_VERSION,
      exportedAt,
      module: {
        key: ragModule.key,
        name: ragModule.name,
        description: ragModule.description ?? undefined,
      },
      documentCount: lines.length,
      skippedDocuments,
      part: { index: index + 1, count: partCount, documentCount: partLines.length },
    };
    const partName = `${safeKey}.part-${String(index + 1).padStart(indexWidth, '0')}.rag.jsonl`;
    zip.file(partName, [JSON.stringify(header), ...partLines].join('\n') + '\n');
  }

  return {
    fileName: `${safeKey}.rag.zip`,
    body: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    documentCount: lines.length,
    skippedDocuments,
    partCount,
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
    // null counts as absent: exports written before nulls were dropped carry it.
    chunkConfig: obj.chunkConfig == null
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
