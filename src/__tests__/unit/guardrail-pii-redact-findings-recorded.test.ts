/**
 * REGRESSION: a PII-redact guardrail looked like it detected nothing.
 *
 * Observed on a demo tenant: the preset "Customer PII Redaction" (legacy
 * `policy.pii`, action redact, mode enforce, hooksVersion 0 — so the engine
 * lifts it into a `pii-migrated-<key>` PII policy) showed 6 evaluations, 100%
 * passed and "No findings recorded", although a user turn carried an email and
 * an international phone number.
 *
 * Detection was never the problem, and this file pins that it is not: the
 * engine redacts both values and logs the evaluation WITH its findings. The log
 * row is `passed: true` on purpose — `passed` means "no blocking finding"
 * (engine.ts `logHookEvaluation`), and a redaction is not a block. The defect
 * was downstream: both providers' `aggregateGuardrailEvaluations` tallied
 * findings only from `passed = false` rows, so every redact/warn finding was
 * dropped from findingsByType/findingsBySeverity. That half is pinned against
 * both real providers in `integration/db-parity.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IGuardrail, IPiiPolicy } from '@/lib/database/provider/types.domain';

const hoisted = vi.hoisted(() => ({
  findGuardrailByKey: vi.fn(),
  findPiiPolicyByKey: vi.fn(),
  createPiiPolicy: vi.fn(),
  createGuardrailEvaluationLog: vi.fn(),
  createGuardrail: vi.fn(),
}));

const fakeDb = {
  findGuardrailByKey: hoisted.findGuardrailByKey,
  findPiiPolicyByKey: hoisted.findPiiPolicyByKey,
  createPiiPolicy: hoisted.createPiiPolicy,
  createGuardrailEvaluationLog: hoisted.createGuardrailEvaluationLog,
  createGuardrail: hoisted.createGuardrail,
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => fakeDb),
  getTenantDatabase: vi.fn(async () => fakeDb),
  runWithTenantScope: vi.fn(
    async (_tenantDbName: string, fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
  ),
}));

vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn(() => ({})),
  resolveUsageAttribution: vi.fn(() => ({})),
}));

import type { HookScope } from '@/lib/services/guardrail/hooks/contract';
import { runHook } from '@/lib/services/guardrail/hooks/engine';
import { invalidateLiftedPiiPolicyCache } from '@/lib/services/guardrail/hooks/legacy';
import { resetRecordCaches } from '@/lib/services/guardrail/hooks/recordCache';

const EMAIL = 'jane.doe@acme-retail.example';
const PHONE = '+44 7700 900123';
const USER_TURN = `Do I need to tell my manager first or HR? My email is ${EMAIL} and phone ${PHONE}.`;

const scope: HookScope = {
  tenantId: 'tenant-demo',
  tenantDbName: 't_tenant_demo',
  actor: { id: 'u1', kind: 'user', roles: ['developer'] },
  surface: 'agent',
  source: 'agent-playground',
  traceId: 'trace-pii-redact',
};

/** The demo row exactly as persisted (preset, legacy blob, never authored). */
function customerPiiRedaction(): IGuardrail {
  return {
    _id: '6c34bcf2-1c73-4fe8-99ef-13c7dba046bb',
    tenantId: 'tenant-demo',
    key: 'customer-pii-redaction',
    name: 'Customer PII Redaction',
    type: 'preset',
    target: 'input',
    action: 'redact',
    enabled: true,
    mode: 'enforce',
    failMode: 'open',
    modelKey: null,
    customPrompt: null,
    metadata: {},
    hooksVersion: 0,
    createdBy: 'user-1',
    policy: {
      pii: {
        enabled: true,
        action: 'redact',
        categories: { email: true, phone: true, creditCard: true, iban: true },
      },
    },
  } as unknown as IGuardrail;
}

beforeEach(() => {
  resetRecordCaches();
  invalidateLiftedPiiPolicyCache();
  vi.clearAllMocks();
  hoisted.findGuardrailByKey.mockResolvedValue(customerPiiRedaction());
  hoisted.findPiiPolicyByKey.mockResolvedValue(null);
  hoisted.createPiiPolicy.mockImplementation(
    async (input: Partial<IPiiPolicy>) => ({ ...input, _id: 'pii-migrated' }) as IPiiPolicy,
  );
  hoisted.createGuardrailEvaluationLog.mockResolvedValue(undefined);
});

afterEach(() => {
  resetRecordCaches();
});

describe('Customer PII Redaction preset on input.pre', () => {
  it('detects and redacts the email and the +44 phone, and logs the findings', async () => {
    const verdict = await runHook({
      contractVersion: 2,
      hook: 'input.pre',
      subject: { kind: 'text', text: USER_TURN, segments: [{ text: USER_TURN, path: '/text', offset: 0 }] },
      scope,
      guardrailKeys: ['customer-pii-redaction'],
    });

    expect(verdict.decision).toBe('redact');
    const categories = verdict.findings.map((f) => f.category).sort();
    expect(categories).toEqual(['email', 'phone']);
    expect(verdict.findings.every((f) => f.block !== true)).toBe(true);

    const rewritten = verdict.subject && 'text' in verdict.subject ? verdict.subject.text : '';
    expect(rewritten).not.toContain(EMAIL);
    expect(rewritten).not.toContain(PHONE);

    await vi.waitFor(() => expect(hoisted.createGuardrailEvaluationLog).toHaveBeenCalledTimes(1));
    const log = hoisted.createGuardrailEvaluationLog.mock.calls[0][0] as {
      passed: boolean;
      decision: string;
      findings: Array<{ category: string }>;
      inputText: string;
    };
    // passed=true is the documented semantics (no BLOCKING finding) — which is
    // exactly why the aggregate must not read findings only from failed rows.
    expect(log.passed).toBe(true);
    expect(log.decision).toBe('redact');
    expect(log.findings.map((f) => f.category).sort()).toEqual(['email', 'phone']);
    expect(log.inputText).not.toContain(EMAIL);
    expect(log.inputText).not.toContain(PHONE);
  });
});
