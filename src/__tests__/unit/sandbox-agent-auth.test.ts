/**
 * Sandbox agent auth: token generation, hashing, constant-time comparison.
 * Pure functions — no DB.
 */

import { describe, expect, it } from 'vitest';
import {
  generateAgentToken,
  generateRegistrationToken,
  hashToken,
  tokensMatchByHash,
} from '@/lib/services/sandbox/agentAuth';

describe('sandbox agentAuth', () => {
  it('registration tokens are unique and prefixed', () => {
    const a = generateRegistrationToken();
    const b = generateRegistrationToken();
    expect(a).toMatch(/^sbref_[0-9a-f]{48}$/);
    expect(b).toMatch(/^sbref_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it('agent tokens are unique and prefixed', () => {
    const a = generateAgentToken();
    const b = generateAgentToken();
    expect(a).toMatch(/^sbat_[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('hashToken is deterministic 64-char hex sha256', () => {
    const h1 = hashToken('hello');
    const h2 = hashToken('hello');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('hello')).not.toBe(hashToken('world'));
  });

  it('tokensMatchByHash matches the right token and rejects others', () => {
    const token = generateAgentToken();
    const stored = hashToken(token);
    expect(tokensMatchByHash(token, stored)).toBe(true);
    expect(tokensMatchByHash(generateAgentToken(), stored)).toBe(false);
  });
});
