import { NextResponse, type NextRequest } from '@/server/api/http';
import { IncidentService } from '@/lib/services/alerts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('incident-detail');

interface RouteParams {
  params: Promise<{ incidentId: string }>;
}

/**
 * GET /api/alerts/incidents/[incidentId] — get incident detail
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    if (!tenantDbName) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { incidentId } = await params;
    const incident = await IncidentService.getIncident(tenantDbName, incidentId);

    if (!incident) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }

    return NextResponse.json({ incident }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Get incident error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/alerts/incidents/[incidentId] — update incident status
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { incidentId } = await params;
    const body = await request.json();
    const { status } = body;

    if (!status) {
      return NextResponse.json({ error: 'Status is required' }, { status: 400 });
    }

    const validStatuses = ['open', 'acknowledged', 'investigating', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
        { status: 400 },
      );
    }

    const incident = await IncidentService.updateStatus(
      tenantDbName,
      incidentId,
      status,
      userId,
    );

    if (!incident) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }

    return NextResponse.json({ incident }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Update incident error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
