/**
 * Token issuance + verification for the GPU agent <-> console handshake.
 *
 * Two token kinds:
 *   - registration token: one-time, short-lived; shown in the UI; exchanged
 *     for an agent token via POST /api/gpu/agent/handshake.
 *   - agent token: long-lived opaque bearer; hashed before storage; sent on
 *     every subsequent request.
 *
 * Both use the same `randomTokenString` generator + SHA-256 hashing path so
 * the storage column types and code paths line up.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const REGISTRATION_TOKEN_BYTES = 24; // 48 hex chars
const AGENT_TOKEN_BYTES = 32; // 64 hex chars

export function generateRegistrationToken(): string {
  // Prefix lets a leaker spot the token type by eye in logs.
  return `gpuref_${randomBytes(REGISTRATION_TOKEN_BYTES).toString('hex')}`;
}

export function generateAgentToken(): string {
  return `gpuat_${randomBytes(AGENT_TOKEN_BYTES).toString('hex')}`;
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Constant-time hash equality. Both inputs MUST be hex strings of the same
 * length (the storage column always stores SHA-256/hex, so this holds).
 */
export function tokensMatchByHash(rawToken: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(rawToken), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
