/**
 * The AI App Gateway's per-user credential (`cpgw_` + 64 hex chars) spends the
 * organisation's upstream credit. It must be a KNOWN secret pattern so the
 * secrets family flags it regardless of the entropy floor — a hex string has
 * low character variety and would otherwise slip under it.
 */
import { describe, it, expect } from 'vitest';
import { KNOWN_SECRET_PATTERNS, isKnownSecret, scanSecrets } from '@/lib/services/guardrail/families/secrets';

const HEX64 = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const TOKEN = `cpgw_${HEX64}`;

describe('secrets family — gateway credential pattern', () => {
  it('registers a dedicated pattern id', () => {
    expect(KNOWN_SECRET_PATTERNS.some((p) => p.id === 'gateway_credential')).toBe(true);
  });

  it('recognises a cpgw_ token as a known secret even with low entropy', () => {
    expect(isKnownSecret(TOKEN)).toBe(true);
  });

  it('scanSecrets reports the token with the gateway pattern id', () => {
    const matches = scanSecrets(`export ANTHROPIC_AUTH_TOKEN=${TOKEN}`);
    expect(matches.some((m) => m.patternId === 'gateway_credential' || m.value === TOKEN)).toBe(true);
  });

  it('does not match a short or non-hex cpgw_ prefix', () => {
    expect(isKnownSecret('cpgw_short')).toBe(false);
    expect(isKnownSecret(`cpgw_${'g'.repeat(64)}`)).toBe(false);
  });
});
