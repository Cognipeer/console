import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  deleteProviderConfig,
  getProviderConfigById,
  updateProviderConfig,
  type UpdateProviderConfigInput,
} from '@/lib/services/providers/providerService';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('providers');

interface RouteContext {
  params: Promise<{
    id: string;
  }>;
}

function sanitizeUpdatePayload(body: unknown): UpdateProviderConfigInput {
  const payload: UpdateProviderConfigInput = {};

  if (typeof body !== 'object' || body === null) {
    return payload;
  }

  const record = body as Record<string, unknown>;

  if (typeof record.label === 'string') {
    payload.label = record.label;
  }

  if (
    Array.isArray(record.projectIds) &&
    record.projectIds.every((item) => typeof item === 'string')
  ) {
    payload.projectIds = record.projectIds as string[];
  }

  if (typeof record.description === 'string' || record.description === null) {
    payload.description = (record.description ?? undefined) as string | undefined;
  }

  if (
    record.status === 'active' ||
    record.status === 'disabled' ||
    record.status === 'errored'
  ) {
    payload.status = record.status;
  }

  if (typeof record.settings === 'object' && record.settings !== null) {
    payload.settings = record.settings as Record<string, unknown>;
  }

  if (
    Array.isArray(record.capabilitiesOverride) &&
    record.capabilitiesOverride.every((item) => typeof item === 'string')
  ) {
    payload.capabilitiesOverride = record.capabilitiesOverride as string[];
  }

  if (typeof record.metadata === 'object' && record.metadata !== null) {
    payload.metadata = record.metadata as Record<string, unknown>;
  }

  if (typeof record.credentials === 'object' && record.credentials !== null) {
    payload.credentials = record.credentials as Record<string, unknown>;
  }

  return payload;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');

    if (!tenantDbName || !tenantId || !userId || !userRole) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');
    if (scope === 'tenant') {
      if (userRole !== 'owner' && userRole !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const provider = await getProviderConfigById(tenantDbName, id);
      if (!provider || provider.tenantId !== tenantId) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ provider }, { status: 200 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const provider = await getProviderConfigById(tenantDbName, id);

    const assigned =
      provider &&
      (String(provider.projectId) === String(projectId) ||
        (Array.isArray(provider.projectIds) &&
          provider.projectIds.map(String).includes(String(projectId))));

    if (!provider || provider.tenantId !== tenantId || !assigned) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ provider }, { status: 200 });
  } catch (error) {
    logger.error('Get provider config error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');

    if (!tenantDbName || !tenantId || !userId || !userRole) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');
    if (scope === 'tenant') {
      if (userRole !== 'owner' && userRole !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const existing = await getProviderConfigById(tenantDbName, id);
      if (!existing || existing.tenantId !== tenantId) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }

      const body = await request.json();
      const payload = sanitizeUpdatePayload(body);
      payload.updatedBy = userId;

      const updated = await updateProviderConfig(tenantDbName, id, payload);
      if (!updated) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }

      return NextResponse.json({ provider: updated }, { status: 200 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const existing = await getProviderConfigById(tenantDbName, id);

    const assigned =
      existing &&
      (String(existing.projectId) === String(projectId) ||
        (Array.isArray(existing.projectIds) &&
          existing.projectIds.map(String).includes(String(projectId))));

    if (!existing || existing.tenantId !== tenantId || !assigned) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await request.json();
    const payload = sanitizeUpdatePayload(body);
    payload.updatedBy = userId;

    const updated = await updateProviderConfig(tenantDbName, id, payload);

    if (!updated) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ provider: updated }, { status: 200 });
  } catch (error) {
    logger.error('Update provider config error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');

    if (!tenantDbName || !tenantId || !userId || !userRole) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');
    if (scope === 'tenant') {
      if (userRole !== 'owner' && userRole !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const existing = await getProviderConfigById(tenantDbName, id);
      if (!existing || existing.tenantId !== tenantId) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }

      const deleted = await deleteProviderConfig(tenantDbName, id);
      if (!deleted) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }

      return NextResponse.json({ success: true }, { status: 200 });
    }

    let projectId: string;
    try {
      const projectContext = await requireProjectContext(request, {
        tenantDbName,
        tenantId,
        userId,
      });
      projectId = projectContext.projectId;
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const existing = await getProviderConfigById(tenantDbName, id);

    const assigned =
      existing &&
      (String(existing.projectId) === String(projectId) ||
        (Array.isArray(existing.projectIds) &&
          existing.projectIds.map(String).includes(String(projectId))));

    if (!existing || existing.tenantId !== tenantId || !assigned) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const deleted = await deleteProviderConfig(tenantDbName, id);

    if (!deleted) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error('Delete provider config error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
