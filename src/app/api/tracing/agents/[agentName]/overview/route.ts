import { NextRequest, NextResponse } from 'next/server';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';

/**
 * GET /api/tracing/agents/:agentName/overview
 * Get agent overview with analytics
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentName: string }> }
) {
  try {
    const { agentName } = await params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    
    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });
    const searchParams = request.nextUrl.searchParams;
    const parsedFilter = parseDashboardDateFilterFromSearchParams(searchParams);
    
    const filters = {
      from: searchParams.get('from') || parsedFilter.from?.toISOString(),
      to: searchParams.get('to') || parsedFilter.to?.toISOString(),
      timezone: searchParams.get('timezone') || undefined,
    };

    const result = await AgentTracingService.getAgentOverview(
      tenantDbName,
      projectContext.projectId,
      decodeURIComponent(agentName),
      filters
    );

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('Agent overview error:', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch agent overview' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ agentName: string }> }) {
  return GET(request, { params });
}
