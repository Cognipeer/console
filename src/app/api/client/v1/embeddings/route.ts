import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { handleEmbeddingRequest } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { calculateCost, logModelUsage } from '@/lib/services/models/usageLogger';
import { checkBudget, checkPerRequestLimits, checkRateLimit } from '@/lib/quota/quotaGuard';

export const runtime = 'nodejs';

function unauthorized(message = 'Invalid API token') {
  return NextResponse.json({ error: { message, type: 'invalid_request_error' } }, { status: 401 });
}

function quotaExceeded(message = 'Quota exceeded') {
  return NextResponse.json(
    { error: { message, type: 'rate_limit_error' } },
    { status: 429 },
  );
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function extractEmbeddingInputText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input
      .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
      .join('\n');
  }
  if (input === null || input === undefined) return '';
  return JSON.stringify(input);
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

  let auth: Awaited<ReturnType<typeof requireApiToken>>;
  try {
    auth = await requireApiToken(request);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return unauthorized(error.message);
    }
    console.error('Embeddings auth error', error);
    return unauthorized();
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
    const estimatedInputTokens = estimateTokens(extractEmbeddingInputText(body.input));
    const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
    const quotaContext = {
      tenantDbName: auth.tenantDbName,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      licenseType: auth.tenant.licenseType as LicenseType,
      userId: auth.tokenRecord.userId,
      tokenId,
      domain: 'embedding' as const,
      resourceKey: body.model,
    };

    const quotaResult = await checkPerRequestLimits(quotaContext, {
      inputTokens: estimatedInputTokens,
    });

    if (!quotaResult.allowed) {
      return quotaExceeded(quotaResult.reason || 'Quota exceeded');
    }

    const rateLimitResult = await checkRateLimit(quotaContext, {
      requests: 1,
      tokens: estimatedInputTokens,
    });

    if (!rateLimitResult.allowed) {
      return quotaExceeded(rateLimitResult.reason || 'Rate limit exceeded');
    }

    const budgetResult = await checkBudget(quotaContext);
    if (!budgetResult.allowed) {
      return quotaExceeded(budgetResult.reason || 'Budget exceeded');
    }
  } catch (error) {
    console.error('Quota check error', error);
    return NextResponse.json(
      { error: { message: 'Quota check failed', type: 'server_error' } },
      { status: 500 },
    );
  }

  try {
    const result = await handleEmbeddingRequest({
      tenantDbName: auth.tenantDbName,
      modelKey: body.model,
      projectId: auth.projectId,
      body,
    });

    // Fire-and-forget budget usage update (embeddings use input tokens only).
    try {
      const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
      const quotaContext = {
        tenantDbName: auth.tenantDbName,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        licenseType: auth.tenant.licenseType as LicenseType,
        userId: auth.tokenRecord.userId,
        tokenId,
        domain: 'embedding' as const,
        resourceKey: body.model,
      };

      const estimatedInputTokens = estimateTokens(extractEmbeddingInputText(body.input));
      const model = await getModelByKey(auth.tenantDbName, body.model, auth.projectId);
      if (model) {
        const cost = calculateCost(model.pricing, {
          inputTokens: estimatedInputTokens,
          outputTokens: 0,
          totalTokens: estimatedInputTokens,
        });
        if (cost.currency === 'USD' && Number.isFinite(cost.totalCost) && cost.totalCost > 0) {
          checkBudget(quotaContext, { usd: cost.totalCost }).catch((err) =>
            console.error('Failed to update budget usage:', err),
          );
        }
      }
    } catch (budgetError) {
      console.error('Embedding budget update error', budgetError);
    }

    return NextResponse.json({ ...result.response, request_id: result.requestId }, { status: 200 });
  } catch (error: unknown) {
    console.error('Embedding error', error);

    try {
      const model = await getModelByKey(auth.tenantDbName, body.model, auth.projectId);
      if (model) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logModelUsage(auth.tenantDbName, model, {
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
