import { NextRequest, NextResponse } from 'next/server';
import {
  deleteRagDocument,
  getRagDocument as getRagDocumentService,
  reingestDocument,
} from '@/lib/services/rag/ragService';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string; documentId: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  if (!tenantDbName) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { documentId } = await params;
    const document = await getRagDocumentService(tenantDbName, documentId);
    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    return NextResponse.json({ document });
  } catch (error) {
    console.error('[rag] get document error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ key: string; documentId: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  if (!tenantDbName || !tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { key, documentId } = await params;
    await deleteRagDocument(tenantDbName, tenantId, projectId, {
      ragModuleKey: key,
      documentId,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[rag] delete document error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/rag/modules/:key/documents/:documentId
 *
 * Re-ingest a document. Accepts:
 * - { content } — re-ingest with new text
 * - { data, fileName? } — re-ingest with a new file (base64/data-URL)
 * - {} (empty body) — re-ingest using existing chunk content from MongoDB
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string; documentId: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  const userId = request.headers.get('x-user-id') ?? 'system';
  if (!tenantDbName || !tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
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

    const document = await reingestDocument(tenantDbName, tenantId, projectId, {
      ragModuleKey: key,
      documentId,
      content: typeof content === 'string' ? content : undefined,
      fileData,
      fileName: typeof fileName === 'string' ? fileName : undefined,
      contentType: typeof contentType === 'string' ? contentType : undefined,
      metadata: metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : undefined,
      updatedBy: userId,
    });

    return NextResponse.json({ document });
  } catch (error) {
    console.error('[rag] reingest error', error);
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
