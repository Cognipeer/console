import { NextRequest, NextResponse } from 'next/server';
import { createPrompt, listPrompts } from '@/lib/services/prompts';
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
    const search = searchParams.get('search') ?? undefined;

    const prompts = await listPrompts(tenantDbName, projectContext.projectId, {
      search,
    });

    return NextResponse.json({ prompts }, { status: 200 });
  } catch (error: unknown) {
    console.error('List prompts error', error);
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
    const requiredFields = ['name', 'template'];

    for (const field of requiredFields) {
      if (!body[field] || (typeof body[field] === 'string' && body[field].trim() === '')) {
        return NextResponse.json({ error: `${field} is required` }, { status: 400 });
      }
    }

    const prompt = await createPrompt(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      userId,
      {
        name: body.name,
        key: body.key,
        description: body.description,
        template: body.template,
        metadata: body.metadata,
      },
    );

    return NextResponse.json({ prompt }, { status: 201 });
  } catch (error: unknown) {
    console.error('Create prompt error', error);
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
