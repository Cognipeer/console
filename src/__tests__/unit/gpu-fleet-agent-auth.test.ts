/**
 * Token primitives the entire GPU agent <-> console handshake leans on.
 * If hashing collides or constant-time comparison regresses, every other
 * test in this directory becomes meaningless — these go first.
 */

import { describe, expect, it } from 'vitest';
import {
  generateAgentToken,
  generateRegistrationToken,
  hashToken,
  tokensMatchByHash,
} from '@/lib/services/gpuFleet/agentAuth';

describe('agentAuth', () => {
  describe('generateRegistrationToken', () => {
    it('produces values with the documented gpuref_ prefix', () => {
      const token = generateRegistrationToken();
      expect(token.startsWith('gpuref_')).toBe(true);
    });

    it('produces enough entropy to be unique across consecutive calls', () => {
      const set = new Set(Array.from({ length: 100 }, () => generateRegistrationToken()));
      expect(set.size).toBe(100);
    });
  });

  describe('generateAgentToken', () => {
    it('has a distinct prefix from registration tokens', () => {
      const reg = generateRegistrationToken();
      const agent = generateAgentToken();
      expect(agent.startsWith('gpuat_')).toBe(true);
      expect(reg.startsWith('gpuat_')).toBe(false);
    });
  });

  describe('hashToken', () => {
    it('is deterministic for the same input', () => {
      const a = hashToken('hello');
      const b = hashToken('hello');
      expect(a).toBe(b);
    });

    it('changes for different inputs', () => {
      expect(hashToken('a')).not.toBe(hashToken('b'));
    });

    it('returns a 64-char hex string (sha256)', () => {
      expect(hashToken('x')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('tokensMatchByHash', () => {
    it('matches when the raw token hashes to the stored value', () => {
      const raw = 'gpuref_abcdef';
      expect(tokensMatchByHash(raw, hashToken(raw))).toBe(true);
    });

    it('rejects mismatched tokens', () => {
      expect(tokensMatchByHash('wrong', hashToken('right'))).toBe(false);
    });

    it('returns false on length mismatch without throwing', () => {
      expect(tokensMatchByHash('anything', '')).toBe(false);
      expect(tokensMatchByHash('anything', 'deadbeef')).toBe(false);
    });
  });
});
