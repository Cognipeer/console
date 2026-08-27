/**
 * Crawler HTTP-config secret handling — seals upstream credentials (bearer
 * token, basic-auth password, cookie values) with AES-256-GCM (same key
 * material as provider/MCP credentials, see `@/lib/utils/crypto`), mirroring
 * the MCP secret vault (`@/lib/services/mcp/secretVault`).
 *
 * Storage rules:
 * - `sealHttpConfig` moves `bearerToken` / `basicAuth.password` /
 *   `cookies[].value` into the encrypted `sealed` payload; every other field
 *   (userAgent, headers, cookie names/domains, basicAuth.username, timeouts,
 *   …) stays plaintext for display and reuse.
 * - `openHttpConfig` restores a fully-populated plaintext config for
 *   crawl-execution use only. Legacy records that still carry plaintext
 *   secrets pass through unchanged and get sealed on their next save.
 * - `maskHttpConfig` redacts the same three fields for API/UI serialization
 *   (crawler records AND queued/finished job `planSnapshot.http`).
 * - `mergeHttpConfigUpdate` lets the UI submit back the mask placeholder to
 *   mean "keep the stored secret", matching `mergeAuthConfigUpdate`'s
 *   convention — only the exact placeholder this module emits is treated
 *   that way, never a prefix/pattern match.
 */

import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { ICrawlerHttpConfig, ICrawlerWebhookConfig } from '@/lib/database';

const MASK = '••••••';

interface SealedHttpSecrets {
  bearerToken?: string;
  basicAuthPassword?: string;
  /** Aligned by index with the (secret-stripped) `cookies` array. */
  cookieValues?: string[];
}

function hasPlaintextSecrets(http: ICrawlerHttpConfig): boolean {
  return Boolean(
    http.bearerToken
    || http.basicAuth?.password
    || http.cookies?.some((c) => c.value),
  );
}

/** Encrypt the secret fields of an HTTP config for storage. */
export function sealHttpConfig(http: ICrawlerHttpConfig): ICrawlerHttpConfig {
  if (!http) return http;
  if (!hasPlaintextSecrets(http)) {
    // Nothing new to seal — keep any existing sealed payload untouched.
    return { ...http };
  }
  const secrets: SealedHttpSecrets = {};
  if (http.bearerToken) secrets.bearerToken = http.bearerToken;
  if (http.basicAuth?.password) secrets.basicAuthPassword = http.basicAuth.password;
  if (http.cookies?.length) secrets.cookieValues = http.cookies.map((c) => c.value ?? '');

  const sealed = encryptObject(secrets);
  const { bearerToken: _bt, ...rest } = http;
  return {
    ...rest,
    basicAuth: http.basicAuth ? { username: http.basicAuth.username } : undefined,
    cookies: http.cookies?.map(({ value: _v, ...cookieRest }) => cookieRest),
    sealed,
  };
}

/** Decrypt an HTTP config for crawl-execution use. Legacy plaintext passes through. */
export function openHttpConfig(http: ICrawlerHttpConfig | undefined): ICrawlerHttpConfig {
  if (!http) return {};
  if (!http.sealed) return { ...http };
  const secrets = decryptObject<SealedHttpSecrets>(http.sealed);
  const { sealed: _s, ...rest } = http;
  return {
    ...rest,
    bearerToken: secrets.bearerToken,
    basicAuth: rest.basicAuth
      ? { username: rest.basicAuth.username, password: secrets.basicAuthPassword }
      : undefined,
    cookies: rest.cookies?.map((c, i) => ({ ...c, value: secrets.cookieValues?.[i] ?? c.value })),
  };
}

/** Same as `openHttpConfig` but never throws — used for display masking only. */
function openHttpConfigSafe(http: ICrawlerHttpConfig | undefined): ICrawlerHttpConfig {
  try {
    return openHttpConfig(http);
  } catch {
    return http ? { ...http, sealed: undefined } : {};
  }
}

/** Redact secrets for API/UI serialization. */
export function maskHttpConfig(http: ICrawlerHttpConfig | undefined): ICrawlerHttpConfig {
  if (!http) return {};
  const opened = openHttpConfigSafe(http);
  const { sealed: _s, ...rest } = http;
  const masked: ICrawlerHttpConfig = { ...rest };
  if (opened.bearerToken) masked.bearerToken = MASK;
  if (opened.basicAuth) {
    masked.basicAuth = {
      username: opened.basicAuth.username,
      password: opened.basicAuth.password ? MASK : undefined,
    };
  }
  if (opened.cookies?.length) {
    masked.cookies = opened.cookies.map((c) => ({ ...c, value: c.value ? MASK : c.value }));
  }
  return masked;
}

/**
 * Merge an HTTP-config update coming from the UI/API onto the stored config.
 * Fields the caller omits keep their previous (decrypted) value; the literal
 * mask placeholder submitted back in `bearerToken` / `basicAuth.password` /
 * `cookies[].value` also means "keep the current secret".
 */
export function mergeHttpConfigUpdate(
  current: ICrawlerHttpConfig | undefined,
  incoming: Partial<ICrawlerHttpConfig>,
): ICrawlerHttpConfig {
  const opened = current ? openHttpConfig(current) : {};
  const merged: ICrawlerHttpConfig = { ...opened, ...incoming };

  if (incoming.bearerToken !== undefined) {
    merged.bearerToken = incoming.bearerToken === MASK ? opened.bearerToken : incoming.bearerToken;
  }
  if (incoming.basicAuth) {
    merged.basicAuth = {
      username: incoming.basicAuth.username,
      password: incoming.basicAuth.password === MASK
        ? opened.basicAuth?.password
        : incoming.basicAuth.password,
    };
  }
  if (incoming.cookies) {
    merged.cookies = incoming.cookies.map((cookie) => {
      if (cookie.value !== MASK) return cookie;
      const prior = opened.cookies?.find((c) => c.name === cookie.name);
      return { ...cookie, value: prior?.value ?? '' };
    });
  }
  delete (merged as { sealed?: string }).sealed;
  return sealHttpConfig(merged);
}

/** True when the given serialized value is the redaction placeholder. */
export function isMaskedHttpSecret(value: unknown): boolean {
  return value === MASK;
}

export const CRAWLER_HTTP_SECRET_MASK = MASK;

/**
 * Redact a webhook's HMAC signing secret for API/UI serialization (crawler
 * records AND queued/finished job `planSnapshot.webhook`) — mirrors
 * `maskHttpConfig`'s treatment of the crawler's own upstream credentials.
 * The secret is not sealed at rest by this module; only the read path is
 * masked, matching this finding's scope (API disclosure, not DB compromise).
 */
export function maskWebhookConfig(
  webhook: ICrawlerWebhookConfig | undefined,
): ICrawlerWebhookConfig | undefined {
  if (!webhook?.secret) return webhook;
  return { ...webhook, secret: MASK };
}

/**
 * Merge a webhook-config update coming from the UI/API onto the stored
 * config. The literal mask placeholder submitted back in `secret` means
 * "keep the current secret" — same convention as `mergeHttpConfigUpdate`.
 */
export function mergeWebhookConfigUpdate(
  current: ICrawlerWebhookConfig | undefined,
  incoming: ICrawlerWebhookConfig,
): ICrawlerWebhookConfig {
  if (incoming.secret === MASK) {
    return { ...incoming, secret: current?.secret };
  }
  return incoming;
}
