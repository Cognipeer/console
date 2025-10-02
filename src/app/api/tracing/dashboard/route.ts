import { NextRequest, NextResponse } from 'next/server';
import { AgentTracingService } from '@/lib/services/agentTracing';

/**
 * GET /api/tracing/dashboard
 * Get agent tracing dashboard overview
 */
export async function GET(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');

    console.log('Dashboard request headers:', {
      tenantSlug,
      userId: request.headers.get('x-user-id'),
      licenseType: request.headers.get('x-license-type'),
    });

    if (!tenantSlug) {
      console.error('No tenant slug found in headers');
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const from = searchParams.get('from') || undefined;
    const to = searchParams.get('to') || undefined;
    const timezone = searchParams.get('timezone') || undefined;

    const overview = await AgentTracingService.getDashboardOverview(
      tenantSlug,
      {
        from,
        to,
        timezone,
      },
    );

    return NextResponse.json(overview);
  } catch (error: unknown) {
    console.error('Dashboard overview error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch dashboard data',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
