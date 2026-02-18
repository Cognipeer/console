import { NextRequest, NextResponse } from 'next/server';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';

/**
 * GET /api/inference-monitoring/servers
 * List all inference servers for the current tenant.
 */
export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');

    if (!tenantDbName || !tenantId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const servers = await InferenceMonitoringService.listServers(tenantDbName, tenantId);
    return NextResponse.json({ servers });
  } catch (error) {
    console.error('[inference-monitoring] list servers error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list servers' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/inference-monitoring/servers
 * Create a new inference server.
 */
export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const body = await request.json();
    const { name, type, baseUrl, apiKey, pollIntervalSeconds } = body;

    if (!name || !type || !baseUrl) {
      return NextResponse.json(
        { error: 'name, type, and baseUrl are required' },
        { status: 400 },
      );
    }

    if (type !== 'vllm') {
      return NextResponse.json(
        { error: 'Only "vllm" server type is currently supported' },
        { status: 400 },
      );
    }

    const server = await InferenceMonitoringService.createServer(
      tenantDbName,
      tenantId,
      { name, type, baseUrl, apiKey, pollIntervalSeconds },
      userId,
    );

    return NextResponse.json({ server }, { status: 201 });
  } catch (error) {
    console.error('[inference-monitoring] create server error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create server' },
      { status: 500 },
    );
  }
}
