import { NextRequest, NextResponse } from 'next/server';
import {
  deleteModel,
  getModelById,
  updateModel,
} from '@/lib/services/models/modelService';
import { IModel } from '@/lib/database/provider.interface';
import type { UpdateModelInput } from '@/lib/services/models/types';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

export const runtime = 'nodejs';

const SENSITIVE_FIELDS = new Set([
  'apiKey',
  'secretAccessKey',
  'serviceAccountKey',
  'sessionToken',
]);
const PLACEHOLDER = '••••••••';

function sanitizeSettings(settings: Record<string, unknown>) {
  const sanitized: Record<string, unknown> = {};
  Object.entries(settings || {}).forEach(([key, value]) => {
    if (SENSITIVE_FIELDS.has(key)) {
      sanitized[key] = value ? PLACEHOLDER : value;
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

function mergeSettings(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  const merged: Record<string, unknown> = { ...existing };

  Object.entries(incoming).forEach(([key, value]) => {
    if (value === PLACEHOLDER) {
      return;
    }

    if (value === null) {
      delete merged[key];
      return;
    }

    if (value === undefined) {
      return;
    }

    merged[key] = value;
  });

  return merged;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const tenantDbName = _request.headers.get('x-tenant-db-name');
    const tenantId = _request.headers.get('x-tenant-id');
    const userId = _request.headers.get('x-user-id');
    if (!tenantDbName) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(_request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const model = await getModelById(tenantDbName, id, projectContext.projectId);

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    return NextResponse.json({ model: sanitizeModel(model) });
  } catch (error: unknown) {
    console.error('Fetch model error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
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

    const existing = await getModelById(tenantDbName, id, projectContext.projectId);

    if (!existing) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    const body = (await request.json()) as Partial<UpdateModelInput> & Record<string, unknown>;
      const updates: Partial<UpdateModelInput> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.key !== undefined) updates.key = body.key;
    if (body.modelId !== undefined) updates.modelId = body.modelId;
    if (body.pricing !== undefined) updates.pricing = body.pricing;
    if (body.isMultimodal !== undefined)
      updates.isMultimodal = body.isMultimodal;
    if (body.supportsToolCalls !== undefined)
      updates.supportsToolCalls = body.supportsToolCalls;
    if (body.metadata !== undefined) updates.metadata = body.metadata;

      if (body.settings && typeof body.settings === 'object') {
        updates.settings = mergeSettings(existing.settings || {}, body.settings as Record<string, unknown>);
    }

    const updated = await updateModel(
      tenantDbName,
      projectContext.projectId,
      id,
      updates,
      userId,
    );

    if (!updated) {
      return NextResponse.json(
        { error: 'Failed to update model' },
        { status: 500 },
      );
    }

    return NextResponse.json({ model: sanitizeModel(updated) });
  } catch (error: unknown) {
    console.error('Update model error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
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

    const success = await deleteModel(tenantDbName, projectContext.projectId, id);

    if (!success) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: unknown) {
    console.error('Delete model error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
