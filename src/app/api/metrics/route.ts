import { NextRequest, NextResponse } from 'next/server';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { collectPrometheusMetrics } from '@/lib/services/metrics/prometheusExporter';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('metrics');

export const runtime = 'nodejs';

/**
 * GET /api/metrics
 *
 * Returns Prometheus-format metrics for all modules of the authenticated tenant.
 * Authentication: Bearer token (API token).
 *
 * Intended for use by Prometheus scrapers and compatible systems (e.g. Grafana).
 * Content-Type: text/plain; version=0.0.4; charset=utf-8
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    const body = await collectPrometheusMetrics(ctx.tenantDbName, ctx.tenantId);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error('Collection error', { error });
    return NextResponse.json(
      { error: 'Failed to collect metrics' },
      { status: 500 },
    );
  }
}
