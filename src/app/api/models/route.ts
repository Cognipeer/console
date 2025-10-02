import { NextRequest, NextResponse } from 'next/server';
import { createModel, listModels } from '@/lib/services/models/modelService';
import { getProviderDefinitions } from '@/lib/services/models/modelService';
import { resolveTenantDbName } from '@/lib/utils/tenant';
import { ModelCategory, ModelProviderType } from '@/lib/database';

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

function sanitizeModel(model: any) {
  return {
    ...model,
    settings: sanitizeSettings(model.settings || {}),
  };
}

export async function GET(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    if (!tenantSlug) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category') as ModelCategory | null;
    const provider = searchParams.get('provider') as ModelProviderType | null;
    const includeProviders = searchParams.get('includeProviders') === 'true';

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const models = await listModels(tenantDbName, {
      category: category ?? undefined,
      provider: provider ?? undefined,
    });

    const payload: Record<string, unknown> = {
      models: models.map(sanitizeModel),
    };

    if (includeProviders) {
      payload.providers = getProviderDefinitions();
    }

    return NextResponse.json(payload, { status: 200 });
  } catch (error: unknown) {
    console.error('List models error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantSlug || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const required = [
      'name',
      'provider',
      'category',
      'modelId',
      'pricing',
      'settings',
    ];
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

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);

    const model = await createModel(tenantDbName, tenantId, userId, {
      name: body.name,
      description: body.description,
      key: body.key,
      provider: body.provider,
      category: body.category,
      modelId: body.modelId,
      pricing: body.pricing,
      settings: body.settings,
      isMultimodal: body.isMultimodal,
      supportsToolCalls: body.supportsToolCalls,
      metadata: body.metadata,
    });

    return NextResponse.json({ model: sanitizeModel(model) }, { status: 201 });
  } catch (error: unknown) {
    console.error('Create model error', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
