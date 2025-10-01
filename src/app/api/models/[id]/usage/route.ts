import { NextRequest, NextResponse } from 'next/server';
import { getModelById, getUsageAggregate } from '@/lib/services/models/modelService';
import { resolveTenantDbName } from '@/lib/utils/tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const tenantSlug = request.headers.get('x-tenant-slug');
    if (!tenantSlug) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { tenantDbName } = await resolveTenantDbName(tenantSlug);
    const model = await getModelById(tenantDbName, params.id);

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const groupBy = (searchParams.get('groupBy') || 'day') as 'hour' | 'day' | 'month';

    const aggregate = await getUsageAggregate(tenantDbName, model.key, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      groupBy,
    });

    return NextResponse.json({ usage: aggregate });
  } catch (error: any) {
    console.error('Fetch model usage error', error);
    return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}
