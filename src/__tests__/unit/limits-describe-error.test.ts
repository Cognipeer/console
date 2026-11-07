/**
 * Reading a plan-limit refusal on the client: every envelope the server sends, the Retry-After header,
 * unknown codes, and the key/value mapping into the `usageLimits` namespace (parity of the two languages included).
 */
import { describe, expect, it } from 'vitest';
import {
  PlanLimitError,
  PLAN_LIMIT_STATUS,
  planLimitAnthropicBody,
  planLimitErrorBody,
  planLimitOpenAiBody,
  type PlanLimitErrorCode,
} from '@/lib/limits/errors';
import {
  limitDimensionKey,
  limitMessageKey,
  limitMessageValues,
  limitTitleKey,
  parseLimitError,
} from '@/lib/limits/describeLimitError';
import { messages } from '@/lib/i18n/messages';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(full, value);
    else for (const [k, v] of flatten(value, full)) out.set(k, v);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

const CODES = Object.keys(PLAN_LIMIT_STATUS) as PlanLimitErrorCode[];

function refusal(code: PlanLimitErrorCode, extra: Partial<ConstructorParameters<typeof PlanLimitError>[0]> = {}) {
  return new PlanLimitError({
    code,
    message: 'refused',
    kind: 'concurrency',
    dimension: 'agent',
    limit: 7,
    used: 7,
    retryAfterMs: 2500,
    resetAt: new Date('2031-03-01T00:00:00.000Z'),
    ...extra,
  });
}

describe('parseLimitError', () => {
  it('reads the dashboard envelope', () => {
    const error = refusal('tenant_concurrency_limited');
    expect(parseLimitError(error.status, planLimitErrorBody(error))).toEqual({
      code: 'tenant_concurrency_limited',
      kind: 'concurrency',
      dimension: 'agent',
      limit: 7,
      used: 7,
      retryAfterMs: 2500,
      resetAt: '2031-03-01T00:00:00.000Z',
    });
  });

  it('reads the OpenAI envelope', () => {
    const error = refusal('monthly_allowance_exhausted', { dimension: 'searches' });
    expect(parseLimitError(error.status, planLimitOpenAiBody(error))).toMatchObject({
      code: 'monthly_allowance_exhausted',
      dimension: 'searches',
      limit: 7,
      resetAt: '2031-03-01T00:00:00.000Z',
    });
  });

  it('reads the Anthropic envelope', () => {
    const error = refusal('insufficient_credits');
    expect(parseLimitError(error.status, planLimitAnthropicBody(error))).toMatchObject({ code: 'insufficient_credits', used: 7 });
  });

  it('prefers the body retry time and falls back to the Retry-After header (seconds)', () => {
    const withBody = planLimitErrorBody(refusal('tenant_rate_limited'));
    expect(parseLimitError(429, withBody, '9')?.retryAfterMs).toBe(2500);
    const noBody = planLimitErrorBody(refusal('tenant_rate_limited', { retryAfterMs: undefined }));
    expect(parseLimitError(429, noBody, '9')?.retryAfterMs).toBe(9000);
    expect(parseLimitError(429, noBody, null)?.retryAfterMs).toBeUndefined();
    expect(parseLimitError(429, noBody, 'soon')?.retryAfterMs).toBeUndefined();
  });

  it('returns null for unknown codes and for bodies that are not refusals', () => {
    expect(parseLimitError(429, { error: 'x', code: 'provider_rate_limited' })).toBeNull();
    expect(parseLimitError(429, { error: { code: 'rate_limit_exceeded', message: 'x' } })).toBeNull();
    expect(parseLimitError(500, { error: 'boom' })).toBeNull();
    expect(parseLimitError(500, 'text')).toBeNull();
    expect(parseLimitError(500, null)).toBeNull();
    expect(parseLimitError(500, { code: 'toString' })).toBeNull();
  });
});

describe('message mapping', () => {
  const en = flatten((messages.en as unknown as Record<string, Tree>).usageLimits!);
  const tr = flatten((messages.tr as unknown as Record<string, Tree>).usageLimits!);

  it.each(CODES)('%s has a title and a message in both languages, and every key it can pick exists', (code) => {
    const full = { code, retryAfterMs: 1000, resetAt: '2031-03-01T00:00:00.000Z', dimension: 'agent', limit: 1, used: 1 };
    const bare = { code } as const;
    for (const info of [full, bare]) {
      for (const key of [limitMessageKey(info), limitTitleKey(info)]) {
        expect(en.has(key), `${key} (en)`).toBe(true);
        expect(tr.has(key), `${key} (tr)`).toBe(true);
      }
    }
  });

  it('picks the variant without a wait or a date when the hint is missing', () => {
    expect(limitMessageKey({ code: 'tenant_rate_limited' })).toBe('codes.tenant_rate_limited.messageNoWait');
    expect(limitMessageKey({ code: 'tenant_rate_limited', retryAfterMs: 1000 })).toBe('codes.tenant_rate_limited.message');
    expect(limitMessageKey({ code: 'monthly_allowance_exhausted' })).toBe('codes.monthly_allowance_exhausted.messageNoDate');
    expect(limitMessageKey({ code: 'monthly_allowance_exhausted', resetAt: 'not a date' })).toBe('codes.monthly_allowance_exhausted.messageNoDate');
    expect(limitMessageKey({ code: 'monthly_allowance_exhausted', resetAt: '2031-03-01T00:00:00.000Z' })).toBe('codes.monthly_allowance_exhausted.message');
    expect(limitMessageKey({ code: 'storage_quota_exceeded' })).toBe('codes.storage_quota_exceeded.message');
  });

  it('gives every placeholder a message uses a value when the refusal carries the details', () => {
    const info = parseLimitError(429, planLimitErrorBody(refusal('monthly_allowance_exhausted', { dimension: 'flowRuns' })))!;
    const values = limitMessageValues(info, { dimensionLabel: (key) => `label:${key}`, locale: 'en-US' });
    expect(values).toMatchObject({ limit: 7, used: 7, seconds: 3, dimension: 'label:dimensions.flowRuns' });
    expect(String(values.date)).toMatch(/2031/);
    for (const code of CODES) {
      const detailed = parseLimitError(400, planLimitErrorBody(refusal(code)))!;
      const given = Object.keys(limitMessageValues(detailed));
      for (const text of [en.get(limitMessageKey(detailed))!, tr.get(limitMessageKey(detailed))!]) {
        for (const name of placeholders(text)) expect(given, `${code} {${name}}`).toContain(name);
      }
    }
  });

  it('rounds seconds up and never below one; unknown dimensions use the generic label', () => {
    expect(limitMessageValues({ code: 'tenant_rate_limited', retryAfterMs: 100 }).seconds).toBe(1);
    expect(limitMessageValues({ code: 'tenant_rate_limited', retryAfterMs: 1001 }).seconds).toBe(2);
    expect(limitDimensionKey('agent')).toBe('dimensions.agent');
    expect(limitDimensionKey('whatever')).toBe('dimensions.unknown');
    expect(limitDimensionKey(undefined)).toBe('dimensions.unknown');
    for (const key of ['apiRpm', 'agent', 'flow', 'job', 'browser', 'realtime', 'sandbox', 'searches', 'flowRuns', 'crawlerPages', 'sandboxHours', 'sandboxSeconds']) {
      expect(en.has(limitDimensionKey(key)), key).toBe(true);
    }
  });
});

describe('usageLimits messages', () => {
  const en = flatten((messages.en as unknown as Record<string, Tree>).usageLimits!);
  const tr = flatten((messages.tr as unknown as Record<string, Tree>).usageLimits!);

  it('has the same keys and placeholders in both languages, no empty text', () => {
    expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, text] of en) {
      expect(text.trim(), key).not.toBe('');
      expect(placeholders(tr.get(key) ?? ''), key).toEqual(placeholders(text));
    }
  });

  it('is translated, formal in Turkish, and free of prices', () => {
    const hasWords = (text: string) => /\p{L}/u.test(text.replace(/\{\w+\}/g, ''));
    const same = [...en].filter(([key, text]) => tr.get(key) === text && hasWords(text) && !/^(API|sandbox)/i.test(text));
    expect(same.map(([key]) => key)).toEqual([]);
    const INFORMAL = /(?<![\p{L}])(sana|senin|seni|deneyebilirsin|yapabilirsin)(?![\p{L}])/iu;
    for (const [key, text] of tr) expect(text, key).not.toMatch(INFORMAL);
    for (const [key, text] of [...en, ...tr]) expect(text, key).not.toMatch(/[$€£]|\bUSD\b|\bEUR\b/);
  });
});
