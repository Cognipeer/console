/**
 * Inference server apiKey vault — seals the vLLM/llama.cpp monitoring
 * `apiKey` at rest with AES-256-GCM (same key material as MCP secrets and
 * provider credentials; see `@/lib/utils/crypto`).
 *
 * Storage rules:
 * - `sealApiKey` is the only function that produces an `apiKeySealed`
 *   ciphertext, and it always derives it from the plaintext value passed
 *   into that same call. It never re-emits a caller-supplied value, so a
 *   forged/foreign ciphertext blob can never be persisted as if this vault
 *   had sealed it.
 * - `openApiKey` decrypts the sealed value for runtime use only where the
 *   key is actually needed (polling the upstream server) — never on plain
 *   list/read paths. Legacy rows written before this vault existed (a
 *   plaintext `apiKey`, no `apiKeySealed`) still resolve correctly and get
 *   sealed on their next save.
 */

import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { IInferenceServer } from '@/lib/database';

interface SealedApiKeyPayload {
  apiKey: string;
}

/** Encrypt a plaintext apiKey for storage. */
export function sealApiKey(apiKey: string): string {
  const payload: SealedApiKeyPayload = { apiKey };
  return encryptObject(payload);
}

/**
 * Decrypt a server's apiKey for runtime use (polling only). Prefers the
 * sealed ciphertext; falls back to a legacy plaintext `apiKey` field for
 * rows written before this vault existed.
 */
export function openApiKey(
  server: Pick<IInferenceServer, 'apiKey' | 'apiKeySealed'> | null | undefined,
): string | undefined {
  if (!server) return undefined;
  if (server.apiKeySealed) {
    try {
      return decryptObject<SealedApiKeyPayload>(server.apiKeySealed).apiKey;
    } catch {
      return undefined;
    }
  }
  return server.apiKey || undefined;
}
