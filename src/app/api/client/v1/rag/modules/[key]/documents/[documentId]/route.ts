export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { deleteRagDocument, reingestDocument } from '@/lib/services/rag/ragService';

/**
 * DELETE /api/client/v1/rag/modules/:key/documents/:documentId
 * Delete a document and its chunks from a RAG module
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ key: string; documentId: string }> },
) {
  try {
    const ctx = await requireApiToken(request);
    const { key, documentId } = await params;

    await deleteRagDocument(
      ctx.tenantDbName,
      ctx.tenantId,
      undefined, // tenant-wide module lookup
      {
        ragModuleKey: key,
        documentId,
      },
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[client/rag/delete-doc]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/client/v1/rag/modules/:key/documents/:documentId
 *
 * Re-ingest a document. Accepts:
 * - { content } — re-ingest with new text
 * - { data, fileName? } — re-ingest with a new file (base64/data-URL)
 * - {} (empty body) — re-ingest using existing chunks
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string; documentId: string }> },
) {
  try {
    const ctx = await requireApiToken(request);
    const { key, documentId } = await params;
    const body = await request.json().catch(() => ({}));
    const {
      content,
      data,
      base64,
      fileName,
      contentType,
      metadata,
    } = body as Record<string, unknown>;
    const encodedData = typeof data === 'string'
      ? data
      : (typeof base64 === 'string' ? base64 : undefined);

    let fileData: Buffer | undefined;
    if (encodedData) {
      fileData = decodeFileData(encodedData);
    }

    const document = await reingestDocument(
      ctx.tenantDbName,
      ctx.tenantId,
      undefined, // tenant-wide module lookup
      {
        ragModuleKey: key,
        documentId,
        content: typeof content === 'string' ? content : undefined,
        fileData,
        fileName: typeof fileName === 'string' ? fileName : undefined,
        contentType: typeof contentType === 'string' ? contentType : undefined,
        metadata: metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : undefined,
        updatedBy: ctx.tokenRecord.userId,
      },
    );

    return NextResponse.json({ document });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[client/rag/reingest]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/** Decode base64 or data URL to Buffer */
function decodeFileData(payload: string): Buffer {
  if (payload.startsWith('data:')) {
    const commaIndex = payload.indexOf(',');
    if (commaIndex !== -1) {
      return Buffer.from(payload.slice(commaIndex + 1), 'base64');
    }
  }
  return Buffer.from(payload, 'base64');
}
