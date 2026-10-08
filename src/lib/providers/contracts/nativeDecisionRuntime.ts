/**
 * Native decision backends and the mode switch that chooses between them and
 * the structured-output emulator.
 *
 * Every outbound call goes through `safeFetch` (private-network guard, redirect
 * re-validation, timeout). The OpenAI URL is a constant; the Alibaba host is
 * built only from a validated workspace id and a region from a closed set (see
 * `buildSystemOneUrl`), so no caller- or operator-supplied string becomes a
 * hostname unchecked.
 */
import type { DecisionRequest, DecisionResult, DecisionRuntime } from '../domains/decision';
import type { ModelProviderRuntime, ModelRuntimeConfig } from '../domains/model';
import { safeFetch } from '@/lib/security/outboundFetch';
import { upstreamError, InvalidRequestError } from './upstreamError';
import {
  buildOpenAiDecisionBody,
  buildSystemOneBody,
  buildSystemOneUrl,
  normalizeOpenAiDecisionResponse,
  normalizeSystemOneResponse,
  type NativeDecisionOutput,
} from './nativeDecisionHelpers';
import { DecisionBackendError, createStructuredDecisionRuntime } from './structuredDecisionRuntime';

export type DecisionMode = 'structured' | 'native';

export function resolveDecisionMode(modelSettings: Record<string, unknown> | undefined): DecisionMode | string {
  const decision = modelSettings?.decision;
  const mode = decision && typeof decision === 'object' ? (decision as Record<string, unknown>).mode : undefined;
  return typeof mode === 'string' && mode ? mode : 'structured';
}

interface NativeCallOptions {
  provider: string;
  vendor: string;
  url: string;
  headers: Record<string, string>;
  buildBody: (request: DecisionRequest) => Record<string, unknown>;
  normalize: (raw: unknown, request: DecisionRequest) => NativeDecisionOutput;
  timeoutMs?: number;
}

function createNativeRuntime(options: NativeCallOptions): DecisionRuntime {
  return {
    async decide(request, callOptions): Promise<DecisionResult> {
      // Built BEFORE any network I/O so an unsupported request (images on a
      // text-only model, http image URLs) fails as a 400 without a round-trip.
      const body = options.buildBody(request);

      const response = await safeFetch(
        options.url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...options.headers },
          body: JSON.stringify(body),
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        },
        { timeoutMs: options.timeoutMs ?? 60_000 },
      );

      if (!response.ok) {
        throw await upstreamError(`${options.vendor} decision request failed`, response);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new DecisionBackendError(`${options.vendor} returned a response that is not valid JSON`);
      }

      return {
        ...options.normalize(raw, request),
        backend: { kind: 'native', provider: options.provider },
      };
    },
  };
}

export const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions';

export function createOpenAiNativeDecisionRuntime(opts: {
  apiKey: string;
  organization?: string;
  modelId: string;
  url?: string;
}): DecisionRuntime {
  return createNativeRuntime({
    provider: 'openai',
    vendor: 'OpenAI',
    url: opts.url ?? OPENAI_DECISIONS_URL,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      ...(opts.organization ? { 'OpenAI-Organization': opts.organization } : {}),
    },
    buildBody: (request) => buildOpenAiDecisionBody(opts.modelId, request),
    normalize: normalizeOpenAiDecisionResponse,
  });
}

export function createAlibabaNativeDecisionRuntime(opts: {
  apiKey: string;
  workspaceId: string;
  region: string;
  modelId: string;
}): DecisionRuntime {
  return createNativeRuntime({
    provider: 'alibaba-modelstudio',
    vendor: 'Alibaba Model Studio',
    // Throws on an invalid workspace id / region before anything is sent.
    url: buildSystemOneUrl(opts.workspaceId, opts.region),
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    buildBody: (request) => buildSystemOneBody(opts.modelId, request),
    normalize: normalizeSystemOneResponse,
  });
}

/**
 * Picks the backend for one call from `settings.decision.mode`.
 *
 * `structured` needs a chat runtime on the driver; `native` needs the driver to
 * supply a native adapter. A driver with neither answers a clear 400.
 */
export function selectDecisionRuntime(args: {
  runtime: ModelProviderRuntime;
  config: ModelRuntimeConfig;
  provider: string;
  /** Present when the driver has a vendor-native decision endpoint. */
  native?: (config: ModelRuntimeConfig) => DecisionRuntime;
  /** False for a driver with no chat model (the emulator cannot run on it). */
  structured?: boolean;
}): DecisionRuntime {
  const mode = resolveDecisionMode(args.config.modelSettings);
  if (mode === 'native') {
    if (!args.native) {
      throw new InvalidRequestError(`Native decision is not supported for provider ${args.provider}`);
    }
    return args.native(args.config);
  }
  if (mode !== 'structured') {
    throw new InvalidRequestError(`Unknown decision mode "${mode}"; expected "structured" or "native"`);
  }
  if (args.structured === false) {
    throw new InvalidRequestError(
      `Structured decision is not supported for provider ${args.provider}; set decision.mode to "native"`,
    );
  }
  return createStructuredDecisionRuntime(args.runtime, args.config, args.provider);
}
