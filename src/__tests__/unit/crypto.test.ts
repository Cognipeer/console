/**
 * Unit tests — provider credential crypto.
 * Verifies round-trip and the multi-secret decrypt fallback that keeps
 * credentials readable when PROVIDER_ENCRYPTION_SECRET is introduced after
 * they were encrypted under JWT_SECRET.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  auth: { providerEncryptionSecret: '', jwtSecret: '' },
}));

vi.mock('@/lib/core/config', () => ({
  getConfig: () => cfg,
}));

import { encryptObject, decryptObject } from '@/lib/utils/crypto';

const LONG_A = 'a'.repeat(40);
const LONG_B = 'b'.repeat(40);

beforeEach(() => {
  cfg.auth.providerEncryptionSecret = '';
  cfg.auth.jwtSecret = '';
});

describe('crypto round-trip', () => {
  it('encrypts and decrypts with the provider secret', () => {
    cfg.auth.providerEncryptionSecret = LONG_A;
    cfg.auth.jwtSecret = LONG_B;
    const blob = encryptObject({ apiKey: 'sk-123', region: 'eu' });
    expect(decryptObject(blob)).toEqual({ apiKey: 'sk-123', region: 'eu' });
  });

  it('encrypts and decrypts with only the JWT secret', () => {
    cfg.auth.jwtSecret = LONG_B;
    const blob = encryptObject({ token: 't' });
    expect(decryptObject(blob)).toEqual({ token: 't' });
  });

  it('throws when no secret is configured', () => {
    expect(() => encryptObject({ a: 1 })).toThrow(/Encryption secret is not configured/);
  });
});

describe('multi-secret decrypt fallback', () => {
  it('decrypts a payload encrypted under JWT_SECRET after PROVIDER_ENCRYPTION_SECRET is introduced', () => {
    // Encrypt when only JWT_SECRET exists (the pre-migration state).
    cfg.auth.jwtSecret = LONG_B;
    const blob = encryptObject({ apiKey: 'legacy-key' });

    // Later, a dedicated provider secret is introduced. The primary key is now
    // the provider secret, but the payload was encrypted under JWT_SECRET.
    cfg.auth.providerEncryptionSecret = LONG_A;
    expect(decryptObject(blob)).toEqual({ apiKey: 'legacy-key' });
  });

  it('new payloads use the provider secret (primary), still readable', () => {
    cfg.auth.providerEncryptionSecret = LONG_A;
    cfg.auth.jwtSecret = LONG_B;
    const blob = encryptObject({ apiKey: 'new-key' });
    expect(decryptObject(blob)).toEqual({ apiKey: 'new-key' });
  });

  it('fails when the encrypting secret is not among the configured candidates', () => {
    // Encrypted under a secret that is later removed entirely.
    cfg.auth.jwtSecret = 'c'.repeat(40);
    const blob = encryptObject({ apiKey: 'orphan' });

    cfg.auth.providerEncryptionSecret = LONG_A;
    cfg.auth.jwtSecret = LONG_B;
    expect(() => decryptObject(blob)).toThrow();
  });
});
