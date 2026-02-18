import { NextRequest, NextResponse } from 'next/server';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';

interface RouteParams {
  params: Promise<{ serverKey: string }>;
}

/**
 * GET /api/inference-monitoring/servers/:serverKey
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const { serverKey } = await params;

    if (!tenantDbName || !tenantId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const server = await InferenceMonitoringService.getServerByKey(
      tenantDbName,
      tenantId,
      serverKey,
    );

    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    return NextResponse.json({ server });
  } catch (error) {
    console.error('[inference-monitoring] get server error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get server' },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/inference-monitoring/servers/:serverKey
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const { serverKey } = await params;

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const body = await request.json();
    const server = await InferenceMonitoringService.updateServer(
      tenantDbName,
      tenantId,
      serverKey,
      body,
      userId,
    );

    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    return NextResponse.json({ server });
  } catch (error) {
    console.error('[inference-monitoring] update server error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update server' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/inference-monitoring/servers/:serverKey
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const { serverKey } = await params;

    if (!tenantDbName || !tenantId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const deleted = await InferenceMonitoringService.deleteServer(
      tenantDbName,
      tenantId,
      serverKey,
    );

    if (!deleted) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[inference-monitoring] delete server error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete server' },
      { status: 500 },
    );
  }
}
