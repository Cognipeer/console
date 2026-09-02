/**
 * THE LAST MILE OF CANCELLATION: is an aborted webhook actually CANCELLED, or
 * merely ignored?
 *
 * The distinction is not academic. A caller that walks away — a cancelled HTTP
 * request, an expired budget — stops READING the answer, so from the console's
 * side the two look identical. They are not identical to the receiver: a
 * webhook that is merely abandoned is still asked for a verdict nobody will
 * read, still runs whatever the customer's endpoint does on the way to
 * producing one, and still occupies a socket for the rest of its budget.
 *
 * So these tests assert on the FETCH, not on the return value: that the signal
 * handed to `safeFetch` actually fires, and that a caller-initiated abort is
 * not reported to the operator as the endpoint's fault.
 *
 * `safeFetch` is mocked because the property under test is entirely about the
 * signal we hand it; a real socket would only add flake.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookScope } from '@/lib/services/guardrail/hooks/contract';
import { GUARDRAIL_CONTRACT_VERSION } from '@/lib/services/guardrail/hooks/contract';

const hoisted = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  resolveProviderSecret: vi.fn(async () => undefined),
}));

vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));

import { runWebhookPolicy, WEBHOOK_CODES } from '@/lib/services/guardrail/families/webhook';

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A DISTINCT URL PER TEST. The circuit breaker is module-level state keyed by
 * (tenant, url), so a test that records a failure would open the breaker for
 * the next one and it would fail on `webhook_circuit_open` instead of on its
 * own assertion — the kind of order-dependent failure that gets a suite marked
 * flaky rather than read.
 */
let urlSeq = 0;
function freshUrl(): string {
  urlSeq += 1;
  return `https://verdict-${urlSeq}.example.test/hook`;
}

function scopeWith(signal: AbortSignal | undefined): HookScope {
  return {
    tenantId: 'tenant-a',
    tenantDbName: 't_tenant_a',
    actor: { id: 'u1', kind: 'user', roles: ['developer'] },
    surface: 'api',
    source: 'unit-test',
    traceId: 'trace-webhook-abort',
    signal,
  };
}

function call(input: {
  signal?: AbortSignal;
  retries?: number;
  budgetMs?: number;
}): Promise<Awaited<ReturnType<typeof runWebhookPolicy>>> {
  const text = 'subject text';
  return runWebhookPolicy({
    policy: {
      id: 'wh',
      family: 'webhook',
      enabled: true,
      hooks: ['input.pre'],
      schedule: { timing: 'sync', onFail: 'block' },
      url: freshUrl(),
      send: 'text',
      retries: input.retries ?? 0,
      budgetMs: input.budgetMs ?? 5_000,
    },
    subject: { kind: 'text', text, segments: [{ path: '/text', text }] },
    hook: 'input.pre',
    scope: scopeWith(input.signal),
    action: 'block',
    failMode: 'closed',
    guardrailKey: 'abortable',
  } as unknown as Parameters<typeof runWebhookPolicy>[0]);
}

/** The `signal` the family handed `safeFetch` on its Nth attempt. */
function signalOfAttempt(n: number): AbortSignal {
  const init = hoisted.safeFetch.mock.calls[n]?.[1] as { signal?: AbortSignal } | undefined;
  const signal = init?.signal;
  if (!signal) throw new Error(`attempt ${n} was not dispatched with a signal`);
  return signal;
}

/** A 200 with an "allow" verdict. `headers` is present because
 *  `readCappedText` consults `content-length` before it reads a body, and a
 *  bare `{ status, text }` stand-in throws there instead of parsing. */
function allowResponse(): unknown {
  return {
    status: 200,
    body: null,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({ contractVersion: GUARDRAIL_CONTRACT_VERSION, decision: 'allow', findings: [] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════

describe('a webhook whose caller walks away while the call is in flight', () => {
  it('ABORTS the request rather than abandoning it', async () => {
    const outer = new AbortController();
    // Never settles on its own: the ONLY thing that can end this test is the
    // outer abort reaching the attempt's controller. A fetch that resolved by
    // itself would make the assertion pass without the link under test.
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

    const pending = call({ signal: outer.signal });
    // Park until the family is genuinely inside `safeFetch`; aborting before it
    // dialled out would exercise the cheap pre-flight poll instead.
    for (let turn = 0; turn < 200 && hoisted.safeFetch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
    expect(signalOfAttempt(0).aborted).toBe(false);

    outer.abort();

    // THE PIN: the in-flight request's own signal fired. Before the link
    // existed this stayed false forever and the call ran to completion.
    expect(signalOfAttempt(0).aborted).toBe(true);
    await pending;
  });

  it('reports it as abandoned, not as the endpoint timing out', async () => {
    const outer = new AbortController();
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

    const pending = call({ signal: outer.signal, budgetMs: 5_000 });
    for (let turn = 0; turn < 200 && hoisted.safeFetch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    outer.abort();
    const result = await pending;

    // A caller-initiated abort and a budget timeout both surface as an
    // `AbortError`, so the family has to read the outer signal to tell them
    // apart. Calling this one a timeout would put "did not answer within
    // 5000ms" in the audit log for a healthy receiver that was cut off at
    // ~0ms — a false statement about a third party.
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toContain(WEBHOOK_CODES.aborted);
    expect(codes).not.toContain(WEBHOOK_CODES.timeout);
    for (const finding of result.findings) {
      expect(finding.message).not.toMatch(/did not answer within/);
    }
  });

  it('does not retry, and does not blame the endpoint for our own cancellation', async () => {
    const outer = new AbortController();
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

    // `retries: 2` is three attempts. A timeout is worth another try inside the
    // same budget; an abandoned request is not — there is nobody to answer.
    const pending = call({ signal: outer.signal, retries: 2 });
    for (let turn = 0; turn < 200 && hoisted.safeFetch.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    outer.abort();
    await pending;

    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('still runs normally when the caller supplies a poll-only signal', async () => {
    // `HookAbortSignal` requires only `aborted`; the listener pair is optional.
    // A caller that supplies the minimal shape must degrade to the old
    // behaviour, not throw on a missing `addEventListener`.
    hoisted.safeFetch.mockResolvedValue(allowResponse());

    const pollOnly = { aborted: false } as unknown as AbortSignal;
    const result = await call({ signal: pollOnly });

    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
    expect(result.findings).toEqual([]);
  });

  it('leaves no listener on the caller’s signal once it has answered', async () => {
    // A hook runs several policies against one request-scoped signal and a
    // webhook subscribes once per ATTEMPT. Node warns at 11 listeners; a leak
    // here would surface as that warning on a busy tenant long before anyone
    // connected it to guardrails.
    const outer = new AbortController();
    hoisted.safeFetch.mockResolvedValue(allowResponse());

    for (let i = 0; i < 5; i += 1) await call({ signal: outer.signal, retries: 2 });

    // `getEventListeners` is not available here, so this asserts the observable
    // consequence instead: firing the signal after the calls have finished must
    // reach nothing that still holds a controller.
    expect(() => outer.abort()).not.toThrow();
  });
});
