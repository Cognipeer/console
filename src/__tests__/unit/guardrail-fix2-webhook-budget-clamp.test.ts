/**
 * Review findings #10 and #14 (the `clampText` half) on the webhook family.
 *
 *  #10 An attempt that NEVER DIALLED because the local remaining budget was
 *      under `MIN_ATTEMPT_MS` was recorded as a circuit-breaker failure. Five
 *      budget-starved requests then opened the breaker for a healthy endpoint,
 *      and under `failMode: 'closed'` every request in the tenant was blocked
 *      with `webhook_circuit_open`. It is now reported as an expired budget
 *      and never touches the breaker.
 *  #14 `clampText` deliberately kept `\r` and `\n`. A remote `code` flows into
 *      `verdict.codes` and from there into a response header (Node refuses CR/
 *      LF with ERR_INVALID_CHAR), and `category` is interpolated into the
 *      end-user block message. Both are now control-stripped; `code` is
 *      narrowed to a token charset.
 *
 * `safeFetch` is mocked: the properties under test are what the family does
 * BEFORE dialling and what it does with the body AFTER, not the socket.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookScope } from '@/lib/services/guardrail/hooks/contract';
import { GUARDRAIL_CONTRACT_VERSION } from '@/lib/services/guardrail/hooks/contract';

const hoisted = vi.hoisted(() => ({
  safeFetch: vi.fn(),
}));

vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));

import {
  resetWebhookCircuits,
  runWebhookPolicy,
  WEBHOOK_CODES,
} from '@/lib/services/guardrail/families/webhook';

/** ONE url for the whole file: the breaker is keyed by (tenant, url), and the
 *  point of the #10 cases is what five calls do to that one breaker. */
const URL_UNDER_TEST = 'https://verdict.example.test/hook';

function scopeWith(budgetMs?: number): HookScope {
  return {
    tenantId: 'tenant-a',
    tenantDbName: 't_tenant_a',
    actor: { id: 'u1', kind: 'user', roles: ['developer'] },
    surface: 'api',
    source: 'unit-test',
    traceId: 'trace-webhook-budget',
    budgetMs,
  };
}

function call(input: { scopeBudgetMs?: number; policyBudgetMs?: number; failMode?: 'open' | 'closed' } = {}) {
  const text = 'subject text';
  return runWebhookPolicy({
    policy: {
      id: 'wh',
      family: 'webhook',
      enabled: true,
      hooks: ['input.pre'],
      schedule: { timing: 'sync', onFail: 'block' },
      url: URL_UNDER_TEST,
      send: 'text',
      retries: 0,
      budgetMs: input.policyBudgetMs ?? 5_000,
    },
    subject: { kind: 'text', text, segments: [{ path: '/text', text }] },
    hook: 'input.pre',
    scope: scopeWith(input.scopeBudgetMs),
    action: 'block',
    failMode: input.failMode ?? 'closed',
    guardrailKey: 'budgeted',
  } as unknown as Parameters<typeof runWebhookPolicy>[0]);
}

/** A 200 carrying `body`. `headers.get` exists because `readCappedText`
 *  consults `content-length` before reading. */
function okResponse(body: unknown): unknown {
  return {
    status: 200,
    body: null,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWebhookCircuits();
});

// ═══════════════════════════════════════════════════════════════════════════
// #10
// ═══════════════════════════════════════════════════════════════════════════

describe('a webhook policy handed less budget than one attempt needs', () => {
  it('reports budget-expired, never dials, and does NOT count against the breaker', async () => {
    hoisted.safeFetch.mockResolvedValue(okResponse({ contractVersion: GUARDRAIL_CONTRACT_VERSION, decision: 'allow', findings: [] }));

    // Five requests where the engine's REMAINING budget (scope.budgetMs) is
    // under MIN_ATTEMPT_MS — the default breaker threshold.
    for (let i = 0; i < 5; i += 1) {
      const result = await call({ scopeBudgetMs: 80 });
      expect(result.degraded?.[0]?.reason).toBe(WEBHOOK_CODES.budgetExpired);
      expect(result.findings[0]?.code).toBe(WEBHOOK_CODES.budgetExpired);
      expect(result.findings[0]?.message).toMatch(/evaluation budget/i);
      // Not reported as the endpoint's fault.
      expect(result.findings[0]?.code).not.toBe(WEBHOOK_CODES.timeout);
    }
    expect(hoisted.safeFetch).not.toHaveBeenCalled();

    // The sixth request, with a real budget, reaches a CLOSED breaker and the
    // healthy endpoint answers. Before the fix this was `webhook_circuit_open`.
    const healthy = await call({ scopeBudgetMs: 5_000 });
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
    expect(healthy.degraded).toBeUndefined();
    expect(healthy.findings).toEqual([]);
  });

  it('a POLICY budget under MIN_ATTEMPT_MS is the same story', async () => {
    const result = await call({ policyBudgetMs: 60 });
    expect(result.findings[0]?.code).toBe(WEBHOOK_CODES.budgetExpired);
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('fail-open still surfaces it as a non-blocking finding, so the outage is visible', async () => {
    const result = await call({ scopeBudgetMs: 80, failMode: 'open' });
    expect(result.findings[0]?.code).toBe(WEBHOOK_CODES.budgetExpired);
    expect(result.findings[0]?.block).toBe(false);
  });

  it('a request that DID dial and timed out still counts — the breaker is not disarmed', async () => {
    hoisted.safeFetch.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    for (let i = 0; i < 5; i += 1) {
      const result = await call({ policyBudgetMs: 150 });
      expect(result.findings[0]?.code).toBe(WEBHOOK_CODES.timeout);
    }
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(5);

    const tripped = await call({ policyBudgetMs: 5_000 });
    expect(tripped.findings[0]?.code).toBe(WEBHOOK_CODES.circuitOpen);
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #14 — clampText
// ═══════════════════════════════════════════════════════════════════════════

describe('remote code / category / message text is control-stripped before it is interpolated', () => {
  it('drops CR/LF and other control characters; narrows `code` to a token', async () => {
    hoisted.safeFetch.mockResolvedValue(
      okResponse({
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        decision: 'flag',
        findings: [
          {
            category: 'Hate\r\nSpeech',
            severity: 'high',
            message: 'line one\r\nline two\x1b[31m\ttabbed\x00',
            code: 'bad\r\ncode: x/y',
            value: 'v\r\nalue',
          },
        ],
      }),
    );

    const result = await call();
    expect(result.degraded).toBeUndefined();
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];

    // No CR, LF, ESC, NUL or other control anywhere in what reaches a log
    // line, the block message or a response header.
    for (const field of [finding.code, finding.category, finding.message, finding.value]) {
      expect(field).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    }
    // Line breaks collapse to a space so a message stays readable.
    expect(finding.category).toBe('Hate Speech');
    expect(finding.message).toBe('line one line two[31m tabbed');
    // `code` is a machine token: header-safe and grep-able.
    expect(finding.code).toBe('badcode:x/y'.replace('/', ''));
    expect(finding.code).toMatch(/^[A-Za-z0-9_.:-]+$/);
  });

  it('a code that is NOTHING but control characters is dropped rather than emitted empty', async () => {
    hoisted.safeFetch.mockResolvedValue(
      okResponse({
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        decision: 'flag',
        findings: [{ category: 'x', severity: 'low', message: 'm', code: '\r\n\r\n' }],
      }),
    );
    const result = await call();
    expect(result.findings[0]?.code).toBeUndefined();
  });
});
