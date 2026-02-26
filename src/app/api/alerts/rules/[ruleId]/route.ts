import { NextRequest, NextResponse } from 'next/server';
import { AlertService } from '@/lib/services/alerts';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('alert-rules');

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ ruleId: string }>;
}

/**
 * GET /api/alerts/rules/[ruleId] — get a single alert rule
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { ruleId } = await params;
    const rule = await AlertService.getRule(tenantDbName, ruleId);

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ rule }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Get rule error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/alerts/rules/[ruleId] — update an alert rule
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { ruleId } = await params;
    const body = await request.json();

    const rule = await AlertService.updateRule(tenantDbName, ruleId, {
      ...body,
      updatedBy: userId,
    });

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ rule }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Update rule error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/alerts/rules/[ruleId] — delete an alert rule
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { ruleId } = await params;
    const deleted = await AlertService.deleteRule(tenantDbName, ruleId);

    if (!deleted) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Delete rule error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/alerts/rules/[ruleId] — toggle enable/disable
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { ruleId } = await params;
    const body = await request.json();

    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled (boolean) is required' },
        { status: 400 },
      );
    }

    const rule = await AlertService.toggleRule(
      tenantDbName,
      ruleId,
      body.enabled,
      userId,
    );

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    return NextResponse.json({ rule }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Toggle rule error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
