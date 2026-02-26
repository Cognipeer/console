import { NextRequest, NextResponse } from 'next/server';
import { AlertService, VALID_METRICS, VALID_WINDOWS, VALID_MODULES, MODULE_METRICS } from '@/lib/services/alerts';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import type { AlertMetric, AlertModule } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('alert-rules');

export const runtime = 'nodejs';

/**
 * GET /api/alerts/rules — list alert rules for the active project
 */
export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const rules = await AlertService.listRules(
      tenantDbName,
      tenantId,
      projectContext.projectId,
    );

    return NextResponse.json(
      {
        rules,
        meta: {
          validMetrics: VALID_METRICS,
          validWindows: VALID_WINDOWS,
          validModules: VALID_MODULES,
          moduleMetrics: MODULE_METRICS,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    logger.error('List rules error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/alerts/rules — create a new alert rule
 */
export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const body = await request.json();

    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    if (!body.module || !VALID_MODULES.includes(body.module as AlertModule)) {
      return NextResponse.json(
        { error: `module must be one of: ${VALID_MODULES.join(', ')}` },
        { status: 400 },
      );
    }

    if (!body.metric || !VALID_METRICS.includes(body.metric as AlertMetric)) {
      return NextResponse.json(
        { error: `metric must be one of: ${VALID_METRICS.join(', ')}` },
        { status: 400 },
      );
    }

    if (!body.condition || typeof body.condition.threshold !== 'number') {
      return NextResponse.json(
        { error: 'condition with numeric threshold is required' },
        { status: 400 },
      );
    }

    if (!body.windowMinutes || !VALID_WINDOWS.includes(body.windowMinutes)) {
      return NextResponse.json(
        { error: `windowMinutes must be one of: ${VALID_WINDOWS.join(', ')}` },
        { status: 400 },
      );
    }

    const rule = await AlertService.createRule(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      userId,
      {
        name: body.name,
        description: body.description,
        module: body.module,
        metric: body.metric,
        condition: body.condition,
        windowMinutes: body.windowMinutes,
        cooldownMinutes: body.cooldownMinutes,
        scope: body.scope,
        channels: body.channels,
        enabled: body.enabled,
      },
    );

    return NextResponse.json({ rule }, { status: 201 });
  } catch (error: unknown) {
    logger.error('Create rule error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
