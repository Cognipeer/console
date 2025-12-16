import { NextRequest, NextResponse } from 'next/server';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

/**
 * GET /api/tracing/dashboard
 * Get agent tracing dashboard overview
 */
export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    console.log('Dashboard request headers:', {
      tenantDbName,
      userId: request.headers.get('x-user-id'),
      licenseType: request.headers.get('x-license-type'),
    });

    if (!tenantDbName || !tenantId || !userId) {
      console.error('No tenant db name found in headers');
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const searchParams = request.nextUrl.searchParams;
    const from = searchParams.get('from') || undefined;
    const to = searchParams.get('to') || undefined;
    const timezone = searchParams.get('timezone') || undefined;

    const overview = await AgentTracingService.getDashboardOverview(
      tenantDbName,
      projectContext.projectId,
      {
        from,
        to,
        timezone,
      },
    );

    return NextResponse.json(overview);
  } catch (error: unknown) {
    console.error('Dashboard overview error:', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
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
