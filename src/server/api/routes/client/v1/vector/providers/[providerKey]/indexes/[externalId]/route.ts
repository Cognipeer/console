import { NextResponse, type NextRequest } from '@/server/api/http';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  deleteVectorIndex,
  getVectorIndex,
  updateVectorIndex,
  type VectorIndexRecord,
} from '@/lib/services/vector';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-vector-indexes');

interface RouteContext {
  params: Promise<{
    providerKey: string;
    externalId: string;
  }>;
}

function serializeIndex(index: VectorIndexRecord) {
  return {
    ...index,
    metadata: index.metadata ?? {},
    indexId: index.key,
  };
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const normalized = error.message.toLowerCase();
  return (
    normalized.includes('vector index record not found') ||
    normalized.includes('vector index metadata not found') ||
    normalized.includes('vector provider configuration not found')
  );
}

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (isNotFoundError(error)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  logger.error(`${scope} error`, { error });
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Internal server error' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { providerKey, externalId } = await context.params;
    const indexKey = externalId;
    const { tenantDbName, tenantId, projectId } = await requireApiToken(request);

    const { index, provider } = await getVectorIndex(
      tenantDbName,
      tenantId,
      projectId,
      providerKey,
      indexKey,
    );

    return NextResponse.json(
      { index: serializeIndex(index), provider },
      { status: 200 },
    );
  } catch (error) {
    return handleError(error, 'Client get vector index');
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { providerKey, externalId } = await context.params;
    const indexKey = externalId;
    const auth = await requireApiToken(request);
    const body = await request.json();

    if (body.name !== undefined && typeof body.name !== 'string') {
      return NextResponse.json(
        { error: 'name must be a string when provided' },
        { status: 400 },
      );
    }

    if (body.metadata !== undefined && typeof body.metadata !== 'object') {
      return NextResponse.json(
        { error: 'metadata must be an object when provided' },
        { status: 400 },
      );
    }

    if (body.name === undefined && body.metadata === undefined) {
      return NextResponse.json(
        { error: 'Provide a field to update' },
        { status: 400 },
      );
    }

    const index = await updateVectorIndex(
      auth.tenantDbName,
      auth.tenantId,
      auth.projectId,
      providerKey,
      indexKey,
      {
        name: body.name,
        metadata: body.metadata,
        updatedBy: auth.tokenRecord.userId,
      },
    );

    return NextResponse.json({ index: serializeIndex(index) }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client update vector index');
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { providerKey, externalId } = await context.params;
    const indexKey = externalId;
    const auth = await requireApiToken(request);

    await deleteVectorIndex(
      auth.tenantDbName,
      auth.tenantId,
      auth.projectId,
      providerKey,
      indexKey,
      { updatedBy: auth.tokenRecord.userId },
    );

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client delete vector index');
  }
}
