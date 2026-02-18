import { NextRequest, NextResponse } from 'next/server';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';

interface RouteParams {
  params: Promise<{ serverKey: string }>;
}

/**
 * POST /api/inference-monitoring/servers/:serverKey/poll
 * Manually trigger a poll for this server.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const { serverKey } = await params;

    if (!tenantDbName || !tenantId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const metrics = await InferenceMonitoringService.pollServer(
      tenantDbName,
      tenantId,
      serverKey,
    );

    return NextResponse.json({ metrics });
  } catch (error) {
    console.error('[inference-monitoring] poll error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to poll server' },
      { status: 500 },
    );
  }
}
