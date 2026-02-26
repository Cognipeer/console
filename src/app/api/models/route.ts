import { NextRequest, NextResponse } from 'next/server';
import {
  createModel,
  listModels,
  listModelProviders,
} from '@/lib/services/models/modelService';
import { ModelCategory, type IModel } from '@/lib/database';
import { checkResourceQuota, type QuotaContext } from '@/lib/quota';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('models');

export const runtime = 'nodejs';

const SENSITIVE_FIELDS = new Set([
  'apiKey',
  'secretAccessKey',
  'serviceAccountKey',
  'sessionToken',
]);

function sanitizeSettings(settings: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};
  Object.entries(settings || {}).forEach(([key, value]) => {
    if (SENSITIVE_FIELDS.has(key)) {
      sanitized[key] = value ? '••••••••' : value;
    } else {
      sanitized[key] = value;
    }
  });
  return sanitized;
}

function sanitizeModel(model: IModel) {
  return {
    ...model,
    settings: sanitizeSettings(model.settings || {}),
  };
}

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    if (!tenantDbName) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category') as ModelCategory | null;
    const providerKey = searchParams.get('providerKey');
    const providerDriver = searchParams.get('providerDriver');
    const includeProviders = searchParams.get('includeProviders') === 'true';

    const models = await listModels(tenantDbName, projectContext.projectId, {
      category: category ?? undefined,
      providerKey: providerKey ?? undefined,
      providerDriver: providerDriver ?? undefined,
    });

    const payload: Record<string, unknown> = {
      models: models.map(sanitizeModel),
    };

    if (includeProviders) {
      payload.providers = await listModelProviders(
        tenantDbName,
        tenantId,
        projectContext.projectId,
        {},
      );
    }

    return NextResponse.json(payload, { status: 200 });
  } catch (error: unknown) {
    logger.error('List models error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
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
    const licenseType = request.headers.get('x-license-type') as LicenseType | null;

    if (!tenantDbName || !tenantId || !userId || !licenseType) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const body = await request.json();
    const required = ['name', 'providerKey', 'category', 'modelId', 'pricing', 'settings'];
    for (const field of required) {
      if (
        body[field] === undefined ||
        body[field] === null ||
        body[field] === ''
      ) {
        return NextResponse.json(
          { error: `${field} is required` },
          { status: 400 },
        );
      }
    }

    // Check quota before creating model
    const existingModels = await listModels(tenantDbName, projectContext.projectId, {});
    const quotaContext: QuotaContext = {
      tenantDbName,
      tenantId,
      projectId: projectContext.projectId,
      licenseType,
      userId,
      domain: 'llm',
    };
    const quotaCheck = await checkResourceQuota(quotaContext, 'models', existingModels.length);
    if (!quotaCheck.allowed) {
      return NextResponse.json(
        { error: quotaCheck.reason ?? 'Model quota exceeded' },
        { status: 429 },
      );
    }

    const model = await createModel(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      userId,
      {
      name: body.name,
      description: body.description,
      key: body.key,
  providerKey: body.providerKey,
      category: body.category,
      modelId: body.modelId,
      pricing: body.pricing,
      settings: body.settings,
      isMultimodal: body.isMultimodal,
      supportsToolCalls: body.supportsToolCalls,
      metadata: body.metadata,
      },
    );

    return NextResponse.json({ model: sanitizeModel(model) }, { status: 201 });
  } catch (error: unknown) {
    logger.error('Create model error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
