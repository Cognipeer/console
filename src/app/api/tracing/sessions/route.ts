import { NextRequest, NextResponse } from 'next/server';
import { AgentTracingService } from '@/lib/services/agentTracing';

/**
 * GET /api/tracing/sessions
 * List agent tracing sessions
 */
export async function GET(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    
    if (!tenantSlug) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const filters = {
      query: searchParams.get('query') || undefined,
      agent: searchParams.get('agent') || undefined,
      status: searchParams.get('status') || undefined,
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      limit: searchParams.get('limit') || '50',
      skip: searchParams.get('skip') || '0',
    };

    const result = await AgentTracingService.listSessions(tenantSlug, filters);

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('List sessions error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch sessions' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
