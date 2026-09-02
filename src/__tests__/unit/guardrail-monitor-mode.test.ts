/**
 * Regression — MONITOR MODE MUST NOT ENFORCE.
 *
 * The console has two answers to "did this guardrail fire", and for a long time
 * the enforcement path read the wrong one:
 *
 *   · `passed`  — the COUNTERFACTUAL. "Was there a blocking finding." A
 *                 monitor-mode guardrail is supposed to keep reporting `false`
 *                 here; that is the entire value of monitoring.
 *   · `blocked` — the DECISION, already neutralised by the guardrail's Mode.
 *
 * `inferenceService` and `agentService` both threw on the first one, so a
 * guardrail set to Monitor still refused chat completions and still aborted
 * agent runs — while the Mode control in the UI promised the opposite. The
 * verification round that found this also found that NOTHING in the suite
 * asserted the promise, at any level. This file is that assertion.
 *
 * It deliberately drives the real `evaluateGuardrail` facade rather than
 * `runHook`: the leak was never in the engine (which has always neutralised
 * `decision` correctly) but in the seam between the engine and its callers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) =>
      fn(await getDatabase()),
  };
});

vi.mock('@/lib/services/guardrail/llmEvaluator', () => ({
  runModerationPolicy: vi.fn().mockResolvedValue([]),
  runPromptShieldPolicy: vi.fn().mockResolvedValue([]),
  runCustomPromptPolicy: vi.fn().mockResolvedValue([]),
}));

import { getDatabase } from '@/lib/database';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { createMockDb } from '../helpers/db.mock';
import { evaluateGuardrail } from '@/lib/services/guardrail/guardrailService';
import { resetRecordCaches } from '@/lib/services/guardrail/hooks/recordCache';
import type { IGuardrail } from '@/lib/database/provider.interface';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';

/** A guardrail whose PII policy blocks on email — the simplest live blocker. */
function blockingGuardrail(overrides: Partial<IGuardrail> = {}): IGuardrail {
  return {
    _id: 'grail-monitor',
    tenantId: TENANT_ID,
    projectId: 'proj-1',
    key: 'my-guardrail',
    name: 'My Guardrail',
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    createdBy: 'user-1',
    policy: {
      pii: { enabled: true, action: 'block', categories: { email: true } },
    },
    ...overrides,
  } as IGuardrail;
}

const LEAKY = 'contact me at leak@corp.com';

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  // The record cache is process-wide and would otherwise hand test N the
  // guardrail test N-1 stored — including its mode.
  resetRecordCaches();
  db = createMockDb();
  vi.mocked(getDatabase).mockResolvedValue(db as never);
});

async function evaluate(record: IGuardrail) {
  db.findGuardrailByKey.mockResolvedValue(record);
  const result = await evaluateGuardrail({
    tenantDbName: TENANT_DB,
    tenantId: TENANT_ID,
    guardrailKey: 'my-guardrail',
    text: LEAKY,
  });
  await drainPendingTasks();
  return result;
}

describe('monitor mode: findings still fire, nothing is enforced', () => {
  it('enforce mode blocks — the control case, so the monitor case means something', async () => {
    const result = await evaluate(blockingGuardrail({ mode: 'enforce' } as Partial<IGuardrail>));

    expect(result.findings.some((f) => f.block)).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.verdict?.decision).toBe('block');
  });

  it('monitor mode reports the SAME findings but blocks nothing', async () => {
    const result = await evaluate(blockingGuardrail({ mode: 'monitor' } as Partial<IGuardrail>));

    // The counterfactual is untouched: the operator can still see, in the log
    // and in the test panel, exactly what would have happened.
    expect(result.findings.some((f) => f.block)).toBe(true);
    expect(result.passed).toBe(false);

    // …and the decision every enforcement site reads is 'allow'.
    expect(result.blocked).toBe(false);
    expect(result.verdict?.decision).toBe('allow');
  });

  it('monitor mode does not rewrite the content either', async () => {
    const result = await evaluate(
      blockingGuardrail({
        mode: 'monitor',
        policy: { pii: { enabled: true, action: 'redact', categories: { email: true } } },
      } as Partial<IGuardrail>),
    );

    // A monitor-mode guardrail that silently masked the text would be enforcing
    // in the only way that actually reaches the user.
    expect(result.redactedText).toBeUndefined();
    expect(result.blocked).toBe(false);
  });

  it('a disabled guardrail reports blocked:false, not undefined', async () => {
    const result = await evaluate(
      blockingGuardrail({ enabled: false, mode: 'disabled' } as Partial<IGuardrail>),
    );

    expect(result.disabled).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.passed).toBe(true);
  });

  it('a legacy record with no mode column still enforces', async () => {
    // `toGuardrailMode(undefined, true)` is 'enforce'. Every guardrail written
    // before the Mode control exists is in this shape, and none of them may
    // silently stop enforcing because a column was added.
    const legacy = blockingGuardrail();
    delete (legacy as unknown as Record<string, unknown>).mode;
    const result = await evaluate(legacy);

    expect(result.blocked).toBe(true);
  });

  it("mode 'simulate' is an alias for monitor, not an unknown that falls through to enforce", async () => {
    const result = await evaluate(blockingGuardrail({ mode: 'simulate' } as unknown as Partial<IGuardrail>));

    expect(result.findings.some((f) => f.block)).toBe(true);
    expect(result.blocked).toBe(false);
  });
});
