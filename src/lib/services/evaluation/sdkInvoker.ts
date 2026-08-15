/**
 * Evaluation SDK invoker — runs model targets and llm-judges directly against
 * @cognipeer/agent-sdk's native providers instead of the gateway inference
 * funnel (`handleChatCompletion`), so evaluation suites exercise the provider
 * wire faithfully on ALL providers (the gateway path narrows params through
 * its allow-list and LangChain adapter quirks).
 *
 * Provider resolution REUSES the platform's canonical credential path:
 * `getModelByKey` (models service) resolves the hub model, then
 * `loadProviderRuntimeData` (providers service) loads the provider record and
 * DECRYPTS its credentials — no crypto is re-implemented here. The decrypted
 * record is mapped onto an agent-sdk `ProviderConfig`:
 *
 *   console driver        → agent-sdk provider
 *   'openai'              → 'openai'             (apiKey, organization?)
 *   'openai-compatible'   → 'openai-compatible'  (apiKey, baseURL = settings.baseUrl)
 *   'together'            → 'openai-compatible'  (apiKey, baseURL = api.together.xyz/v1)
 *   'azure'               → 'azure'              (apiKey, endpoint from settings.instanceName,
 *                                                 deploymentName, apiVersion)
 *   'bedrock'             → 'bedrock'            (region = settings.region, accessKeyId,
 *                                                 secretAccessKey, sessionToken?)
 *   'vertex'              → 'vertex'             (projectId/location from settings,
 *                                                 serviceAccountJson = credentials.serviceAccountKey)
 *   anything else         → SdkProviderMappingError (typed) — the evaluation
 *                           adapter falls back to the gateway invoker.
 *
 * Azure-behind-openai-compatible (a resource's `/openai/v1` base URL stored on
 * an 'openai-compatible' record — the console convention for the v1 surface)
 * needs no special case: it maps to 'openai-compatible' with that baseURL.
 * Dynamic-routing models ('dynamic' driver) and non-llm categories also raise
 * SdkProviderMappingError so the gateway keeps owning their semantics/errors.
 *
 * INTENTIONAL: this path writes NO model_usage_logs / usage_daily rows —
 * evaluation runs must not pollute production spend/usage reporting (the
 * gateway path does log; that difference is by design). Run items still carry
 * the measured per-invocation usage/cost via the adapter's pricing math.
 */

import { createProvider } from '@cognipeer/agent-sdk';
import type {
  ChatCompletionRequest,
  ProviderConfig,
  ProviderToolCall,
  ProviderToolDefinition,
  TokenUsage as SdkTokenUsage,
  UnifiedMessage,
} from '@cognipeer/agent-sdk';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { getDynamicRoutingConfig } from '@/lib/services/models/dynamicRouting';
import type { IModel } from '@/lib/database';
import type { EvalToolDefinition, NormalizedToolCall } from './types';

const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';

/**
 * Typed "this model cannot run on the SDK path" error. The evaluation adapter
 * catches EXACTLY this class to fall back to the gateway invoker; every other
 * error (auth failures, provider 4xx/5xx, model-not-found, decrypt failures)
 * surfaces as the per-item error, same as the gateway path would.
 */
export class SdkProviderMappingError extends Error {
  readonly driver: string;

  constructor(driver: string, reason: string) {
    super(`Model provider driver "${driver}" cannot be invoked via agent-sdk: ${reason}`);
    this.name = 'SdkProviderMappingError';
    this.driver = driver;
  }
}

export interface SdkInvokeContext {
  tenantDbName: string;
  projectId: string;
}

/** Usage snapshot in the shape the adapter's `toEvalUsage` pricing path takes. */
export interface SdkUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface SdkChatResult {
  text: string;
  toolCalls: NormalizedToolCall[];
  usage?: SdkUsageSnapshot;
  latencyMs: number;
  raw: unknown;
}

/** Model + provider config resolved once so per-item calls skip the DB. */
export interface PreparedSdkInvocation {
  model: IModel;
  config: ProviderConfig;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Resolve the agent-sdk ProviderConfig for a hub model using the EXISTING
 * provider record + decrypt path (`loadProviderRuntimeData`). Throws
 * SdkProviderMappingError when the model/driver has no native SDK equivalent
 * (unknown driver, dynamic router, non-llm category, missing required config
 * field) — the caller falls back to the gateway, which owns the canonical
 * error message for those states.
 */
export async function resolveSdkProviderConfig(
  tenantDbName: string,
  model: IModel,
  projectId?: string,
): Promise<ProviderConfig> {
  if (getDynamicRoutingConfig(model)) {
    throw new SdkProviderMappingError('dynamic', 'dynamic-routing models resolve through the gateway');
  }
  if (model.category !== 'llm') {
    throw new SdkProviderMappingError(
      model.providerDriver ?? 'unknown',
      `category "${model.category}" is not a chat model`,
    );
  }

  const { record, credentials } = await loadProviderRuntimeData(tenantDbName, {
    tenantId: model.tenantId,
    key: model.providerKey,
    projectId: projectId ?? model.projectId,
  });
  const creds = asRecord(credentials);
  const settings = asRecord(record.settings);

  const require = (value: string | undefined, field: string): string => {
    if (value === undefined) {
      throw new SdkProviderMappingError(record.driver, `provider record is missing "${field}"`);
    }
    return value;
  };

  switch (record.driver) {
    case 'openai': {
      const organization = nonEmptyString(settings.organization);
      return {
        provider: 'openai',
        apiKey: require(nonEmptyString(creds.apiKey), 'apiKey'),
        ...(organization ? { organization } : {}),
      };
    }
    case 'openai-compatible':
      return {
        provider: 'openai-compatible',
        apiKey: require(nonEmptyString(creds.apiKey), 'apiKey'),
        baseURL: require(nonEmptyString(settings.baseUrl), 'baseUrl'),
      };
    case 'together':
      return {
        provider: 'openai-compatible',
        apiKey: require(nonEmptyString(creds.apiKey), 'apiKey'),
        baseURL: TOGETHER_BASE_URL,
      };
    case 'azure': {
      const instanceName = require(nonEmptyString(settings.instanceName), 'instanceName');
      return {
        provider: 'azure',
        apiKey: require(nonEmptyString(creds.apiKey), 'apiKey'),
        endpoint: `https://${instanceName}.openai.azure.com`,
        deploymentName: require(nonEmptyString(settings.deploymentName), 'deploymentName'),
        apiVersion: require(nonEmptyString(settings.apiVersion), 'apiVersion'),
      };
    }
    case 'bedrock': {
      const sessionToken = nonEmptyString(creds.sessionToken);
      return {
        provider: 'bedrock',
        region: require(nonEmptyString(settings.region), 'region'),
        accessKeyId: require(nonEmptyString(creds.accessKeyId), 'accessKeyId'),
        secretAccessKey: require(nonEmptyString(creds.secretAccessKey), 'secretAccessKey'),
        ...(sessionToken ? { sessionToken } : {}),
      };
    }
    case 'vertex': {
      const serviceAccountJson = nonEmptyString(creds.serviceAccountKey);
      return {
        provider: 'vertex',
        projectId: require(nonEmptyString(settings.projectId), 'projectId'),
        location: require(nonEmptyString(settings.location), 'location'),
        ...(serviceAccountJson ? { serviceAccountJson } : {}),
      };
    }
    default:
      throw new SdkProviderMappingError(record.driver, 'no native agent-sdk provider for this driver');
  }
}

/**
 * Resolve model + provider config once per invoker so per-item invocations
 * avoid a DB read + decrypt each. Model-not-found deliberately mirrors the
 * gateway's error text (it is a runtime error, not a mapping failure).
 */
export async function prepareSdkInvocation(
  ctx: SdkInvokeContext,
  modelKey: string,
): Promise<PreparedSdkInvocation> {
  const model = await getModelByKey(ctx.tenantDbName, modelKey, ctx.projectId);
  if (!model) {
    throw new Error(`Model with key ${modelKey} not found`);
  }
  const config = await resolveSdkProviderConfig(ctx.tenantDbName, model, ctx.projectId);
  return { model, config };
}

function coerceContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

/**
 * Convert OpenAI-wire messages (the `toProviderMessages` output shape) into
 * the SDK's UnifiedMessage[]. Assistant `tool_calls` entries become
 * `toolCalls` ({id, name, arguments:string}); tool rows keep their
 * `tool_call_id` linkage as `toolCallId`.
 */
export function toUnifiedMessages(wire: Array<Record<string, unknown>>): UnifiedMessage[] {
  return wire.map((row) => {
    const role = row.role as UnifiedMessage['role'];
    const content = coerceContent(row.content);

    if (role === 'assistant' && Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
      const toolCalls: ProviderToolCall[] = (row.tool_calls as Array<Record<string, unknown>>).map(
        (call, index) => {
          const fn = asRecord(call.function);
          return {
            id: nonEmptyString(call.id) ?? `call_${index + 1}`,
            name: typeof fn.name === 'string' ? fn.name : '',
            arguments:
              typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          };
        },
      );
      return { role, content, toolCalls };
    }

    if (role === 'tool') {
      const message: UnifiedMessage = { role, content };
      const toolCallId = nonEmptyString(row.tool_call_id);
      if (toolCallId) message.toolCallId = toolCallId;
      const name = nonEmptyString(row.name);
      if (name) message.name = name;
      return message;
    }

    return { role, content };
  });
}

/**
 * Convert eval tool definitions to the SDK shape. The SDK requires
 * `description` and `parameters`; absent fields become '' / an empty object
 * schema so a name-only decision test still reaches the provider.
 */
export function toSdkTools(tools: EvalToolDefinition[] | undefined): ProviderToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }));
}

/**
 * Normalise SDK tool calls to {name, args}. The SDK types `arguments` as a
 * JSON string but compatible backends have been seen returning objects;
 * accept both, and record unparseable strings as `{ __raw }` (never throw).
 */
export function normalizeSdkToolCalls(calls: unknown): NormalizedToolCall[] {
  if (!Array.isArray(calls)) return [];
  const normalized: NormalizedToolCall[] = [];
  for (const call of calls as Array<{ name?: unknown; arguments?: unknown }>) {
    const name = call?.name;
    if (typeof name !== 'string' || !name) continue;
    normalized.push({ name, args: parseToolArguments(call.arguments) });
  }
  return normalized;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { __raw: raw };
  } catch {
    return { __raw: raw };
  }
}

/** Map the SDK's TokenUsage onto the adapter's pricing-input shape. */
export function toUsageSnapshot(usage: SdkTokenUsage | undefined): SdkUsageSnapshot | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
  };
}

/**
 * One chat completion through the SDK's native provider. Applies the hub
 * model's own sampling settings (temperature / maxTokens) and forwards
 * `settings.requestDefaults` + `settings.extraBody` verbatim via `extra` —
 * the same operator-owned body fields the gateway would merge upstream.
 * Latency is measured around `complete()` only, mirroring the gateway's
 * provider-call latency semantics.
 */
export async function invokeChatViaSdk(
  ctx: SdkInvokeContext,
  model: IModel,
  wireMessages: Array<Record<string, unknown>>,
  opts?: {
    tools?: EvalToolDefinition[];
    toolChoice?: ChatCompletionRequest['toolChoice'];
    /** Pre-resolved config (from `prepareSdkInvocation`) to skip re-resolution. */
    config?: ProviderConfig;
  },
): Promise<SdkChatResult> {
  const config =
    opts?.config ?? (await resolveSdkProviderConfig(ctx.tenantDbName, model, ctx.projectId));
  const provider = createProvider(config);

  const settings = asRecord(model.settings);
  const extra = {
    ...asRecord(settings.requestDefaults),
    ...asRecord(settings.extraBody),
  };
  const tools = toSdkTools(opts?.tools);

  const request: ChatCompletionRequest = {
    model: model.modelId,
    messages: toUnifiedMessages(wireMessages),
    ...(typeof settings.temperature === 'number' ? { temperature: settings.temperature } : {}),
    ...(typeof settings.maxTokens === 'number' ? { maxTokens: settings.maxTokens } : {}),
    ...(tools ? { tools, toolChoice: opts?.toolChoice ?? 'auto' } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };

  const started = Date.now();
  const response = await provider.complete(request);
  const latencyMs = Date.now() - started;

  return {
    text: response.content ?? '',
    toolCalls: normalizeSdkToolCalls(response.toolCalls),
    usage: toUsageSnapshot(response.usage),
    latencyMs,
    raw: response.raw,
  };
}
