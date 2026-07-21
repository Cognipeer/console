/**
 * Runtime invocation context — parsing, per-target policy resolution, and the
 * always-on header blocklist. This is the security core of caller-supplied
 * header passthrough: default-deny per target, hop-by-hop headers stripped,
 * log surfaces get header names only.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRuntimeContextFromRequest,
  collectRuntimeHeadersFromHttpHeaders,
  describeRuntimeAuth,
  mergeRuntimeContext,
  parseRuntimeContext,
  resolveRuntimeHeaders,
  runtimeHeaderPolicyFromMetadata,
} from '@/lib/services/runtimeContext';

describe('parseRuntimeContext', () => {
  it('accepts headers and connections, dropping non-string values', () => {
    const ctx = parseRuntimeContext({
      headers: { Authorization: 'Bearer abc', 'X-Num': 42 },
      connections: {
        'tool:crm': { headers: { 'X-Crm-Token': 't1' } },
        broken: 'not-an-object',
      },
    });
    expect(ctx?.headers).toEqual({ Authorization: 'Bearer abc' });
    expect(ctx?.connections).toEqual({ 'tool:crm': { headers: { 'X-Crm-Token': 't1' } } });
  });

  it('returns undefined for empty or non-object input', () => {
    expect(parseRuntimeContext(undefined)).toBeUndefined();
    expect(parseRuntimeContext('nope')).toBeUndefined();
    expect(parseRuntimeContext({})).toBeUndefined();
    expect(parseRuntimeContext({ headers: { 'X-Bad': 1 } })).toBeUndefined();
  });

  it('strips blocklisted, malformed, and injection-prone headers', () => {
    const ctx = parseRuntimeContext({
      headers: {
        Host: 'evil.example',
        'Content-Length': '0',
        'Transfer-Encoding': 'chunked',
        'X-Ok': 'fine',
        'Bad Name': 'x',
        'X-Injected': "value\r\nX-Smuggled: yes",
      },
    });
    expect(ctx?.headers).toEqual({ 'X-Ok': 'fine' });
  });

  it('ignores caller attempts to set server-stamped identity fields', () => {
    const ctx = parseRuntimeContext({
      headers: { 'X-Ok': 'v' },
      userId: 'spoofed',
      tokenId: 'spoofed',
      source: 'a2a',
    });
    expect(ctx?.userId).toBeUndefined();
    expect(ctx?.tokenId).toBeUndefined();
    expect(ctx?.source).toBeUndefined();
  });
});

describe('collectRuntimeHeadersFromHttpHeaders + merge', () => {
  it('collects x-cpr-hdr-* headers and lets body headers win on merge', () => {
    const offered = collectRuntimeHeadersFromHttpHeaders({
      'x-cpr-hdr-authorization': 'Bearer from-header',
      'x-cpr-hdr-x-extra': 'e1',
      'x-forwarded-for': '1.2.3.4',
    });
    expect(offered).toEqual({ authorization: 'Bearer from-header', 'x-extra': 'e1' });

    const merged = mergeRuntimeContext(
      { headers: { authorization: 'Bearer from-body' } },
      offered,
    );
    expect(merged?.headers?.authorization).toBe('Bearer from-body');
    expect(merged?.headers?.['x-extra']).toBe('e1');
  });

  it('never collects blocklisted names through the header convention', () => {
    expect(collectRuntimeHeadersFromHttpHeaders({ 'x-cpr-hdr-host': 'evil' })).toBeUndefined();
  });
});

describe('resolveRuntimeHeaders (per-target policy)', () => {
  const ctx = {
    headers: { Authorization: 'Bearer global' },
    connections: {
      'tool:crm': { headers: { Authorization: 'Bearer scoped', 'X-Crm': '1' } },
    },
  };

  it('is default-deny: no policy or allow:false → nothing passes', () => {
    expect(resolveRuntimeHeaders(ctx, 'tool', 'crm', undefined)).toBeUndefined();
    expect(resolveRuntimeHeaders(ctx, 'tool', 'crm', { allow: false })).toBeUndefined();
  });

  it('scoped headers win over global when the target opts in', () => {
    const applied = resolveRuntimeHeaders(ctx, 'tool', 'crm', { allow: true });
    expect(applied).toEqual({ Authorization: 'Bearer scoped', 'X-Crm': '1' });
  });

  it('falls back to global headers for targets without a scoped entry', () => {
    expect(resolveRuntimeHeaders(ctx, 'mcp', 'other', { allow: true }))
      .toEqual({ Authorization: 'Bearer global' });
  });

  it('applies the allowedNames allowlist case-insensitively', () => {
    const applied = resolveRuntimeHeaders(ctx, 'tool', 'crm', {
      allow: true,
      allowedNames: ['authorization'],
    });
    expect(applied).toEqual({ Authorization: 'Bearer scoped' });
  });

  it('resolves bare (unprefixed) connection keys too', () => {
    const bare = { connections: { crm: { headers: { 'X-Only': 'v' } } } };
    expect(resolveRuntimeHeaders(bare, 'tool', 'crm', { allow: true }))
      .toEqual({ 'X-Only': 'v' });
  });
});

describe('runtimeHeaderPolicyFromMetadata', () => {
  it('reads the policy from a record metadata blob', () => {
    expect(runtimeHeaderPolicyFromMetadata({ runtimeHeaders: { allow: true } }))
      .toEqual({ allow: true });
    expect(runtimeHeaderPolicyFromMetadata({ runtimeHeaders: { allow: 'yes' } }))
      .toEqual({ allow: false });
    expect(runtimeHeaderPolicyFromMetadata({})).toBeUndefined();
    expect(runtimeHeaderPolicyFromMetadata(undefined)).toBeUndefined();
  });
});

describe('describeRuntimeAuth', () => {
  it('exposes header NAMES only — never values', () => {
    const info = describeRuntimeAuth(
      { source: 'api', userId: 'u1' },
      { Authorization: 'Bearer secret', 'X-Crm': 'secret2' },
    );
    expect(info).toEqual({ headerKeys: ['Authorization', 'X-Crm'], source: 'api', userId: 'u1' });
    expect(JSON.stringify(info)).not.toContain('secret');
  });

  it('returns undefined when nothing was applied', () => {
    expect(describeRuntimeAuth({ headers: { A: 'b' } }, undefined)).toBeUndefined();
  });
});

describe('buildRuntimeContextFromRequest', () => {
  it('merges body + header conventions and stamps caller identity', () => {
    const ctx = buildRuntimeContextFromRequest(
      { headers: { 'X-From-Body': '1' } },
      { 'x-cpr-hdr-x-from-header': '2' },
      { userId: 'u1', tokenId: 't1', source: 'api' },
    );
    expect(ctx).toEqual({
      headers: { 'x-from-header': '2', 'X-From-Body': '1' },
      userId: 'u1',
      tokenId: 't1',
      source: 'api',
    });
  });

  it('returns undefined when the caller offered nothing', () => {
    expect(buildRuntimeContextFromRequest(undefined, {}, { source: 'api' })).toBeUndefined();
  });
});
