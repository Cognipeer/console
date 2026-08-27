/**
 * Unit tests — tool secret vault.
 * Seals tool upstream-auth secrets (bearer token / header value / basic-auth
 * password) with AES-256-GCM, restores them for outbound calls, masks them
 * for serialization, and honors the "masked value means keep the stored
 * secret" update contract.
 *
 * Also covers the CWE-915 mass-assignment / decryption-oracle regression:
 * `createTool` calls `sealAuthConfig` directly on unvalidated request-body
 * input, so `sealAuthConfig` must never echo back a caller-supplied `sealed`
 * field it did not itself just compute — otherwise a caller could plant an
 * arbitrary ciphertext (e.g. one stolen from elsewhere in the deployment)
 * that a later sync/execution would decrypt and send to an attacker-
 * controlled endpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  auth: { providerEncryptionSecret: 's'.repeat(40), jwtSecret: 'j'.repeat(40) },
}));

vi.mock('@/lib/core/config', () => ({
  getConfig: () => cfg,
}));

import {
  TOOL_SECRET_MASK,
  maskAuthConfig,
  mergeAuthConfigUpdate,
  openAuthConfig,
  sealAuthConfig,
} from '@/lib/services/tools/secretVault';
import type { IToolAuthConfig } from '@/lib/database';

beforeEach(() => {
  cfg.auth.providerEncryptionSecret = 's'.repeat(40);
  cfg.auth.jwtSecret = 'j'.repeat(40);
});

describe('sealAuthConfig / openAuthConfig', () => {
  it('round-trips a bearer token', () => {
    const sealed = sealAuthConfig({ type: 'token', token: 'sk-super-secret' });
    expect(sealed.token).toBeUndefined();
    expect(sealed.sealed).toBeTruthy();
    const opened = openAuthConfig(sealed);
    expect(opened.token).toBe('sk-super-secret');
    expect(opened.type).toBe('token');
  });

  it('round-trips header + basic secrets and keeps non-secret fields plaintext', () => {
    const sealedHeader = sealAuthConfig({ type: 'header', headerName: 'X-Key', headerValue: 'v-1' });
    expect(sealedHeader.headerName).toBe('X-Key');
    expect(sealedHeader.headerValue).toBeUndefined();
    expect(openAuthConfig(sealedHeader).headerValue).toBe('v-1');

    const sealedBasic = sealAuthConfig({ type: 'basic', username: 'admin', password: 'pw' });
    expect(sealedBasic.username).toBe('admin');
    expect(sealedBasic.password).toBeUndefined();
    expect(openAuthConfig(sealedBasic).password).toBe('pw');
  });

  it('passes legacy plaintext configs through unchanged on open', () => {
    const legacy: IToolAuthConfig = { type: 'token', token: 'legacy-token' };
    expect(openAuthConfig(legacy).token).toBe('legacy-token');
  });

  it('normalizes "none" to a bare config', () => {
    expect(sealAuthConfig({ type: 'none', token: 'should-drop' })).toEqual({ type: 'none' });
  });
});

describe('sealAuthConfig — decryption-oracle regression (CWE-915)', () => {
  it('never echoes back a caller-supplied `sealed` value when there is nothing new to seal', () => {
    // Simulates createTool's direct call on raw, unvalidated request-body
    // input: an attacker supplies a fabricated/stolen ciphertext under
    // `sealed` and no plaintext secret fields.
    const attackerInput = {
      type: 'token',
      sealed: 'attacker-supplied-or-stolen-ciphertext',
    } as IToolAuthConfig;

    const stored = sealAuthConfig(attackerInput);

    expect(stored.sealed).toBeUndefined();
    expect(stored).toEqual({ type: 'token' });

    // The record now has no `.sealed` at all, so opening it at sync/execute
    // time is a no-op — no decryption is attempted on the attacker's value,
    // and nothing is sent as a credential to an outbound call.
    const opened = openAuthConfig(stored);
    expect(opened.token).toBeUndefined();
    expect(opened.sealed).toBeUndefined();
  });

  it('overwrites an attacker-supplied `sealed` even when a real plaintext secret is also present', () => {
    const attackerInput = {
      type: 'token',
      token: 'my-own-real-token',
      sealed: 'attacker-supplied-or-stolen-ciphertext',
    } as IToolAuthConfig;

    const stored = sealAuthConfig(attackerInput);

    expect(stored.sealed).toBeTruthy();
    expect(stored.sealed).not.toBe('attacker-supplied-or-stolen-ciphertext');
    expect(openAuthConfig(stored).token).toBe('my-own-real-token');
  });
});

describe('maskAuthConfig', () => {
  it('masks sealed secrets without leaking values', () => {
    const sealed = sealAuthConfig({ type: 'token', token: 'sk-secret' });
    const masked = maskAuthConfig(sealed);
    expect(masked.token).toBe(TOOL_SECRET_MASK);
    expect(masked.sealed).toBeUndefined();
    expect(JSON.stringify(masked)).not.toContain('sk-secret');
  });

  it('masks legacy plaintext secrets too', () => {
    const masked = maskAuthConfig({ type: 'basic', username: 'admin', password: 'pw' });
    expect(masked.username).toBe('admin');
    expect(masked.password).toBe(TOOL_SECRET_MASK);
  });
});

describe('mergeAuthConfigUpdate', () => {
  it('keeps the stored secret when the update carries the mask placeholder', () => {
    const stored = sealAuthConfig({ type: 'token', token: 'original' });
    const merged = mergeAuthConfigUpdate(stored, { type: 'token', token: TOOL_SECRET_MASK });
    expect(openAuthConfig(merged).token).toBe('original');
  });

  it('replaces the secret when a new value is provided', () => {
    const stored = sealAuthConfig({ type: 'token', token: 'original' });
    const merged = mergeAuthConfigUpdate(stored, { type: 'token', token: 'rotated' });
    expect(openAuthConfig(merged).token).toBe('rotated');
  });

  it('re-seals legacy plaintext on the next save', () => {
    const legacy: IToolAuthConfig = { type: 'token', token: 'legacy' };
    const merged = mergeAuthConfigUpdate(legacy, { type: 'token', token: TOOL_SECRET_MASK });
    expect(merged.sealed).toBeTruthy();
    expect(merged.token).toBeUndefined();
    expect(openAuthConfig(merged).token).toBe('legacy');
  });

  it('ignores an attacker-supplied `sealed` field on the incoming update', () => {
    const stored = sealAuthConfig({ type: 'token', token: 'original' });
    const merged = mergeAuthConfigUpdate(stored, {
      type: 'token',
      token: TOOL_SECRET_MASK,
      sealed: 'attacker-supplied-ciphertext',
    } as IToolAuthConfig);
    expect(merged.sealed).not.toBe('attacker-supplied-ciphertext');
    expect(openAuthConfig(merged).token).toBe('original');
  });
});
