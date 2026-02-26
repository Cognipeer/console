import { NextRequest, NextResponse } from 'next/server';
import {
  getGuardrail,
  updateGuardrail,
  deleteGuardrail,
} from '@/lib/services/guardrail';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import type { GuardrailAction, GuardrailTarget } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('guardrails');

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const guardrail = await getGuardrail(tenantDbName, id);
    if (!guardrail) {
      return NextResponse.json({ error: 'Guardrail not found' }, { status: 404 });
    }

    return NextResponse.json({ guardrail }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Get error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await requireProjectContext(request, { tenantDbName, tenantId, userId });

    const body = await request.json();

    const validActions: GuardrailAction[] = ['block', 'warn', 'flag'];
    if (body.action && !validActions.includes(body.action)) {
      return NextResponse.json({ error: 'action must be "block", "warn", or "flag"' }, { status: 400 });
    }

    const validTargets: GuardrailTarget[] = ['input', 'output', 'both'];
    if (body.target && !validTargets.includes(body.target)) {
      return NextResponse.json({ error: 'target must be "input", "output", or "both"' }, { status: 400 });
    }

    const guardrail = await updateGuardrail(tenantDbName, id, userId, {
      name: body.name,
      description: body.description,
      target: body.target,
      action: body.action,
      enabled: body.enabled,
      modelKey: body.modelKey,
      policy: body.policy,
      customPrompt: body.customPrompt,
    });

    if (!guardrail) {
      return NextResponse.json({ error: 'Guardrail not found' }, { status: 404 });
    }

    return NextResponse.json({ guardrail }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Update error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const deleted = await deleteGuardrail(tenantDbName, id);
    if (!deleted) {
      return NextResponse.json({ error: 'Guardrail not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Delete error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
