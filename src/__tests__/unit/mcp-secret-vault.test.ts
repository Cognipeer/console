/**
 * Unit tests — MCP secret vault.
 * Seals upstream auth secrets / stdio env maps with AES-256-GCM, restores
 * them for runtime use, masks them for serialization, and honors the
 * "masked value means keep the stored secret" update contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  auth: { providerEncryptionSecret: 's'.repeat(40), jwtSecret: 'j'.repeat(40) },
}));

vi.mock('@/lib/core/config', () => ({
  getConfig: () => cfg,
}));

import {
  MCP_SECRET_MASK,
  maskAuthConfig,
  maskStdioConfig,
  mergeAuthConfigUpdate,
  mergeStdioConfigUpdate,
  openAuthConfig,
  openStdioEnv,
  sealAuthConfig,
  sealStdioEnv,
} from '@/lib/services/mcp/secretVault';
import type { IMcpAuthConfig, IMcpStdioConfig } from '@/lib/database';

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
    const legacy: IMcpAuthConfig = { type: 'token', token: 'legacy-token' };
    expect(openAuthConfig(legacy).token).toBe('legacy-token');
  });

  it('normalizes "none" to a bare config', () => {
    expect(sealAuthConfig({ type: 'none', token: 'should-drop' })).toEqual({ type: 'none' });
  });
});

describe('maskAuthConfig', () => {
  it('masks sealed secrets without leaking values', () => {
    const sealed = sealAuthConfig({ type: 'token', token: 'sk-secret' });
    const masked = maskAuthConfig(sealed);
    expect(masked.token).toBe(MCP_SECRET_MASK);
    expect(masked.sealed).toBeUndefined();
    expect(JSON.stringify(masked)).not.toContain('sk-secret');
  });

  it('masks legacy plaintext secrets too', () => {
    const masked = maskAuthConfig({ type: 'basic', username: 'admin', password: 'pw' });
    expect(masked.username).toBe('admin');
    expect(masked.password).toBe(MCP_SECRET_MASK);
  });
});

describe('mergeAuthConfigUpdate', () => {
  it('keeps the stored secret when the update carries the mask placeholder', () => {
    const stored = sealAuthConfig({ type: 'token', token: 'original' });
    const merged = mergeAuthConfigUpdate(stored, { type: 'token', token: MCP_SECRET_MASK });
    expect(openAuthConfig(merged).token).toBe('original');
  });

  it('replaces the secret when a new value is provided', () => {
    const stored = sealAuthConfig({ type: 'token', token: 'original' });
    const merged = mergeAuthConfigUpdate(stored, { type: 'token', token: 'rotated' });
    expect(openAuthConfig(merged).token).toBe('rotated');
  });

  it('re-seals legacy plaintext on the next save', () => {
    const legacy: IMcpAuthConfig = { type: 'token', token: 'legacy' };
    const merged = mergeAuthConfigUpdate(legacy, { type: 'token', token: MCP_SECRET_MASK });
    expect(merged.sealed).toBeTruthy();
    expect(merged.token).toBeUndefined();
    expect(openAuthConfig(merged).token).toBe('legacy');
  });
});

describe('stdio env sealing', () => {
  const baseConfig: IMcpStdioConfig = {
    runtime: 'npx',
    packageName: '@example/mcp-server',
    executionMode: 'subprocess',
    env: { API_KEY: 'k-123', REGION: 'eu' },
  };

  it('round-trips the env map', () => {
    const sealed = sealStdioEnv(baseConfig);
    expect(sealed.env).toBeUndefined();
    expect(sealed.envSealed).toBeTruthy();
    expect(openStdioEnv(sealed)).toEqual({ API_KEY: 'k-123', REGION: 'eu' });
  });

  it('masks env values but keeps keys visible', () => {
    const sealed = sealStdioEnv(baseConfig);
    const masked = maskStdioConfig(sealed);
    expect(masked?.env).toEqual({ API_KEY: MCP_SECRET_MASK, REGION: MCP_SECRET_MASK });
    expect(masked?.envSealed).toBeUndefined();
    expect(JSON.stringify(masked)).not.toContain('k-123');
  });

  it('merge keeps masked values, replaces new ones, drops removed keys', () => {
    const stored = sealStdioEnv(baseConfig);
    const merged = mergeStdioConfigUpdate(stored, {
      ...baseConfig,
      env: { API_KEY: MCP_SECRET_MASK, NEW_VAR: 'fresh' },
    });
    expect(openStdioEnv(merged)).toEqual({ API_KEY: 'k-123', NEW_VAR: 'fresh' });
  });
});
