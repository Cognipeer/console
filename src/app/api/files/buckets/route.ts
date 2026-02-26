import { NextRequest, NextResponse } from 'next/server';
import { createFileBucket, listFileBuckets } from '@/lib/services/files';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import type { LicenseType } from '@/lib/license/license-manager';
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('file-buckets');

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

    const buckets = await listFileBuckets(
      tenantDbName,
      tenantId,
      projectContext.projectId,
    );

    return NextResponse.json({ buckets }, { status: 200 });
  } catch (error) {
    logger.error('List file buckets error', { error });
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
    const requiredFields = ['key', 'name', 'providerKey'];

    for (const field of requiredFields) {
      if (!body[field] || (typeof body[field] === 'string' && body[field].trim() === '')) {
        return NextResponse.json(
          { error: `${field} is required` },
          { status: 400 },
        );
      }
    }

    const existingBuckets = await listFileBuckets(
      tenantDbName,
      tenantId,
      projectContext.projectId,
    );

    const quotaCheck = await checkResourceQuota(
      {
        tenantDbName,
        tenantId,
        projectId: projectContext.projectId,
        licenseType,
        userId,
        domain: 'file',
        providerKey: body.providerKey,
      },
      'fileBuckets',
      existingBuckets.length,
    );

    if (!quotaCheck.allowed) {
      return NextResponse.json(
        { error: quotaCheck.reason || 'File bucket quota exceeded' },
        { status: 429 },
      );
    }

    const bucket = await createFileBucket(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      {
      key: body.key,
      name: body.name,
      providerKey: body.providerKey,
      description: body.description,
      prefix: body.prefix,
      metadata: body.metadata,
      status: body.status,
      createdBy: userId,
      },
    );

    return NextResponse.json({ bucket }, { status: 201 });
  } catch (error) {
    logger.error('Create file bucket error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
