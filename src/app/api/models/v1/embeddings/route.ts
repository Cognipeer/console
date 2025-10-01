import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getDatabase } from '@/lib/database';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { logModelUsage } from '@/lib/services/models/usageLogger';

export const runtime = 'nodejs';

function unauthorized(message = 'Invalid API token') {
  return NextResponse.json({ error: { message, type: 'invalid_request_error' } }, { status: 401 });
}

function sanitize(value: any, max = 20000) {
  if (value === null || value === undefined) return value;
  try {
    const str = JSON.stringify(value);
    if (str.length <= max) return value;
    return { truncated: true, preview: str.slice(0, max) };
  } catch {
    return '[unserializable]';
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized('Missing Bearer token');
  }

  const token = authHeader.substring(7);
  const db = await getDatabase();
  const apiToken = await db.findApiTokenByToken(token);

  if (!apiToken) {
    return unauthorized();
  }

  await db.updateTokenLastUsed(token);

  const tenant = await db.findTenantById(apiToken.tenantId);
  if (!tenant) {
    return NextResponse.json({ error: { message: 'Tenant not found', type: 'invalid_request_error' } }, { status: 404 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, { status: 400 });
  }

  if (!body?.model) {
    return NextResponse.json({ error: { message: '`model` is required', type: 'invalid_request_error' } }, { status: 400 });
  }

  try {
    const result = await handleEmbeddingRequest({
      tenantDbName: tenant.dbName,
      modelKey: body.model,
      body,
    });

    return NextResponse.json({ ...result.response, request_id: result.requestId }, { status: 200 });
  } catch (error: unknown) {
    console.error('Embedding error', error);

    try {
      const model = await getModelByKey(tenant.dbName, body.model);
      if (model) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logModelUsage(tenant.dbName, model, {
          requestId: body?.request_id || crypto.randomUUID(),
          route: 'embeddings',
          status: 'error',
          providerRequest: sanitize({ model: body.model, body }),
          providerResponse: sanitize({ error: errorMessage }),
          errorMessage,
          latencyMs: Date.now() - startedAt,
          usage: {},
        });
      }
    } catch (logError) {
      console.error('Failed to log embedding error', logError);
    }

    const errorMessage = error instanceof Error ? error.message : 'Inference error';
    return NextResponse.json({ error: { message: errorMessage, type: 'server_error' } }, { status: 500 });
  }
}
