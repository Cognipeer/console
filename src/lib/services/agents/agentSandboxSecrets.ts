/**
 * Write-only secrets on an agent's sandbox config.
 *
 * Same contract as MCP stdio env (`mcp/secretVault.ts`): the plaintext map
 * `sandbox.secrets` is sealed into `sandbox.secretsSealed` on save and
 * dropped; every read returns the keys with a masked value; an update that
 * sends a key back with the mask keeps the stored value, a new value
 * replaces it, and a key left out is removed. Agent configs are copied into
 * version snapshots and manifests, so the plaintext must never be persisted.
 *
 * When the stored ciphertext cannot be opened (the encryption key changed) the
 * secrets cannot be listed or merged: reads carry `secretsUnreadable: true`, a
 * save that mixes masks with other values is refused (`sandboxSecretsConflict`),
 * and a save without masks replaces them.
 */

import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import { createLogger } from '@/lib/core/logger';
import type { IAgentConfig, IAgentSandboxConfig } from '@/lib/database';
import { maskAgentCallbackConfig, sealAgentCallbackConfig, stripLegacyExecutionConfig } from './agentCallbackConfig';

const logger = createLogger('agent:sandbox-secrets');

export const AGENT_SANDBOX_SECRET_MASK = '••••••';

/** Code of the 409 a save gets when it mixes masked values with new ones while the stored secrets cannot be opened. */
export const SANDBOX_SECRETS_UNREADABLE_CODE = 'sandbox_secrets_unreadable';

export const SANDBOX_SECRETS_UNREADABLE_MESSAGE =
    'The stored sandbox secrets cannot be decrypted (the encryption key has changed), so masked values cannot be kept. Enter every secret value again to replace them.';

/** Values shorter than this are neither scrubbed from output nor from files — masking them would garble ordinary text. */
export const MIN_SCRUBBED_SECRET_LENGTH = 4;

interface SecretsReading { secrets: Record<string, string>; unreadable: boolean }

/** Decrypts without logging; `unreadable` = ciphertext is stored but cannot be opened (the encryption key changed). */
function inspectSecrets(sandbox: IAgentSandboxConfig | undefined): SecretsReading {
    if (!sandbox?.secretsSealed) return { secrets: {}, unreadable: false };
    try {
        return { secrets: decryptObject<Record<string, string>>(sandbox.secretsSealed) ?? {}, unreadable: false };
    } catch {
        return { secrets: {}, unreadable: true };
    }
}

/**
 * The decrypted secrets plus whether the stored ciphertext could not be opened.
 * Running a command with an empty environment instead would fail in confusing
 * ways, so callers surface `unreadable` to the operator and to the model.
 */
export function readAgentSandboxSecrets(sandbox: IAgentSandboxConfig | undefined): SecretsReading {
    const reading = inspectSecrets(sandbox);
    if (reading.unreadable) {
        logger.error('Agent sandbox secrets cannot be decrypted (the encryption key has changed); running without them');
    }
    return reading;
}

/** The decrypted secrets, for injecting into a sandbox command's environment. */
export function openAgentSandboxSecrets(sandbox: IAgentSandboxConfig | undefined): Record<string, string> {
    return readAgentSandboxSecrets(sandbox).secrets;
}

/**
 * A save that would drop what the sender typed: the stored ciphertext cannot be opened and the
 * incoming secrets mix masked values (which stand for values nobody can read) with other ones.
 * Only masks keep the ciphertext as it is; no masks replace it.
 */
export function sandboxSecretsConflict(
    incoming: IAgentSandboxConfig | undefined,
    current: IAgentSandboxConfig | undefined,
): boolean {
    const values = Object.values(incoming?.secrets ?? {});
    return values.includes(AGENT_SANDBOX_SECRET_MASK)
        && values.some((value) => value !== AGENT_SANDBOX_SECRET_MASK)
        && inspectSecrets(current).unreadable;
}

/**
 * Seals an incoming sandbox config for storage, merging masked values with
 * what `current` already holds. A config without a `secrets` field keeps the
 * stored secrets untouched (a client that never saw them cannot erase them).
 */
export function sealAgentSandboxConfig(
    incoming: IAgentSandboxConfig | undefined,
    current: IAgentSandboxConfig | undefined,
): IAgentSandboxConfig | undefined {
    if (!incoming) return incoming;
    const { secrets, secretsSealed: _ignored, secretsUnreadable: _readOnly, ...rest } = incoming;
    if (secrets === undefined) {
        return current?.secretsSealed ? { ...rest, secretsSealed: current.secretsSealed } : rest;
    }
    const { secrets: stored, unreadable } = inspectSecrets(current);
    if (unreadable && Object.values(secrets ?? {}).includes(AGENT_SANDBOX_SECRET_MASK)) {
        // Only masks get here (a mix is refused before, see `sandboxSecretsConflict`): they stand for values
        // that cannot be opened, and re-sealing would drop them for good, so the ciphertext stays as it is.
        logger.warn('Kept the stored sandbox secrets as they are: they cannot be decrypted, so masked values cannot be merged');
        return { ...rest, secretsSealed: current!.secretsSealed };
    }
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets ?? {})) {
        const resolved = value === AGENT_SANDBOX_SECRET_MASK ? stored[key] : value;
        if (typeof resolved === 'string' && resolved.length > 0) next[key] = resolved;
    }
    return Object.keys(next).length > 0 ? { ...rest, secretsSealed: encryptObject(next) } : rest;
}

/**
 * Applies the sandbox and callback sealing to a whole agent config, and drops
 * the removed Execution settings a stored config may still carry.
 */
export function sealAgentConfigSecrets(
    config: IAgentConfig,
    current: IAgentConfig | undefined,
): IAgentConfig {
    let next = stripLegacyExecutionConfig(config);
    if (next.sandbox) next = { ...next, sandbox: sealAgentSandboxConfig(next.sandbox, current?.sandbox) };
    // `!== undefined`, so a JSON `null` is looked at too: whatever says "no callback" leaves no field behind.
    if (next.callback !== undefined) {
        const callback = sealAgentCallbackConfig(next.callback, current?.callback);
        if (callback) {
            next = { ...next, callback };
        } else {
            // A callback with no URL is removed, not kept as `{}`, `{ url: '' }` or a secret with nothing to sign.
            const { callback: _removed, ...withoutCallback } = next;
            next = withoutCallback;
        }
    }
    return next;
}

/** The sandbox config as clients may see it: secret keys, masked values, no ciphertext. */
export function maskAgentSandboxConfig(sandbox: IAgentSandboxConfig | undefined): IAgentSandboxConfig | undefined {
    if (!sandbox) return sandbox;
    const { secretsSealed: _sealed, secrets: _plain, secretsUnreadable: _flag, ...rest } = sandbox;
    const keys = Object.keys(inspectSecrets(sandbox).secrets);
    return keys.length > 0
        ? { ...rest, secrets: Object.fromEntries(keys.map((key) => [key, AGENT_SANDBOX_SECRET_MASK])) }
        : rest;
}

/**
 * Masks the sandbox and callback secrets of an agent-shaped object (`{ config }`)
 * for an API response (with `sandbox.secretsUnreadable: true` when the stored
 * secrets cannot be decrypted); a legacy `execution` blob is not returned either.
 */
export function maskAgentSandboxSecrets<T extends { config?: IAgentConfig }>(agent: T): T {
    const raw = agent?.config as (IAgentConfig & { execution?: unknown }) | undefined;
    if (!raw?.sandbox && !raw?.callback && raw?.execution === undefined) return agent;
    const config: IAgentConfig = stripLegacyExecutionConfig({ ...agent.config! });
    if (config.sandbox) {
        const unreadable = inspectSecrets(config.sandbox).unreadable;
        config.sandbox = { ...maskAgentSandboxConfig(config.sandbox), ...(unreadable ? { secretsUnreadable: true } : {}) };
    }
    if (config.callback) config.callback = maskAgentCallbackConfig(config.callback);
    return { ...agent, config };
}

/**
 * Replaces every secret value in `text` with a mask, so a command that echoes
 * `$API_KEY` does not hand the key to the model (and from there to the
 * transcript and traces). Values shorter than `MIN_SCRUBBED_SECRET_LENGTH`
 * are left alone. Longest first, so a value that contains another is masked whole.
 */
export function scrubSecretValues(text: string, secrets: Record<string, string>): string {
    let out = text;
    const values = Object.values(secrets).filter((value) => value && value.length >= MIN_SCRUBBED_SECRET_LENGTH);
    for (const value of values.sort((a, b) => b.length - a.length)) out = out.split(value).join(AGENT_SANDBOX_SECRET_MASK);
    return out;
}
