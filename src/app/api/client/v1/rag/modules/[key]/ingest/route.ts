export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { ingestDocument, ingestFile } from '@/lib/services/rag/ragService';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-rag');

/**
 * POST /api/client/v1/rag/modules/:key/ingest
 *
 * Accepts two modes:
 * 1. Text mode:  { fileName, content }
 * 2. File mode:  { fileName, data }  (base64 or data-URL encoded file)
 */
const _POST = async (
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) => {
  try {
    const ctx = await requireApiToken(request);
    const { key } = await params;
    const body = await request.json();
    const { fileName, content, data, contentType, metadata } = body;

    if (!fileName) {
      return NextResponse.json(
        { error: 'fileName is required' },
        { status: 400 },
      );
    }

    // File upload mode
    if (data) {
      const fileBuffer = decodeFileData(data);
      const document = await ingestFile(
        ctx.tenantDbName,
        ctx.tenantId,
        undefined, // tenant-wide module lookup; key is unique per tenant
        {
          ragModuleKey: key,
          fileName,
          fileData: fileBuffer,
          contentType,
          metadata,
          createdBy: ctx.tokenRecord.userId,
        },
      );
      return NextResponse.json({ document }, { status: 201 });
    }

    // Text mode
    if (!content) {
      return NextResponse.json(
        { error: 'Either "content" (text) or "data" (base64 file) is required' },
        { status: 400 },
      );
    }

    const document = await ingestDocument(
      ctx.tenantDbName,
      ctx.tenantId,
      undefined, // tenant-wide module lookup; key is unique per tenant
      {
        ragModuleKey: key,
        fileName,
        content,
        contentType,
        metadata,
        createdBy: ctx.tokenRecord.userId,
      },
    );

    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('RAG ingest error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
};

export const POST = withRequestContext(_POST);

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
