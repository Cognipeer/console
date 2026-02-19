import { NextRequest, NextResponse } from 'next/server';
import { queryRag } from '@/lib/services/rag/ragService';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  const tenantId = request.headers.get('x-tenant-id');
  const projectId = request.headers.get('x-project-id') ?? undefined;
  if (!tenantDbName || !tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { key } = await params;
    const body = await request.json();
    const { query, topK, filter } = body;

    if (!query) {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }

    const result = await queryRag(tenantDbName, tenantId, projectId, {
      ragModuleKey: key,
      query,
      topK,
      filter,
    });

    return NextResponse.json({ result });
  } catch (error) {
    console.error('[rag] query error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
