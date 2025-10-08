import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { upsertVectors } from '@/lib/services/vector';

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

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { providerKey, externalId } = await context.params;
    const indexKey = externalId;
    const auth = await requireApiToken(request);
    const body = await request.json();

    if (!Array.isArray(body.vectors) || body.vectors.length === 0) {
      return NextResponse.json(
        { error: 'vectors array is required' },
        { status: 400 },
      );
    }

    const invalidEntry = body.vectors.find(
      (entry: Record<string, unknown>) =>
        typeof entry?.id !== 'string' || !Array.isArray(entry?.values),
    );

    if (invalidEntry) {
      return NextResponse.json(
        { error: 'Each vector must include an id and values array.' },
        { status: 400 },
      );
    }

    await upsertVectors(auth.tenantDbName, auth.tenantId, {
      providerKey,
      indexKey,
      vectors: body.vectors,
      updatedBy: auth.tokenRecord.userId,
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    return handleError(error, 'Client upsert vectors');
  }
}
