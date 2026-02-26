import { NextRequest, NextResponse } from 'next/server';
import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring';
import { sanitizeServer, normalizeBaseUrl } from '@/lib/services/inferenceMonitoring/utils';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('inference-monitoring');

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

    return NextResponse.json({ server: sanitizeServer(server) });
  } catch (error) {
    logger.error('Get server error', { error });
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
    const { name, baseUrl, apiKey, pollIntervalSeconds, status } = body;

    const normalizedBaseUrl =
      baseUrl !== undefined && typeof baseUrl === 'string'
        ? normalizeBaseUrl(baseUrl)
        : undefined;

    // Validate baseUrl if provided
    if (baseUrl !== undefined && typeof baseUrl === 'string' && !normalizedBaseUrl) {
      return NextResponse.json(
        { error: 'Invalid base URL. Must be a valid HTTP/HTTPS URL.' },
        { status: 400 },
      );
    }

    // Validate status if provided
    if (status !== undefined && !['active', 'disabled'].includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status. Must be "active" or "disabled".' },
        { status: 400 },
      );
    }

    const update: Record<string, unknown> = {};
    if (name !== undefined && typeof name === 'string') update.name = name.slice(0, 200);
    if (baseUrl !== undefined && typeof baseUrl === 'string') update.baseUrl = normalizedBaseUrl;
    if (apiKey !== undefined) update.apiKey = apiKey ? String(apiKey) : undefined;
    if (pollIntervalSeconds !== undefined) {
      update.pollIntervalSeconds = Math.max(10, Math.min(3600, Number(pollIntervalSeconds) || 60));
    }
    if (status !== undefined) update.status = status;

    const server = await InferenceMonitoringService.updateServer(
      tenantDbName,
      tenantId,
      serverKey,
      update as Parameters<typeof InferenceMonitoringService.updateServer>[3],
      userId,
    );

    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    return NextResponse.json({ server: sanitizeServer(server) });
  } catch (error) {
    logger.error('Update server error', { error });
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
    logger.error('Delete server error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete server' },
      { status: 500 },
    );
  }
}
