/**
 * The agent's own run callback (`config.callback`): where a run's result is
 * POSTed when the request names no `callback_url` of its own.
 *
 * The HMAC secret is write-only, with the same contract as the sandbox
 * secrets (`agentSandboxSecrets.ts`): plaintext in, sealed stored, a mask back
 * means "keep", an empty string means "remove", and every read returns the
 * mask. Agent configs are copied into version snapshots and manifests, so the
 * plaintext is never persisted and the sealed form never leaves the server.
 */

import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import { createLogger } from '@/lib/core/logger';
import type { IAgentCallbackConfig, IAgentConfig } from '@/lib/database';

const logger = createLogger('agent:callback-config');

/** Same mask the sandbox secrets use (one write-only convention on the agent form). */
export const AGENT_CALLBACK_SECRET_MASK = '••••••';

/**
 * Seals an incoming callback config for storage, keeping the stored secret when the mask comes back.
 *
 * A callback with no URL is no callback at all: there is nowhere to send a run's result and nothing
 * to sign, so it answers `undefined` (an empty object, a cleared URL, the mask next to no URL) and the
 * stored secret goes with it. The caller drops the field instead of storing what is left of it.
 */
export function sealAgentCallbackConfig(
  incoming: IAgentCallbackConfig | undefined,
  current: IAgentCallbackConfig | undefined,
): IAgentCallbackConfig | undefined {
  if (!incoming) return undefined;
  const { secret, secretSealed: _ignored, ...rest } = incoming;
  if (!rest.url) return undefined;
  if (secret === undefined || secret === AGENT_CALLBACK_SECRET_MASK) {
    return current?.secretSealed ? { ...rest, secretSealed: current.secretSealed } : rest;
  }
  return secret ? { ...rest, secretSealed: encryptObject(secret) } : rest;
}

/** The decrypted callback secret, for signing a callback. */
export function openAgentCallbackSecret(callback: IAgentCallbackConfig | undefined): string | undefined {
  if (!callback?.secretSealed) return undefined;
  try {
    return decryptObject<string>(callback.secretSealed) || undefined;
  } catch {
    // Not silent: the callback goes out unsigned until the secret is entered again.
    logger.error('Agent callback secret cannot be decrypted (the encryption key has changed); callbacks are sent unsigned');
    return undefined;
  }
}

/** The callback as clients may see it: the URL, a masked secret when one is stored, never the ciphertext. */
export function maskAgentCallbackConfig(callback: IAgentCallbackConfig | undefined): IAgentCallbackConfig | undefined {
  if (!callback) return callback;
  const { secretSealed, secret: _plain, ...rest } = callback;
  return secretSealed ? { ...rest, secret: AGENT_CALLBACK_SECRET_MASK } : rest;
}

/** The agent's own default callback, with its sealed secret opened. Empty when it has none. */
export function agentDefaultCallback(agentConfig?: Pick<IAgentConfig, 'callback'> | null): { url?: string; secret?: string } {
  const callback = agentConfig?.callback;
  if (!callback?.url) return {};
  return { url: callback.url, secret: openAgentCallbackSecret(callback) };
}

/**
 * Every top-level key an agent config may carry. Typed as a full record of
 * `IAgentConfig`, so adding a field to the interface fails to compile until it
 * is listed here (otherwise saves would silently drop it).
 */
const AGENT_CONFIG_KEYS: Record<keyof IAgentConfig, true> = {
  modelKey: true, reasoningEffort: true, reasoningBudgetTokens: true, showReasoning: true,
  additionalModels: true, systemPrompt: true, promptKey: true, promptVariables: true,
  temperature: true, topP: true, maxTokens: true, knowledgeEngineKey: true,
  knowledgeBindings: true, knowledgeToolMode: true, guardrails: true,
  inputGuardrailKey: true, outputGuardrailKey: true, toolBindings: true, kind: true,
  connection: true, runtime: true, structuredOutput: true, subagents: true,
  subagentPolicy: true, skills: true, skillPolicy: true, memory: true, sandbox: true,
  callback: true, budget: true, variables: true, humanInTheLoop: true,
  attachments: true, clientTools: true, clientToolSurfaces: true,
};

/**
 * Drops top-level keys an agent config does not define from a config about to
 * be saved or exported: the removed Execution settings (`config.execution`),
 * the never-shipped `inputs` / `routine(s)` blobs, and any stray key a client
 * sent. Nothing reads them; keeping them only made them round-trip through
 * exports. Stored agents may still carry such keys; the next save removes them.
 */
export function stripLegacyExecutionConfig<T extends IAgentConfig>(config: T): T {
  if (!config || typeof config !== 'object') return config;
  const keys = Object.keys(config);
  if (keys.every((key) => Object.prototype.hasOwnProperty.call(AGENT_CONFIG_KEYS, key))) return config;
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(AGENT_CONFIG_KEYS, key)) kept[key] = (config as Record<string, unknown>)[key];
  }
  return kept as T;
}
