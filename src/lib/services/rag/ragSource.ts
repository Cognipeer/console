/**
 * Where a Knowledge Engine document's source text lives.
 *
 * Ingestion used to convert bytes to text, index the text and throw both away.
 * A re-index then had nothing left to read, so it rebuilt the document by
 * joining its own chunks — and chunks overlap by design, so the join repeated
 * every overlap and drifted further from the original on each pass. Everything
 * a re-index needs now lives on the document: the extracted text, and the
 * original bytes whenever the module has a bucket to hold them.
 *
 * Every write here is best effort. A bucket that is full, misconfigured or
 * momentarily unreachable must never cost a tenant an ingestion.
 */

import { createHash, randomUUID } from 'crypto';
import { createLogger } from '@/lib/core/logger';
import type { IRagDocument, IRagModule } from '@/lib/database';
import { deleteFile, downloadFile, uploadFile } from '@/lib/services/files/fileService';

const logger = createLogger('rag-source');

/**
 * Above this the extracted text goes to the module's bucket instead of onto the
 * document row.
 *
 * The row also carries chunkConfig, metadata and error text, and it is read
 * back on every document listing. Mongo caps a document at 16 MB but Cosmos —
 * what production actually runs on — caps it at 2 MB, so the tighter limit is
 * the one that matters. A JavaScript string is measured in UTF-16 code units,
 * at most 3 UTF-8 bytes each, so 250k of them cost at most ~750 KB on the wire
 * and leave the rest of the row plenty of room.
 */
export const INLINE_SOURCE_MAX_CHARS = 250_000;

/** Object keys are grouped under this prefix so a bucket stays browsable. */
const SOURCE_KEY_PREFIX = 'knowledge-engine';

/** The subset of a document that says where its source is. */
export type DocumentSourceFields = Pick<
  IRagDocument,
  'sourceText' | 'sourceTextKey' | 'sourceHash' | 'fileKey' | 'fileBucketKey' | 'fileProviderKey'
>;

export interface StoreDocumentSourceParams {
  tenantDbName: string;
  tenantId: string;
  projectId: string | undefined;
  ragModule: IRagModule;
  fileName: string;
  contentType?: string;
  /** Text as the converter produced it — what chunking ran on. */
  text: string;
  /** The upload as it arrived, when the caller had bytes rather than text. */
  fileData?: Buffer;
  createdBy: string;
}

/** Content identity of a document, used to skip re-embedding unchanged text. */
export function hashSourceText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Object keys are path segments, and a fileName can be a crawled URL. */
function safeKeySegment(fileName: string): string {
  return fileName
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document';
}

async function uploadArtifact(params: {
  tenantDbName: string;
  tenantId: string;
  projectId: string | undefined;
  bucketKey: string;
  ragModuleKey: string;
  fileName: string;
  contentType?: string;
  data: Buffer;
  createdBy: string;
  label: string;
}): Promise<string | undefined> {
  try {
    const uploaded = await uploadFile(params.tenantDbName, params.tenantId, params.projectId ?? '', {
      bucketKey: params.bucketKey,
      fileName: params.fileName,
      contentType: params.contentType,
      data: params.data,
      convertToMarkdown: false,
      keyHint: `${SOURCE_KEY_PREFIX}/${params.ragModuleKey}/${randomUUID()}-${safeKeySegment(params.fileName)}`,
      createdBy: params.createdBy,
      metadata: { ragModuleKey: params.ragModuleKey },
    });
    return uploaded.record.key;
  } catch (error) {
    logger.warn(`Failed to store the ${params.label}; ingestion continues without it`, {
      ragModuleKey: params.ragModuleKey,
      bucketKey: params.bucketKey,
      fileName: params.fileName,
      error: error instanceof Error ? error.message : error,
    });
    return undefined;
  }
}

/**
 * Persist whatever of a document's source we can, and report where it went.
 *
 * Called before the document row is written so a single insert carries the
 * result — the object keys are random, not derived from the document id.
 */
export async function storeDocumentSource(
  params: StoreDocumentSourceParams,
): Promise<DocumentSourceFields> {
  const { ragModule, text } = params;
  const bucketKey = ragModule.fileBucketKey;
  const fields: DocumentSourceFields = { sourceHash: hashSourceText(text) };

  if (text.length <= INLINE_SOURCE_MAX_CHARS) {
    fields.sourceText = text;
  } else if (bucketKey) {
    const key = await uploadArtifact({
      ...params,
      bucketKey,
      ragModuleKey: ragModule.key,
      fileName: `${safeKeySegment(params.fileName)}.md`,
      contentType: 'text/markdown',
      data: Buffer.from(text, 'utf-8'),
      label: 'extracted text',
    });
    if (key) {
      fields.sourceTextKey = key;
      fields.fileBucketKey = bucketKey;
      fields.fileProviderKey = ragModule.fileProviderKey;
    }
  } else {
    // Without a bucket the only alternative would be truncating the text, which
    // would make a later re-index silently rebuild a shorter document.
    logger.warn('Extracted text is too large to store inline and the module has no file bucket; '
      + 'a re-index of this document will have to fall back to its chunks', {
      ragModuleKey: ragModule.key,
      fileName: params.fileName,
      chars: text.length,
    });
  }

  if (params.fileData && bucketKey) {
    const key = await uploadArtifact({
      ...params,
      bucketKey,
      ragModuleKey: ragModule.key,
      data: params.fileData,
      label: 'original file',
    });
    if (key) {
      fields.fileKey = key;
      fields.fileBucketKey = bucketKey;
      fields.fileProviderKey = ragModule.fileProviderKey;
    }
  }

  return fields;
}

/** The text this document was last indexed from, inline or from the bucket. */
export async function loadSourceText(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  document: Pick<IRagDocument, 'sourceText' | 'sourceTextKey' | 'fileBucketKey'>,
): Promise<string | undefined> {
  if (typeof document.sourceText === 'string' && document.sourceText.length > 0) {
    return document.sourceText;
  }
  if (!document.sourceTextKey || !document.fileBucketKey) return undefined;

  try {
    const download = await downloadFile(
      tenantDbName,
      tenantId,
      projectId ?? '',
      document.fileBucketKey,
      document.sourceTextKey,
    );
    return download.data.toString('utf-8');
  } catch (error) {
    logger.warn('Failed to read the stored source text', {
      sourceTextKey: document.sourceTextKey,
      error: error instanceof Error ? error.message : error,
    });
    return undefined;
  }
}

/** The bytes as uploaded, so a re-index can re-run the converter over them. */
export async function loadOriginalFile(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  document: Pick<IRagDocument, 'fileKey' | 'fileBucketKey' | 'fileName' | 'contentType'>,
): Promise<{ data: Buffer; fileName: string; contentType?: string } | undefined> {
  if (!document.fileKey || !document.fileBucketKey) return undefined;

  try {
    const download = await downloadFile(
      tenantDbName,
      tenantId,
      projectId ?? '',
      document.fileBucketKey,
      document.fileKey,
    );
    return {
      data: download.data,
      fileName: document.fileName,
      contentType: download.contentType ?? document.contentType,
    };
  } catch (error) {
    logger.warn('Failed to read the stored original file', {
      fileKey: document.fileKey,
      error: error instanceof Error ? error.message : error,
    });
    return undefined;
  }
}

/**
 * Drop a document's stored objects. Deleting the row without this leaves the
 * tenant paying storage for text nothing can reach any more.
 */
export async function discardDocumentSource(
  tenantDbName: string,
  tenantId: string,
  projectId: string | undefined,
  document: Pick<IRagDocument, 'sourceTextKey' | 'fileKey' | 'fileBucketKey'>,
  deletedBy: string,
): Promise<void> {
  const bucketKey = document.fileBucketKey;
  if (!bucketKey) return;

  const keys = [document.sourceTextKey, document.fileKey].filter(
    (key): key is string => typeof key === 'string' && key.length > 0,
  );

  await Promise.all(keys.map(async (key) => {
    try {
      await deleteFile(tenantDbName, tenantId, projectId ?? '', bucketKey, key, deletedBy);
    } catch (error) {
      logger.warn('Failed to delete a stored source object', {
        bucketKey,
        key,
        error: error instanceof Error ? error.message : error,
      });
    }
  }));
}
