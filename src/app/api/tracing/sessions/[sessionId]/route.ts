import { NextRequest, NextResponse } from 'next/server';
import { AgentTracingService } from '@/lib/services/agentTracing';

/**
 * GET /api/tracing/sessions/:sessionId
 * Get session detail with events
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;
    const tenantSlug = request.headers.get('x-tenant-slug');
    
    if (!tenantSlug) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }
    
    const result = await AgentTracingService.getSessionDetail(tenantSlug, sessionId);

    if (!result) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error('Session detail error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch session detail' },
      { status: 500 }
    );
  }
}
