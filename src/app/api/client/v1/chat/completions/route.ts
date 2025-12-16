import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { handleChatCompletion } from '@/lib/services/models/inferenceService';
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
  // Lightweight heuristic: ~4 chars per token.
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function extractMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];

  for (const msg of messages as any[]) {
    const content = msg?.content;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }
    // OpenAI-style multimodal content can be an array of parts.
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'string') {
          parts.push(part);
        } else if (typeof part?.text === 'string') {
          parts.push(part.text);
        }
      }
      continue;
    }
  }

  return parts.join('\n');
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
    console.error('Chat auth error', error);
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
    const requestedOutputTokens =
      typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : typeof body.max_tokens === 'number'
          ? body.max_tokens
          : undefined;
    const inputText = extractMessageText(body.messages);
    const estimatedInputTokens = estimateTokens(inputText);
    const estimatedTotalTokens =
      requestedOutputTokens === undefined
        ? estimatedInputTokens
        : estimatedInputTokens + requestedOutputTokens;

    const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
    const quotaContext = {
      tenantDbName: auth.tenantDbName,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      licenseType: auth.tenant.licenseType as LicenseType,
      userId: auth.tokenRecord.userId,
      tokenId,
      domain: 'llm' as const,
      resourceKey: body.model,
    };

    const quotaResult = await checkPerRequestLimits(
      quotaContext,
      {
        inputTokens: estimatedInputTokens,
        outputTokens: requestedOutputTokens,
        totalTokens: estimatedTotalTokens,
      },
    );

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

  // Keep context for post-request updates
  const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
  const quotaContext = {
    tenantDbName: auth.tenantDbName,
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    licenseType: auth.tenant.licenseType as LicenseType,
    userId: auth.tokenRecord.userId,
    tokenId,
    domain: 'llm' as const,
    resourceKey: body.model,
  };

  try {
    const result = await handleChatCompletion({
      tenantDbName: auth.tenantDbName,
      modelKey: body.model,
      projectId: auth.projectId,
      body,
      stream: Boolean(body.stream),
    });

    // Update rate limits with actual usage
    // We already counted input tokens, so we add output tokens
    // and correct any difference in input tokens if needed (though we use estimate for now)
    const actualOutputTokens = result.usage?.outputTokens || 0;
    if (actualOutputTokens > 0) {
      // Fire and forget - don't block response
      checkRateLimit(quotaContext, { tokens: actualOutputTokens }).catch(err => 
        console.error('Failed to update rate limit usage:', err)
      );
    }

    // Fire-and-forget budget usage update when we have non-streaming usage.
    if (result.usage) {
      getModelByKey(auth.tenantDbName, body.model, auth.projectId)
        .then((model) => {
          if (!model) return;
          const cost = calculateCost(model.pricing, result.usage);
          if (cost.currency !== 'USD' || !Number.isFinite(cost.totalCost) || cost.totalCost <= 0) {
            return;
          }
          return checkBudget(quotaContext, { usd: cost.totalCost });
        })
        .catch((err) => console.error('Failed to update budget usage:', err));
    }

    if (result.stream) {
      return new Response(result.stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Request-Id': result.requestId,
        },
      });
    }

    return NextResponse.json({ ...result.response, request_id: result.requestId }, { status: 200 });
  } catch (error: unknown) {
    console.error('Chat completion error', error);

    try {
      const model = await getModelByKey(auth.tenantDbName, body.model, auth.projectId);
      if (model) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logModelUsage(auth.tenantDbName, model, {
          requestId: body?.request_id || crypto.randomUUID(),
          route: 'chat.completions',
          status: 'error',
          providerRequest: sanitize({ model: body.model, body }),
          providerResponse: sanitize({ error: errorMessage }),
          errorMessage,
          latencyMs: Date.now() - startedAt,
          usage: {},
        });
      }
    } catch (logError) {
      console.error('Failed to log chat completion error', logError);
    }

    const errorMessage = error instanceof Error ? error.message : 'Inference error';
    return NextResponse.json({ error: { message: errorMessage, type: 'server_error' } }, { status: 500 });
  }
}
