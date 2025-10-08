import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { deleteVectors } from '@/lib/services/vector';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{
    providerKey: string;
    externalId: string;
  }>;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const normalized = error.message.toLowerCase();
  return (
    normalized.includes('vector index record not found') ||
    normalized.includes('vector index metadata not found')
  );
}

function handleError(error: unknown, scope: string) {
  if (error instanceof ApiTokenAuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (isNotFoundError(error)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  console.error(`${scope} error`, error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Internal server error' },
    { status: 500 },
  );
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { providerKey, externalId } = await context.params;
    const indexKey = externalId;
    const auth = await requireApiToken(request);
    const body = await request.json();

    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];

    if (ids.length === 0) {
      return NextResponse.json(
        { error: 'ids array is required' },
        { status: 400 },
      );
    }

    await deleteVectors(auth.tenantDbName, auth.tenantId, {
      providerKey,
      indexKey,
      ids,
      updatedBy: auth.tokenRecord.userId,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client delete vectors');
  }
}
