/**
 * Tool secret vault — seals upstream auth secrets (bearer token / header value
 * / basic-auth password) with AES-256-GCM (same key material as provider
 * credentials and the MCP secret vault, see `@/lib/utils/crypto`), so tool
 * documents never carry those secrets in cleartext at rest.
 *
 * Storage rules:
 * - `sealAuthConfig` moves the secret fields (token / headerValue / password)
 *   into the encrypted `sealed` payload; non-secret fields (type, headerName,
 *   username) stay plaintext for display.
 * - `openAuthConfig` restores a fully-populated plaintext config for runtime
 *   use (building outbound request headers). Legacy records that still carry
 *   plaintext secrets pass through unchanged and get sealed on their next save.
 * - `maskAuthConfig` produces a display-safe config with secrets replaced by
 *   a fixed placeholder, for surfaces that may echo tool config back to a
 *   caller.
 *
 * Security note: `sealAuthConfig` NEVER echoes a caller-supplied `sealed`
 * value back out. `createTool` calls this directly on unvalidated
 * request-body input, so if the "nothing new to seal" branch reflected an
 * incoming `sealed` field verbatim, an attacker could plant an arbitrary
 * ciphertext (e.g. one stolen from elsewhere in the deployment — a DB dump,
 * a log line) alongside an attacker-controlled `mcpEndpoint`/
 * `upstreamBaseUrl`, then trigger a sync/execution to have the server decrypt
 * that ciphertext with the shared deployment key and send the plaintext to
 * the attacker's own endpoint — a decryption oracle. `sealAuthConfig` only
 * ever (a) computes a brand-new seal from plaintext fields present in its own
 * input, or (b) returns a record with no secret material at all; it never
 * re-emits a `sealed` value it did not itself just compute in that call. Only
 * `mergeAuthConfigUpdate` may carry a previously-sealed payload forward, and
 * it does so via its own trusted, already-opened value — never by reflecting
 * the caller's raw `sealed` field.
 */

import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { IToolAuthConfig } from '@/lib/database';

const MASK = '••••••';

interface SealedAuthSecrets {
  token?: string;
  headerValue?: string;
  password?: string;
}

function hasPlaintextSecrets(auth: IToolAuthConfig): boolean {
  return Boolean(auth.token || auth.headerValue || auth.password);
}

/** Non-secret fields only — never includes `sealed` or any secret field. */
function safeFields(auth: IToolAuthConfig): IToolAuthConfig {
  const safe: IToolAuthConfig = { type: auth.type };
  if (auth.headerName) safe.headerName = auth.headerName;
  if (auth.username) safe.username = auth.username;
  return safe;
}

/** Encrypt the secret fields of an auth config for storage. */
export function sealAuthConfig(auth: IToolAuthConfig | undefined): IToolAuthConfig {
  if (!auth || auth.type === 'none') return { type: 'none' };
  if (!hasPlaintextSecrets(auth)) {
    // No new secret material was supplied in this call. Return only the
    // safe, non-secret fields — deliberately dropping any `sealed` (or
    // other secret-shaped) field the caller may have passed in, since this
    // function has no way to verify it ever produced that ciphertext itself.
    return safeFields(auth);
  }
  const secrets: SealedAuthSecrets = {};
  if (auth.token) secrets.token = auth.token;
  if (auth.headerValue) secrets.headerValue = auth.headerValue;
  if (auth.password) secrets.password = auth.password;

  const sealed = encryptObject(secrets);
  return { ...safeFields(auth), sealed };
}

/** Decrypt an auth config for runtime use. Legacy plaintext passes through. */
export function openAuthConfig(auth: IToolAuthConfig | undefined): IToolAuthConfig {
  if (!auth) return { type: 'none' };
  if (!auth.sealed) return auth;
  const secrets = decryptObject<SealedAuthSecrets>(auth.sealed);
  const { sealed: _s, ...rest } = auth;
  return { ...rest, ...secrets };
}

/** Redact secrets for API/UI serialization. */
export function maskAuthConfig(auth: IToolAuthConfig | undefined): IToolAuthConfig {
  if (!auth) return { type: 'none' };
  const masked: IToolAuthConfig = { type: auth.type };
  if (auth.headerName) masked.headerName = auth.headerName;
  if (auth.username) masked.username = auth.username;
  const sealedSecrets = auth.sealed
    ? (() => {
        try {
          return decryptObject<SealedAuthSecrets>(auth.sealed as string);
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
 * Merge an auth-config update coming from an API caller onto the stored
 * config. Masked values (the literal mask placeholder) mean "keep the
 * current secret". This is the ONLY place a previously-sealed payload is
 * carried forward across a call — via `opened` (decrypted from the trusted,
 * already-stored `current` config), never via the caller's own `sealed`
 * field, which is always stripped before re-sealing.
 */
export function mergeAuthConfigUpdate(
  current: IToolAuthConfig | undefined,
  incoming: IToolAuthConfig,
): IToolAuthConfig {
  if (incoming.type === 'none') return { type: 'none' };
  const opened = current ? openAuthConfig(current) : { type: 'none' as const };
  const next: IToolAuthConfig = { ...incoming };
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

export const TOOL_SECRET_MASK = MASK;
