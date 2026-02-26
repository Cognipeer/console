import { NextRequest, NextResponse } from 'next/server';
import { AlertService } from '@/lib/services/alerts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('alert-history');

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

/**
 * PATCH /api/alerts/history/[eventId]/acknowledge — acknowledge an alert event
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { eventId } = await params;
    const event = await AlertService.acknowledgeEvent(tenantDbName, eventId);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    return NextResponse.json({ event }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Acknowledge event error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
