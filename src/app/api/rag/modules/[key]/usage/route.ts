import { NextRequest, NextResponse } from 'next/server';
import { listRagQueryLogs } from '@/lib/services/rag/ragService';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('rag-usage');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const tenantDbName = request.headers.get('x-tenant-db-name');
  if (!tenantDbName) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { key } = await params;
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 50;
    const from = searchParams.get('from') ? new Date(searchParams.get('from')!) : undefined;
    const to = searchParams.get('to') ? new Date(searchParams.get('to')!) : undefined;

    const logs = await listRagQueryLogs(tenantDbName, key, { limit, from, to });
    return NextResponse.json({ logs });
  } catch (error) {
    logger.error('Query logs error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
