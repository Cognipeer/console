import { NextRequest, NextResponse } from 'next/server';
import { IncidentService } from '@/lib/services/alerts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('incident-notes');

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ incidentId: string }>;
}

/**
 * POST /api/alerts/incidents/[incidentId]/notes — add a note to an incident
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');
    const userEmail = request.headers.get('x-user-email');

    if (!tenantDbName || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { incidentId } = await params;
    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 });
    }

    const incident = await IncidentService.addNote(
      tenantDbName,
      incidentId,
      userId,
      userEmail || 'Unknown',
      content,
    );

    if (!incident) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }

    return NextResponse.json({ incident }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Add note error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
