import { NextRequest, NextResponse } from 'next/server';
import { AgentTracingService } from '@/lib/services/agentTracing';

/**
 * GET /api/tracing/agents/:agentName/overview
 * Get agent overview with analytics
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { agentName: string } }
) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    
    if (!tenantSlug) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const { agentName } = params;
    const searchParams = request.nextUrl.searchParams;
    
    const filters = {
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      timezone: searchParams.get('timezone') || undefined,
    };

    const result = await AgentTracingService.getAgentOverview(
      tenantSlug,
      decodeURIComponent(agentName),
      filters
    );

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Agent overview error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch agent overview' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest, { params }: { params: { agentName: string } }) {
  return GET(request, { params });
}
