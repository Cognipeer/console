import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  listRagDocuments,
  ingestDocument,
  ingestFile,
} from '@/lib/services/rag/ragService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('rag-documents');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  if (!tenantDbName) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { key } = await params;
    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search') ?? undefined;
    const documents = await listRagDocuments(tenantDbName, key, { projectId, search });
    return NextResponse.json({ documents });
  } catch (error) {
    logger.error('List documents error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/rag/modules/:key/documents
 *
 * Accepts two modes:
 * 1. Text mode: JSON body with { fileName, content }
 * 2. File upload mode: JSON body with { fileName, data } where data is base64 or data URL
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  const userId = request.headers.get('x-user-id') ?? 'system';
  if (!tenantDbName || !tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { key } = await params;
    const body = await request.json();
    const { fileName, content, data, contentType, metadata } = body;

    if (!fileName) {
      return NextResponse.json(
        { error: 'fileName is required' },
        { status: 400 },
      );
    }

    // File upload mode: base64/data URL in `data` field
    if (data) {
      const fileBuffer = decodeFileData(data);
      const document = await ingestFile(tenantDbName, tenantId, projectId, {
        ragModuleKey: key,
        fileName,
        fileData: fileBuffer,
        contentType,
        metadata,
        createdBy: userId,
      });
      return NextResponse.json({ document }, { status: 201 });
    }

    // Text mode: plain text in `content` field
    if (!content) {
      return NextResponse.json(
        { error: 'Either "content" (text) or "data" (base64 file) is required' },
        { status: 400 },
      );
    }

    const document = await ingestDocument(tenantDbName, tenantId, projectId, {
      ragModuleKey: key,
      fileName,
      content,
      contentType,
      metadata,
      createdBy: userId,
    });

    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    logger.error('Ingest error', { error });
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
