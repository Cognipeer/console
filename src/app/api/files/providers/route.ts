import { NextRequest, NextResponse } from 'next/server';
import {
  createFileProvider,
  listFileProviders,
} from '@/lib/services/files';
import type { ProviderStatus } from '@/lib/services/providers/providerService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';

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
    const statusParam = searchParams.get('status');
    const driver = searchParams.get('driver') ?? undefined;

    const providers = await listFileProviders(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      {
      status: statusParam as ProviderStatus | undefined,
      driver,
      },
    );

    return NextResponse.json({ providers }, { status: 200 });
  } catch (error) {
    console.error('List file providers error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: 'Internal server error' },
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
    const requiredFields = ['key', 'driver', 'label', 'credentials'];

    for (const field of requiredFields) {
      if (body[field] === undefined || body[field] === null || body[field] === '') {
        return NextResponse.json(
          { error: `${field} is required` },
          { status: 400 },
        );
      }
    }

    const provider = await createFileProvider(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      {
      key: body.key,
      driver: body.driver,
      label: body.label,
      description: body.description,
      status: body.status,
      credentials: body.credentials,
      settings: body.settings,
      capabilitiesOverride: body.capabilitiesOverride,
      metadata: body.metadata,
      createdBy: userId,
      },
    );

    return NextResponse.json({ provider }, { status: 201 });
  } catch (error) {
    console.error('Create file provider error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
