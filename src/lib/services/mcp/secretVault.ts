/**
 * MCP secret vault — seals upstream auth secrets and stdio env values with
 * AES-256-GCM (same key material as provider credentials, see
 * `@/lib/utils/crypto`).
 *
 * Storage rules:
 * - `sealAuthConfig` moves the secret fields (token / headerValue / password)
 *   into the encrypted `sealed` payload; non-secret fields (type, headerName,
 *   username) stay plaintext for display.
 * - `openAuthConfig` restores a fully-populated plaintext config for runtime
 *   use. Legacy records that still carry plaintext secrets pass through
 *   unchanged and get sealed on their next save.
 * - stdio env maps are sealed as a whole (`envSealed`), since values are
 *   almost always credentials.
 */

import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { IMcpAuthConfig, IMcpStdioConfig } from '@/lib/database';

const MASK = '••••••';

interface SealedAuthSecrets {
  token?: string;
  headerValue?: string;
  password?: string;
}

function hasPlaintextSecrets(auth: IMcpAuthConfig): boolean {
  return Boolean(auth.token || auth.headerValue || auth.password);
}

/** Encrypt the secret fields of an auth config for storage. */
export function sealAuthConfig(auth: IMcpAuthConfig): IMcpAuthConfig {
  if (!auth || auth.type === 'none') return { type: 'none' };
  if (!hasPlaintextSecrets(auth)) {
    // Nothing new to seal — keep an existing sealed payload if present.
    return { ...auth };
  }
  const secrets: SealedAuthSecrets = {};
  if (auth.token) secrets.token = auth.token;
  if (auth.headerValue) secrets.headerValue = auth.headerValue;
  if (auth.password) secrets.password = auth.password;

  const sealed = encryptObject(secrets);
  const { token: _t, headerValue: _hv, password: _p, ...rest } = auth;
  return { ...rest, sealed };
}

/** Decrypt an auth config for runtime use. Legacy plaintext passes through. */
export function openAuthConfig(auth: IMcpAuthConfig | undefined): IMcpAuthConfig {
  if (!auth) return { type: 'none' };
  if (!auth.sealed) return auth;
  const secrets = decryptObject<SealedAuthSecrets>(auth.sealed);
  const { sealed: _s, ...rest } = auth;
  return { ...rest, ...secrets };
}

/** Redact secrets for API/UI serialization. */
export function maskAuthConfig(auth: IMcpAuthConfig | undefined): IMcpAuthConfig {
  if (!auth) return { type: 'none' };
  const masked: IMcpAuthConfig = { type: auth.type };
  if (auth.headerName) masked.headerName = auth.headerName;
  if (auth.username) masked.username = auth.username;
  const sealedSecrets = auth.sealed
    ? (() => {
        try {
          return decryptObject<SealedAuthSecrets>(auth.sealed);
        } catch {
          return {};
        }
      })()
    : {};
  if (auth.token || sealedSecrets.token) masked.token = MASK;
  if (auth.headerValue || sealedSecrets.headerValue) masked.headerValue = MASK;
  if (auth.password || sealedSecrets.password) masked.password = MASK;
  return masked;
}

/**
 * Merge an auth-config update coming from the UI onto the stored config.
 * Masked values (the literal mask placeholder) mean "keep the current secret".
 */
export function mergeAuthConfigUpdate(
  current: IMcpAuthConfig | undefined,
  incoming: IMcpAuthConfig,
): IMcpAuthConfig {
  if (incoming.type === 'none') return { type: 'none' };
  const opened = current ? openAuthConfig(current) : { type: 'none' as const };
  const next: IMcpAuthConfig = { ...incoming };
  if (next.token === MASK) next.token = opened.token;
  if (next.headerValue === MASK) next.headerValue = opened.headerValue;
  if (next.password === MASK) next.password = opened.password;
  delete next.sealed;
  return sealAuthConfig(next);
}

/** True when the given serialized value is the redaction placeholder. */
export function isMaskedSecret(value: unknown): boolean {
  return value === MASK;
}

// ── stdio env sealing ─────────────────────────────────────────────────────

/** Encrypt a stdio env map into `envSealed`, clearing plaintext `env`. */
export function sealStdioEnv(config: IMcpStdioConfig): IMcpStdioConfig {
  if (!config.env || Object.keys(config.env).length === 0) {
    return { ...config, env: undefined };
  }
  const envSealed = encryptObject(config.env);
  return { ...config, env: undefined, envSealed };
}

/** Decrypt the env map of a stdio config for runtime use. */
export function openStdioEnv(config: IMcpStdioConfig): Record<string, string> {
  if (config.envSealed) {
    try {
      return decryptObject<Record<string, string>>(config.envSealed);
    } catch {
      return {};
    }
  }
  return config.env ?? {};
}

/** Redact env values for API/UI serialization (keys stay visible). */
export function maskStdioConfig(config: IMcpStdioConfig | undefined): IMcpStdioConfig | undefined {
  if (!config) return undefined;
  const env = openStdioEnvSafe(config);
  const maskedEnv: Record<string, string> = {};
  for (const key of Object.keys(env)) maskedEnv[key] = MASK;
  const { envSealed: _e, ...rest } = config;
  return { ...rest, env: Object.keys(maskedEnv).length ? maskedEnv : undefined };
}

function openStdioEnvSafe(config: IMcpStdioConfig): Record<string, string> {
  try {
    return openStdioEnv(config);
  } catch {
    return {};
  }
}

/**
 * Merge a stdio-config update from the UI: masked env values keep the stored
 * secret; new/changed values replace it; missing keys are removed.
 */
export function mergeStdioConfigUpdate(
  current: IMcpStdioConfig | undefined,
  incoming: IMcpStdioConfig,
): IMcpStdioConfig {
  const currentEnv = current ? openStdioEnvSafe(current) : {};
  const nextEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming.env ?? {})) {
    nextEnv[key] = value === MASK ? (currentEnv[key] ?? '') : value;
  }
  const merged: IMcpStdioConfig = {
    ...incoming,
    env: Object.keys(nextEnv).length ? nextEnv : undefined,
    envSealed: undefined,
  };
  return sealStdioEnv(merged);
}

export const MCP_SECRET_MASK = MASK;
