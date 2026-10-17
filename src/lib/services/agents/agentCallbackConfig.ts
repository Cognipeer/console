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
import type { IAgentCallbackConfig, IAgentConfig } from '@/lib/database';

/** Same mask the sandbox secrets use (one write-only convention on the agent form). */
export const AGENT_CALLBACK_SECRET_MASK = '••••••';

/** Seals an incoming callback config for storage, keeping the stored secret when the mask comes back. */
export function sealAgentCallbackConfig(
  incoming: IAgentCallbackConfig | undefined,
  current: IAgentCallbackConfig | undefined,
): IAgentCallbackConfig | undefined {
  if (!incoming) return incoming;
  const { secret, secretSealed: _ignored, ...rest } = incoming;
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
 * Drops the removed Execution settings (`config.execution`, gone with the run
 * engine rework) from a config about to be saved. Stored agents may still
 * carry the blob; nothing reads it, and the next save removes it.
 */
export function stripLegacyExecutionConfig<T extends IAgentConfig>(config: T): T {
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'execution')) return config;
  const { execution: _legacy, ...rest } = config as T & { execution?: unknown };
  return rest as T;
}
