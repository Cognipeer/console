import { NextRequest, NextResponse } from 'next/server';
import {
  createGuardrail,
  listGuardrails,
  PII_CATEGORIES,
  MODERATION_CATEGORIES,
  PROMPT_SHIELD_ISSUES,
  buildDefaultPresetPolicy,
} from '@/lib/services/guardrail';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import type { GuardrailType, GuardrailAction, GuardrailTarget } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('guardrails');

export const runtime = 'nodejs';

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

    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') as GuardrailType | null;
    const enabledStr = searchParams.get('enabled');
    const enabled = enabledStr !== null ? enabledStr === 'true' : undefined;
    const search = searchParams.get('search') ?? undefined;

    // Include templates metadata when requested
    const includeTemplates = searchParams.get('includeTemplates') === 'true';

    const guardrails = await listGuardrails(tenantDbName, {
      projectId: projectContext.projectId,
      type: type ?? undefined,
      enabled,
      search,
    });

    const payload: Record<string, unknown> = { guardrails };

    if (includeTemplates) {
      payload.templates = {
        piiCategories: PII_CATEGORIES,
        moderationCategories: MODERATION_CATEGORIES,
        promptShieldIssues: PROMPT_SHIELD_ISSUES,
        defaultPresetPolicy: buildDefaultPresetPolicy(),
      };
    }

    return NextResponse.json(payload, { status: 200 });
  } catch (error: unknown) {
    logger.error('List error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

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

    const validTypes: GuardrailType[] = ['preset', 'custom'];
    if (!validTypes.includes(body.type)) {
      return NextResponse.json({ error: 'type must be "preset" or "custom"' }, { status: 400 });
    }

    const validActions: GuardrailAction[] = ['block', 'warn', 'flag'];
    if (body.action && !validActions.includes(body.action)) {
      return NextResponse.json({ error: 'action must be "block", "warn", or "flag"' }, { status: 400 });
    }

    const validTargets: GuardrailTarget[] = ['input', 'output', 'both'];
    if (body.target && !validTargets.includes(body.target)) {
      return NextResponse.json({ error: 'target must be "input", "output", or "both"' }, { status: 400 });
    }

    if (body.type === 'custom' && (!body.customPrompt || !body.customPrompt.trim())) {
      return NextResponse.json({ error: 'customPrompt is required for custom guardrails' }, { status: 400 });
    }

    const guardrail = await createGuardrail(tenantDbName, tenantId, userId, {
      name: body.name.trim(),
      description: body.description?.trim(),
      type: body.type,
      target: body.target ?? 'input',
      action: body.action ?? 'block',
      enabled: body.enabled ?? true,
      modelKey: body.modelKey,
      policy: body.policy,
      customPrompt: body.customPrompt,
      projectId: projectContext.projectId,
    });

    return NextResponse.json({ guardrail }, { status: 201 });
  } catch (error: unknown) {
    logger.error('Create error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
