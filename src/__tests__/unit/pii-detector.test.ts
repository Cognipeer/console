/**
 * Unit tests — PII Detector
 * runPiiDetection is a pure function with no external dependencies.
 */

import { describe, it, expect } from 'vitest';
import { runPiiDetection } from '@/lib/services/guardrail/piiDetector';
import type { IGuardrailPiiPolicy } from '@/lib/database';

// ── helpers ───────────────────────────────────────────────────────────────────

function makePolicy(
  categories: Record<string, boolean>,
  overrides: Partial<IGuardrailPiiPolicy> = {},
): IGuardrailPiiPolicy {
  return { enabled: true, action: 'block', categories, ...overrides };
}

const ALL_ENABLED: IGuardrailPiiPolicy = makePolicy({
  email: true,
  phone: true,
  creditCard: true,
  ipAddress: true,
  url: true,
  apiKey: true,
  nationalId: true,
  socialHandle: true,
});

// ── disabled policy ───────────────────────────────────────────────────────────

describe('runPiiDetection — policy disabled', () => {
  it('returns no findings when policy.enabled is false', () => {
    const findings = runPiiDetection('user@example.com', {
      enabled: false,
      action: 'block',
      categories: { email: true },
    });
    expect(findings).toHaveLength(0);
  });

  it('returns no findings when categories object is empty', () => {
    const findings = runPiiDetection('user@example.com', makePolicy({}));
    expect(findings).toHaveLength(0);
  });

  it('returns no findings when all categories are false', () => {
    const findings = runPiiDetection('user@example.com', makePolicy({ email: false }));
    expect(findings).toHaveLength(0);
  });
});

// ── email detection ───────────────────────────────────────────────────────────

describe('runPiiDetection — email', () => {
  const policy = makePolicy({ email: true });

  it('detects a single email address', () => {
    const findings = runPiiDetection('Contact us at hello@example.com', policy);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('email');
    expect(findings[0].value).toBe('hello@example.com');
    expect(findings[0].block).toBe(true);
    expect(findings[0].severity).toBe('high');
  });

  it('detects multiple email addresses', () => {
    const findings = runPiiDetection('a@b.com and c@d.org', policy);
    expect(findings).toHaveLength(2);
  });

  it('does not flag plain text without email', () => {
    const findings = runPiiDetection('no email here', policy);
    expect(findings).toHaveLength(0);
  });

  it('uses "warn" action when policy action is warn', () => {
    const warnPolicy = makePolicy({ email: true }, { action: 'warn' });
    const findings = runPiiDetection('user@test.com', warnPolicy);
    expect(findings[0].block).toBe(false);
    expect(findings[0].action).toBe('warn');
  });
});

// ── phone detection ───────────────────────────────────────────────────────────

describe('runPiiDetection — phone', () => {
  const policy = makePolicy({ phone: true });

  it('detects a US phone number', () => {
    const findings = runPiiDetection('Call +1 555-867-5309', policy);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('phone');
  });

  it('detects international phone with country code', () => {
    const findings = runPiiDetection('+44 20 7946 0958', policy);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('does not flag short numeric sequences', () => {
    const findings = runPiiDetection('The code is 1234', policy);
    expect(findings).toHaveLength(0);
  });
});

// ── credit card detection ─────────────────────────────────────────────────────

describe('runPiiDetection — creditCard', () => {
  const policy = makePolicy({ creditCard: true });

  it('detects a valid Visa card number (Luhn valid)', () => {
    // 4111111111111111 is the canonical test Visa number (Luhn: valid)
    const findings = runPiiDetection('Card: 4111111111111111', policy);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('creditCard');
  });

  it('does not flag a random 16-digit number that fails Luhn', () => {
    const findings = runPiiDetection('Item ID: 1234567890123456', policy);
    // random sequence unlikely to be Luhn-valid
    expect(findings).toHaveLength(0);
  });
});

// ── IP address detection ──────────────────────────────────────────────────────

describe('runPiiDetection — ipAddress', () => {
  const policy = makePolicy({ ipAddress: true });

  it('detects an IPv4 address', () => {
    const findings = runPiiDetection('Server at 192.168.1.1 is down', policy);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('ipAddress');
    expect(findings[0].value).toContain('192.168.1.1');
  });

  it('does not flag a version string like 1.2.3', () => {
    // Only 3 octets — does not match x.x.x.x
    const findings = runPiiDetection('Version 1.2.3 released', policy);
    expect(findings).toHaveLength(0);
  });
});

// ── social handle detection ───────────────────────────────────────────────────

describe('runPiiDetection — socialHandle', () => {
  const policy = makePolicy({ socialHandle: true });

  it('detects a Twitter/X handle', () => {
    const findings = runPiiDetection('Follow @cognipeer for updates', policy);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('socialHandle');
    expect(findings[0].value).toContain('@cognipeer');
  });
});

// ── URL detection ─────────────────────────────────────────────────────────────

describe('runPiiDetection — url', () => {
  const policy = makePolicy({ url: true });

  it('detects an https URL', () => {
    const findings = runPiiDetection('Visit https://example.com/path', policy);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('url');
  });

  it('detects a www URL', () => {
    const findings = runPiiDetection('Go to www.example.com', policy);
    expect(findings.length).toBeGreaterThan(0);
  });
});

// ── national ID detection ─────────────────────────────────────────────────────

describe('runPiiDetection — nationalId (SSN)', () => {
  const policy = makePolicy({ nationalId: true });

  it('detects SSN format NNN-NN-NNNN', () => {
    const findings = runPiiDetection('SSN: 123-45-6789', policy);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('nationalId');
  });
});

// ── multiple categories simultaneously ───────────────────────────────────────

describe('runPiiDetection — multiple categories', () => {
  it('detects both email and IP in same text', () => {
    const policy = makePolicy({ email: true, ipAddress: true });
    const text = 'admin@corp.com accessed from 10.0.0.1';
    const findings = runPiiDetection(text, policy);
    const categories = findings.map((f) => f.category);
    expect(categories).toContain('email');
    expect(categories).toContain('ipAddress');
  });

  it('only scans enabled categories', () => {
    const policy = makePolicy({ email: false, ipAddress: true });
    const text = 'admin@corp.com at 10.0.0.1';
    const findings = runPiiDetection(text, policy);
    const categories = findings.map((f) => f.category);
    expect(categories).not.toContain('email');
    expect(categories).toContain('ipAddress');
  });

  it('handles empty text gracefully', () => {
    const findings = runPiiDetection('', ALL_ENABLED);
    expect(findings).toHaveLength(0);
  });

  it('handles text with no PII when all categories enabled', () => {
    const findings = runPiiDetection('The quick brown fox jumps over the lazy dog', ALL_ENABLED);
    expect(findings).toHaveLength(0);
  });
});

// ── finding structure ─────────────────────────────────────────────────────────

describe('runPiiDetection — finding structure', () => {
  it('each finding has required fields', () => {
    const findings = runPiiDetection('hello@world.com', makePolicy({ email: true }));
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.type).toBe('pii');
    expect(typeof f.category).toBe('string');
    expect(typeof f.severity).toBe('string');
    expect(typeof f.message).toBe('string');
    expect(typeof f.action).toBe('string');
    expect(typeof f.block).toBe('boolean');
    expect(typeof f.value).toBe('string');
  });
});
