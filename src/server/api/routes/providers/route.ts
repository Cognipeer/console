import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  createProviderConfig,
  listProviderConfigs,
  type CreateProviderConfigInput,
  type ProviderStatus,
} from '@/lib/services/providers/providerService';
import type { ProviderDomain } from '@/lib/database';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('providers');

function parseStatus(value: string | null): ProviderStatus | undefined {
  if (!value) return undefined;
  if (value === 'active' || value === 'disabled' || value === 'errored') {
    return value;
  }
  return undefined;
}

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');

    if (!tenantDbName || !tenantId || !userId || !userRole) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');
    const type = searchParams.get('type') as ProviderDomain | null;
    const driver = searchParams.get('driver');
    const status = parseStatus(searchParams.get('status'));

    if (scope === 'tenant') {
      if (userRole !== 'owner' && userRole !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const providers = await listProviderConfigs(tenantDbName, tenantId, {
        type: type ?? undefined,
        driver: driver ?? undefined,
        status,
      });

      return NextResponse.json({ providers }, { status: 200 });
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

    const providers = await listProviderConfigs(tenantDbName, tenantId, {
      type: type ?? undefined,
      driver: driver ?? undefined,
      status,
      projectId,
    });

    return NextResponse.json({ providers }, { status: 200 });
  } catch (error) {
    logger.error('List providers error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateCreatePayload(body: unknown): asserts body is CreateProviderConfigInput {
  if (!isRecord(body)) {
    throw new Error('Invalid payload');
  }
  const requiredFields = ['key', 'type', 'driver', 'label', 'credentials', 'createdBy'];
  for (const field of requiredFields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new Error(`${field} is required`);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    const userRole = request.headers.get('x-user-role');

    if (!tenantDbName || !tenantId || !userId || !userRole) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (userRole !== 'owner' && userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');

    // Tenant-scoped provider creation (no automatic project assignment)
    if (scope === 'tenant') {
      const body = await request.json();
      body.createdBy = userId;
      validateCreatePayload(body);

      const provider = await createProviderConfig(tenantDbName, tenantId, {
        key: body.key,
        type: body.type,
        driver: body.driver,
        label: body.label,
        description: body.description,
        status: body.status,
        credentials: body.credentials,
        settings: body.settings,
        capabilitiesOverride: body.capabilitiesOverride,
        metadata: body.metadata,
        createdBy: userId,
      });

      return NextResponse.json({ provider }, { status: 201 });
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

    const body = await request.json();
    body.createdBy = userId;
    validateCreatePayload(body);

    const provider = await createProviderConfig(tenantDbName, tenantId, {
      projectId,
      key: body.key,
      type: body.type,
      driver: body.driver,
      label: body.label,
      description: body.description,
      status: body.status,
      credentials: body.credentials,
      settings: body.settings,
      capabilitiesOverride: body.capabilitiesOverride,
      metadata: body.metadata,
      createdBy: userId,
    });

    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('already exists')) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      logger.error('Create provider error', { error: error.message });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logger.error('Create provider error', { error });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
