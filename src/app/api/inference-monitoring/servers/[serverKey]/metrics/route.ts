import { NextRequest, NextResponse } from 'next/server';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';

interface RouteParams {
  params: Promise<{ serverKey: string }>;
}

/**
 * GET /api/inference-monitoring/servers/:serverKey/metrics
 * Get metrics history for a server.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const { serverKey } = await params;

    if (!tenantDbName || !tenantId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    // Verify server exists and belongs to tenant
    const server = await InferenceMonitoringService.getServerByKey(
      tenantDbName,
      tenantId,
      serverKey,
    );
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const from = searchParams.get('from') || undefined;
    const to = searchParams.get('to') || undefined;
    const limit = searchParams.get('limit')
      ? parseInt(searchParams.get('limit')!, 10)
      : 500;

    const metrics = await InferenceMonitoringService.getMetrics(
      tenantDbName,
      serverKey,
      { from, to, limit },
    );

    return NextResponse.json({ metrics });
  } catch (error) {
    console.error('[inference-monitoring] get metrics error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get metrics' },
      { status: 500 },
    );
  }
}
