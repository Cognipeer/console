/**
 * Two hardenings of the hook-evaluation routes (`plugins/guardrails.ts`),
 * tested on the pure helpers the routes are built from:
 *
 *   1. `shadow` is GATED by the authenticated context. Shadow suppresses both
 *      the evaluation-log row and the usage event, so a client API token that
 *      could ask for it would evaluate for free and off the record by adding
 *      one body field. `readHookEvaluationOptions` therefore defaults to
 *      "not allowed" — the client route passes nothing — and only the
 *      dashboard route opts in, for admin sessions.
 *
 *   2. `x-cognipeer-guardrail-codes` is built from finding codes, and a
 *      webhook's `code` is REMOTE text. Node refuses a header value containing
 *      CR/LF (`ERR_INVALID_CHAR`), so one webhook answering `code: "x\r\n"`
 *      turned every hook response for that guardrail into a 500. Codes are now
 *      restricted to a token alphabet and capped before they reach the header.
 */

import { validateHeaderValue } from 'node:http';

import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

// Sync factory only: an async `vi.mock` factory does not intercept in this
// repo. The plugin's import graph reaches the database barrel, which constructs
// providers and registers shutdown handlers the moment it loads.
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));

import { VERDICT_HEADERS, allowVerdict } from '@/lib/services/guardrail/hooks/contract';
import type { HookVerdict } from '@/lib/services/guardrail/hooks/contract';
import {
  applyVerdictHeaders,
  canRequestShadowEvaluation,
  headerSafeCodes,
  readHookEvaluationOptions,
} from '@/server/api/plugins/guardrails';

// ═══════════════════════════════════════════════════════════════════════════

describe('readHookEvaluationOptions: shadow is gated by the caller, not the body', () => {
  it('forces shadow OFF by default — the client API token route passes no access', () => {
    const { options, error } = readHookEvaluationOptions({ shadow: true, request_id: 'r1' });
    expect(error).toBeUndefined();
    expect(options?.shadow).toBe(false);
    // The rest of the body is still honoured: the caller gets its verdict, on the record.
    expect(options?.requestId).toBe('r1');
  });

  it('honours shadow only when the route explicitly allows it', () => {
    expect(readHookEvaluationOptions({ shadow: true }, { allowShadow: true }).options?.shadow).toBe(true);
    expect(readHookEvaluationOptions({ shadow: true }, { allowShadow: false }).options?.shadow).toBe(false);
  });

  it('stays strict about the value even when allowed', () => {
    expect(readHookEvaluationOptions({ shadow: 'true' }, { allowShadow: true }).options?.shadow).toBe(false);
    expect(readHookEvaluationOptions({}, { allowShadow: true }).options?.shadow).toBe(false);
  });

  it('canRequestShadowEvaluation admits the admin roles only', () => {
    expect(canRequestShadowEvaluation({ role: 'owner' })).toBe(true);
    expect(canRequestShadowEvaluation({ role: 'admin' })).toBe(true);
    expect(canRequestShadowEvaluation({ role: 'project_admin' })).toBe(true);
    expect(canRequestShadowEvaluation({ role: 'user' })).toBe(false);
    expect(canRequestShadowEvaluation(undefined)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('headerSafeCodes: remote finding codes cannot break the response', () => {
  it('strips everything outside [A-Za-z0-9_.:-], drops empties and folds duplicates', () => {
    expect(headerSafeCodes(['ok_code', 'x\r\ny', '\r\n', 'ns:policy.v1-2', 'ok_code'])).toBe(
      'ok_code,xy,ns:policy.v1-2',
    );
  });

  it('caps each code at 64 characters and the header at a token boundary under 1024', () => {
    const single = headerSafeCodes(['a'.repeat(200)]);
    expect(single).toBe('a'.repeat(64));

    const many = headerSafeCodes(Array.from({ length: 40 }, (_, i) => `code-${i}-${'z'.repeat(50)}`));
    expect(many).toBeDefined();
    expect((many ?? '').length).toBeLessThanOrEqual(1024);
    // Cut between tokens, never inside one.
    for (const token of (many ?? '').split(',')) {
      expect(token).toMatch(/^code-\d+-z{50}$/);
    }
  });

  it('returns undefined when nothing survives, so no empty header is set', () => {
    expect(headerSafeCodes([])).toBeUndefined();
    expect(headerSafeCodes(['\r\n', '   ', '💥'])).toBeUndefined();
  });

  it('produces a value Node accepts as a header, where the raw join did not', () => {
    const raw = ['x\r\n', 'y'].join(',');
    expect(() => validateHeaderValue(VERDICT_HEADERS.codes, raw)).toThrow();
    const safe = headerSafeCodes(['x\r\n', 'y']);
    expect(safe).toBe('x,y');
    expect(() => validateHeaderValue(VERDICT_HEADERS.codes, safe ?? '')).not.toThrow();
  });
});

describe('applyVerdictHeaders', () => {
  const visibility = {
    headers: true,
    useVerdictStatusCodes: false,
    detailedHeaders: true,
    aegisCompatHeaders: false,
  };

  function replyDouble(): { reply: FastifyReply; headers: Map<string, string> } {
    const headers = new Map<string, string>();
    const reply = {
      header(name: string, value: string) {
        headers.set(name, value);
        return this;
      },
    } as unknown as FastifyReply;
    return { reply, headers };
  }

  it('sets the sanitised codes header and never an invalid one', () => {
    const verdict: HookVerdict = {
      ...allowVerdict({ hook: 'tool.pre', traceId: 'trace', latencyMs: 0, guardrailKeys: ['g'], guardrailKey: 'g' }),
      codes: ['webhook\r\nSet-Cookie: a=b', 'network.denied'],
    };
    const { reply, headers } = replyDouble();

    applyVerdictHeaders(reply, verdict, visibility);

    const value = headers.get(VERDICT_HEADERS.codes);
    // CR, LF, the space and the `=` are all outside the token alphabet.
    expect(value).toBe('webhookSet-Cookie:ab,network.denied');
    expect(() => validateHeaderValue(VERDICT_HEADERS.codes, value ?? '')).not.toThrow();
  });

  it('omits the codes header entirely when every code sanitises to nothing', () => {
    const verdict: HookVerdict = {
      ...allowVerdict({ hook: 'tool.pre', traceId: 'trace', latencyMs: 0, guardrailKeys: ['g'], guardrailKey: 'g' }),
      codes: ['\r\n'],
    };
    const { reply, headers } = replyDouble();

    applyVerdictHeaders(reply, verdict, visibility);

    expect(headers.has(VERDICT_HEADERS.codes)).toBe(false);
    expect(headers.get(VERDICT_HEADERS.risk)).toBe('0');
  });
});
