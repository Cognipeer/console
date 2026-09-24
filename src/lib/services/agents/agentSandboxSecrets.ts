/**
 * Write-only secrets on an agent's sandbox config.
 *
 * Same contract as MCP stdio env (`mcp/secretVault.ts`): the plaintext map
 * `sandbox.secrets` is sealed into `sandbox.secretsSealed` on save and
 * dropped; every read returns the keys with a masked value; an update that
 * sends a key back with the mask keeps the stored value, a new value
 * replaces it, and a key left out is removed. Agent configs are copied into
 * version snapshots and manifests, so the plaintext must never be persisted.
 */

import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { IAgentConfig, IAgentSandboxConfig } from '@/lib/database';

export const AGENT_SANDBOX_SECRET_MASK = '••••••';

/** The decrypted secrets, for injecting into a sandbox command's environment. */
export function openAgentSandboxSecrets(sandbox: IAgentSandboxConfig | undefined): Record<string, string> {
    if (!sandbox?.secretsSealed) return {};
    try {
        return decryptObject<Record<string, string>>(sandbox.secretsSealed) ?? {};
    } catch {
        return {};
    }
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
    const { secrets, secretsSealed: _ignored, ...rest } = incoming;
    if (secrets === undefined) {
        return current?.secretsSealed ? { ...rest, secretsSealed: current.secretsSealed } : rest;
    }
    const stored = openAgentSandboxSecrets(current);
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets ?? {})) {
        const resolved = value === AGENT_SANDBOX_SECRET_MASK ? stored[key] : value;
        if (typeof resolved === 'string' && resolved.length > 0) next[key] = resolved;
    }
    return Object.keys(next).length > 0 ? { ...rest, secretsSealed: encryptObject(next) } : rest;
}

/** Applies `sealAgentSandboxConfig` to a whole agent config, in place of its `sandbox`. */
export function sealAgentConfigSecrets(
    config: IAgentConfig,
    current: IAgentConfig | undefined,
): IAgentConfig {
    if (!config.sandbox) return config;
    return { ...config, sandbox: sealAgentSandboxConfig(config.sandbox, current?.sandbox) };
}

/** The sandbox config as clients may see it: secret keys, masked values, no ciphertext. */
export function maskAgentSandboxConfig(sandbox: IAgentSandboxConfig | undefined): IAgentSandboxConfig | undefined {
    if (!sandbox) return sandbox;
    const { secretsSealed: _sealed, secrets: _plain, ...rest } = sandbox;
    const keys = Object.keys(openAgentSandboxSecrets(sandbox));
    return keys.length > 0
        ? { ...rest, secrets: Object.fromEntries(keys.map((key) => [key, AGENT_SANDBOX_SECRET_MASK])) }
        : rest;
}

/** Masks the sandbox secrets of an agent-shaped object (`{ config }`) for an API response. */
export function maskAgentSandboxSecrets<T extends { config?: IAgentConfig }>(agent: T): T {
    if (!agent?.config?.sandbox) return agent;
    return { ...agent, config: { ...agent.config, sandbox: maskAgentSandboxConfig(agent.config.sandbox) } };
}

/**
 * Replaces every secret value in `text` with a mask, so a command that echoes
 * `$API_KEY` does not hand the key to the model (and from there to the
 * transcript and traces). Values shorter than 4 characters are left alone —
 * masking them would garble ordinary output.
 */
export function scrubSecretValues(text: string, secrets: Record<string, string>): string {
    let out = text;
    for (const value of Object.values(secrets)) {
        if (value && value.length >= 4) out = out.split(value).join(AGENT_SANDBOX_SECRET_MASK);
    }
    return out;
}
