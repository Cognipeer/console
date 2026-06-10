import { describe, expect, it, vi, beforeEach } from 'vitest';

const db = {
  switchToTenant: vi.fn().mockResolvedValue(undefined),
  findGuardrailByKey: vi.fn(),
  listGuardrails: vi.fn(),
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => db),
}));

const evaluateGuardrail = vi.fn();
vi.mock('@/lib/services/guardrail/guardrailService', () => ({
  evaluateGuardrail: (...args: unknown[]) => evaluateGuardrail(...args),
}));

import {
  ModerationRequestError,
  normalizeModerationInput,
  resolveModerationGuardrailKey,
  runModeration,
} from '@/lib/services/guardrail/moderationApi';

const ctx = { tenantDbName: 'tenant_t1', tenantId: 't1', projectId: 'p1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('normalizeModerationInput', () => {
  it('accepts a string, string[], and text content parts', () => {
    expect(normalizeModerationInput('hi')).toEqual(['hi']);
    expect(normalizeModerationInput(['a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeModerationInput([{ type: 'text', text: 'c' }])).toEqual(['c']);
  });

  it('rejects image parts and non-string inputs', () => {
    expect(() => normalizeModerationInput([{ type: 'image_url', image_url: {} }]))
      .toThrowError(ModerationRequestError);
    expect(() => normalizeModerationInput(42)).toThrowError(ModerationRequestError);
  });
});

describe('resolveModerationGuardrailKey', () => {
  it('returns the explicit key when the guardrail exists', async () => {
    db.findGuardrailByKey.mockResolvedValue({ key: 'mod-policy' });
    await expect(resolveModerationGuardrailKey(ctx, 'mod-policy')).resolves.toBe('mod-policy');
  });

  it('throws when the explicit key does not exist', async () => {
    db.findGuardrailByKey.mockResolvedValue(null);
    await expect(resolveModerationGuardrailKey(ctx, 'nope')).rejects.toThrowError(/not found/);
  });

  it('falls back to the first enabled guardrail with moderation active', async () => {
    db.listGuardrails.mockResolvedValue([
      { key: 'pii-only', type: 'preset', policy: { moderation: { enabled: false } } },
      { key: 'custom', type: 'custom' },
      { key: 'mod-default', type: 'preset', policy: { moderation: { enabled: true } } },
    ]);
    await expect(resolveModerationGuardrailKey(ctx)).resolves.toBe('mod-default');
  });

  it('throws a setup hint when no moderation guardrail exists', async () => {
    db.listGuardrails.mockResolvedValue([]);
    await expect(resolveModerationGuardrailKey(ctx)).rejects.toThrowError(/No moderation guardrail/);
  });
});

describe('runModeration', () => {
  it('maps findings into OpenAI-style categories and scores', async () => {
    db.findGuardrailByKey.mockResolvedValue({ key: 'mod' });
    evaluateGuardrail.mockResolvedValue({
      passed: false,
      guardrailKey: 'mod',
      guardrailName: 'Moderation',
      action: 'block',
      findings: [
        { type: 'moderation', category: 'hate', severity: 'high', message: 'x', action: 'block', block: true },
        { type: 'pii', category: 'email', severity: 'low', message: 'y', action: 'mask', block: false },
      ],
    });

    const res = await runModeration(ctx, { input: 'bad text', model: 'mod' });
    expect(res.model).toBe('mod');
    expect(res.results).toHaveLength(1);
    const result = res.results[0];
    expect(result.flagged).toBe(true);
    expect(result.categories.hate).toBe(true);
    expect(result.categoryScores.hate).toBe(0.9);
    expect(result.categories.violence).toBe(false);
    // PII finding flags the input but lives in findings, not the category map
    expect(result.findings).toHaveLength(2);
    expect(result.categories.email).toBeUndefined();
  });

  it('evaluates each input separately', async () => {
    db.findGuardrailByKey.mockResolvedValue({ key: 'mod' });
    evaluateGuardrail
      .mockResolvedValueOnce({ findings: [] })
      .mockResolvedValueOnce({
        findings: [
          { type: 'moderation', category: 'violence', severity: 'medium', message: 'z', action: 'block', block: true },
        ],
      });

    const res = await runModeration(ctx, { input: ['ok', 'bad'], model: 'mod' });
    expect(res.results[0].flagged).toBe(false);
    expect(res.results[1].flagged).toBe(true);
    expect(res.results[1].categoryScores.violence).toBe(0.6);
    expect(evaluateGuardrail).toHaveBeenCalledTimes(2);
  });

  it('rejects empty input arrays', async () => {
    await expect(runModeration(ctx, { input: [] })).rejects.toThrowError(/must not be empty/);
  });
});
