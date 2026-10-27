/**
 * Prompt caching of a Model Hub model: which kind of caching its provider offers and whether the
 * model's "Cache prompts" switch is on.
 *
 * Pure on purpose (no server imports) so the model form asks the same question the gateway does.
 * The switch lives at `model.settings.promptCaching`; the gateway, the agents and the evaluation
 * invoker turn the resolved value into the SDK's `prompt_caching` option (`promptCachingProviderOption`).
 *
 * Only the 5-minute lifetime is offered: a `ttl` is never sent.
 */

/**
 * `explicit`: the provider caches where the request marks breakpoints (Anthropic, Bedrock Claude / Nova,
 * Claude on Vertex), so the switch is meaningful. `automatic`: the provider caches by itself (OpenAI, Azure
 * OpenAI, OpenAI-compatible servers, Gemini): no switch. `none`: no prompt caching to use.
 */
export type PromptCachingSupport = 'explicit' | 'automatic' | 'none';

export type PromptCachingStrategy = 'auto' | 'static';

/** Stored at `model.settings.promptCaching`; a missing field means "the default". */
export interface PromptCachingSettings {
  enabled?: boolean;
  /** `auto` = system, tools and the conversation tail; `static` = system (and tools) only. */
  strategy?: PromptCachingStrategy;
}

export interface PromptCachingInfo {
  support: PromptCachingSupport;
  family?: 'claude' | 'nova';
  /** The provider puts a checkpoint on the tool definitions (Nova never does). */
  cachesTools: boolean;
  /** The value of the switch while the model record does not set it. */
  defaultEnabled: boolean;
}

export interface ResolvedPromptCaching extends PromptCachingInfo {
  enabled: boolean;
  strategy: PromptCachingStrategy;
}

/** Same set as `OPENAI_SCHEMA_DRIVERS` (reasoning.ts), kept here so this module stays free of server imports; a test pins them together. */
export const PROMPT_CACHING_OPENAI_DRIVERS: ReadonlySet<string> = new Set(['openai', 'openai-compatible', 'azure', 'together']);

/** Converse families without explicit prompt caching (a checkpoint raises a ValidationException): the SDK's own table (bedrock.ts). */
const BEDROCK_NON_CACHING = /^(meta|mistral|cohere|ai21|deepseek|openai|qwen|writer|stability|luma|twelvelabs|amazon\.titan)\b/;
const BEDROCK_REGION_PREFIX = /^(?:us-gov|us|eu|apac|jp|au|ca|global)\./;

const NONE: PromptCachingInfo = { support: 'none', cachesTools: false, defaultEnabled: false };
const AUTOMATIC: PromptCachingInfo = { support: 'automatic', cachesTools: false, defaultEnabled: false };
const CLAUDE: PromptCachingInfo = { support: 'explicit', family: 'claude', cachesTools: true, defaultEnabled: true };
const NOVA: PromptCachingInfo = { support: 'explicit', family: 'nova', cachesTools: false, defaultEnabled: false };

function bedrockSupport(modelId: string | undefined): PromptCachingInfo {
  const raw = String(modelId ?? '').trim().toLowerCase();
  // The SDK (bedrockCacheFamily) does not read an ARN / inference profile: any `arn:` id has no family, and with
  // caching on it sends the system, tools and message checkpoints as for Claude. So the switch is offered
  // (explicit, tools cached) but stays OFF until the operator turns it on for a model they know.
  if (raw.startsWith('arn:')) return { support: 'explicit', cachesTools: true, defaultEnabled: false };
  const bare = raw.replace(BEDROCK_REGION_PREFIX, '');
  if (bare.startsWith('anthropic.claude')) return CLAUDE;
  if (bare.startsWith('amazon.nova')) return NOVA;
  if (BEDROCK_NON_CACHING.test(bare)) return NONE;
  // Not recognised (an id the table does not know). The SDK
  // does not refuse it: with caching on it sends the system, tools and message checkpoints as for Claude. So the
  // switch is offered (explicit, tools cached) but stays OFF until the operator turns it on for a model they know.
  return { support: 'explicit', cachesTools: true, defaultEnabled: false };
}

function isVertexClaude(modelId: string | undefined): boolean {
  // The SDK's `vertexClaudeModelId`: a `publishers/anthropic/models/` prefix, then an id starting with `claude`.
  return /^claude/i.test(String(modelId ?? '').trim().replace(/^publishers\/anthropic\/models\//i, ''));
}

/** Which kind of prompt caching this driver + model id offers. */
export function promptCachingSupport(driver: string | undefined, modelId: string | undefined): PromptCachingInfo {
  if (driver === 'anthropic') return CLAUDE;
  if (driver === 'bedrock') return bedrockSupport(modelId);
  if (driver === 'vertex') return isVertexClaude(modelId) ? CLAUDE : AUTOMATIC;
  if (driver && PROMPT_CACHING_OPENAI_DRIVERS.has(driver)) return AUTOMATIC;
  return NONE;
}

/** The switch as the model record sets it, over the provider's default. A switch is only ever ON for explicit caching. */
export function resolvePromptCaching(
  driver: string | undefined,
  modelId: string | undefined,
  settings?: PromptCachingSettings | null,
): ResolvedPromptCaching {
  const info = promptCachingSupport(driver, modelId);
  const enabled = info.support === 'explicit' && (settings?.enabled ?? info.defaultEnabled);
  const strategy = settings?.strategy === 'static' ? 'static' : 'auto';
  return { ...info, enabled, strategy };
}

/**
 * The SDK's `prompt_caching` provider option for a model, or undefined when nothing is to be sent (switch off,
 * or a provider with no explicit caching). Never carries a `ttl`: the SDK's 5-minute default applies.
 */
export function promptCachingProviderOption(
  driver: string | undefined,
  modelId: string | undefined,
  modelSettings?: unknown,
): { enabled: true; strategy: PromptCachingStrategy } | undefined {
  const raw = modelSettings && typeof modelSettings === 'object' ? (modelSettings as { promptCaching?: unknown }).promptCaching : undefined;
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PromptCachingSettings) : undefined;
  const resolved = resolvePromptCaching(driver, modelId, settings);
  return resolved.enabled ? { enabled: true, strategy: resolved.strategy } : undefined;
}

/**
 * What is wrong with a model's `settings.promptCaching`, or undefined when it is fine (or not set).
 * Only `enabled` (boolean) and `strategy` (`auto` | `static`) exist: the lifetime is fixed at 5 minutes,
 * so a `ttl` is refused rather than stored and ignored.
 */
export function validatePromptCaching(settings: unknown): string | undefined {
  const value = settings && typeof settings === 'object' ? (settings as { promptCaching?: unknown }).promptCaching : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'settings.promptCaching must be an object like { "enabled": true, "strategy": "auto" }';
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === 'ttl') return 'settings.promptCaching.ttl is not supported: cached prompts live for 5 minutes';
    if (key !== 'enabled' && key !== 'strategy') return `settings.promptCaching.${key} is not a known field (use "enabled" and "strategy")`;
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') return 'settings.promptCaching.enabled must be true or false';
  if (record.strategy !== undefined && record.strategy !== 'auto' && record.strategy !== 'static') {
    return 'settings.promptCaching.strategy must be "auto" or "static"';
  }
  return undefined;
}
