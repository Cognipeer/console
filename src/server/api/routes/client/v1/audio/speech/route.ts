import { NextResponse, type NextRequest } from '@/server/api/http';
import crypto from 'crypto';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { handleSpeechRequest } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { logModelUsage } from '@/lib/services/models/usageLogger';
import {
  checkBudget,
  checkPerRequestLimits,
  checkRateLimit,
} from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';
import { withRequestContext } from '@/lib/api/withRequestContext';
import type { TtsOutputFormat, TtsSynthesizeInput } from '@/lib/providers';

const logger = createLogger('client-tts');

const VALID_FORMATS: TtsOutputFormat[] = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];

type SpeechRequest = {
  model?: string;
  input?: string;
  voice?: string;
  response_format?: string;
  speed?: number;
  instructions?: string;
  request_id?: string;
  [key: string]: unknown;
};

function unauthorized(message = 'Invalid API token') {
  return NextResponse.json(
    { error: { message, type: 'invalid_request_error' } },
    { status: 401 },
  );
}

function badRequest(message: string) {
  return NextResponse.json(
    { error: { message, type: 'invalid_request_error' } },
    { status: 400 },
  );
}

function quotaExceeded(message = 'Quota exceeded') {
  return NextResponse.json(
    { error: { message, type: 'rate_limit_error' } },
    { status: 429 },
  );
}

const _POST = async (request: NextRequest) => {
  const startedAt = Date.now();

  let auth: Awaited<ReturnType<typeof requireApiToken>>;
  try {
    auth = await requireApiToken(request);
  } catch (error) {
    if (error instanceof ApiTokenAuthError) return unauthorized(error.message);
    logger.error('TTS auth error', { error });
    return unauthorized();
  }

  let body: SpeechRequest;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === 'object' ? (parsed as SpeechRequest) : {};
  } catch {
    return badRequest('Invalid JSON body');
  }

  if (!body.model || typeof body.model !== 'string') {
    return badRequest('`model` is required');
  }
  if (!body.input || typeof body.input !== 'string') {
    return badRequest('`input` text is required');
  }
  const requestedFormat: TtsOutputFormat | undefined =
    typeof body.response_format === 'string' &&
    (VALID_FORMATS as string[]).includes(body.response_format)
      ? (body.response_format as TtsOutputFormat)
      : undefined;

  const modelKey = body.model;

  try {
    const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
    const quotaContext = {
      tenantDbName: auth.tenantDbName,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      licenseType: auth.tenant.licenseType as LicenseType,
      userId: auth.tokenRecord.userId,
      tokenId,
      domain: 'tts' as const,
      resourceKey: modelKey,
    };

    const perRequest = await checkPerRequestLimits(quotaContext, {});
    if (!perRequest.allowed) return quotaExceeded(perRequest.reason || 'Quota exceeded');

    const rateLimit = await checkRateLimit(quotaContext, { requests: 1 });
    if (!rateLimit.allowed) return quotaExceeded(rateLimit.reason || 'Rate limit exceeded');

    const budget = await checkBudget(quotaContext);
    if (!budget.allowed) return quotaExceeded(budget.reason || 'Budget exceeded');
  } catch (error) {
    logger.error('Quota check error', { error });
    return NextResponse.json(
      { error: { message: 'Quota check failed', type: 'server_error' } },
      { status: 500 },
    );
  }

  const input: TtsSynthesizeInput = {
    text: body.input,
    // Optional — the provider runtime falls back to its default voice.
    voice: typeof body.voice === 'string' && body.voice ? body.voice : undefined,
    format: requestedFormat,
    speed: typeof body.speed === 'number' ? body.speed : undefined,
    instructions:
      typeof body.instructions === 'string' ? body.instructions : undefined,
  };

  try {
    const result = await handleSpeechRequest({
      tenantDbName: auth.tenantDbName,
      modelKey,
      projectId: auth.projectId,
      input,
    });

    return new Response(new Uint8Array(result.audio), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.audio.byteLength),
        'X-Request-Id': result.requestId,
      },
    });
  } catch (error: unknown) {
    logger.error('TTS error', { error });
    try {
      const model = await getModelByKey(auth.tenantDbName, modelKey, auth.projectId);
      if (model) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logModelUsage(auth.tenantDbName, model, {
          requestId: crypto.randomUUID(),
          route: 'audio.speech',
          status: 'error',
          providerRequest: { model: modelKey, voice: body.voice },
          providerResponse: { error: errorMessage },
          errorMessage,
          latencyMs: Date.now() - startedAt,
          usage: {},
        });
      }
    } catch (logError) {
      logger.error('Failed to log TTS error', { error: logError });
    }
    const errorMessage = error instanceof Error ? error.message : 'Inference error';
    return NextResponse.json(
      { error: { message: errorMessage, type: 'server_error' } },
      { status: 500 },
    );
  }
};

export const POST = withRequestContext(_POST);
