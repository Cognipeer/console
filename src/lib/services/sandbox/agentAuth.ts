/**
 * Token issuance + verification for the sandbox runner <-> console handshake.
 *
 * Independent of the gpu-fleet auth module. Two token kinds:
 *   - registration token (`sbref_`): one-time, short-lived; shown once in the
 *     UI; exchanged for an agent token via the runner handshake endpoint.
 *   - agent token (`sbat_`): long-lived opaque bearer; hashed before storage;
 *     sent on every subsequent runner request.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const REGISTRATION_TOKEN_BYTES = 24; // 48 hex chars
const AGENT_TOKEN_BYTES = 32; // 64 hex chars

export function generateRegistrationToken(): string {
  return `sbref_${randomBytes(REGISTRATION_TOKEN_BYTES).toString('hex')}`;
}

export function generateAgentToken(): string {
  return `sbat_${randomBytes(AGENT_TOKEN_BYTES).toString('hex')}`;
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Constant-time hash equality. Both inputs are hex; lengths must match. */
export function tokensMatchByHash(rawToken: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(rawToken), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
