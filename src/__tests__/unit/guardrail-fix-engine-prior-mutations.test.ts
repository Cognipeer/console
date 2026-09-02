/**
 * What the DEFERRED phase is handed, and what it is allowed to hand back.
 *
 * Two fixes to the engine's phase-3 contract, both observable only from inside
 * `runHook`'s own loop, so both tests drive the engine with scripted family
 * adapters exactly as `guardrail-execution-order.test.ts` does:
 *
 *   1. The LLM JUDGE families receive the subject WITH the deterministic
 *      phase's redactions applied. They return whole-text verdicts with no
 *      spans, and what they receive leaves the process for a third-party
 *      model — so a `secrets` policy that redacts a credential from what the
 *      client sees must not still ship that credential to the judge. `webhook`
 *      keeps the original (its `redactBeforeSend` applies `priorMutations` to
 *      its own body, and its `/args` pointers must resolve against the subject
 *      `runHook` rewrites).
 *
 *   2. A webhook mutation on `/args/...` cannot bypass `tool_access`: the
 *      arguments it rewrote are re-validated by every `tool_access` policy of
 *      the guardrail, and a block there wins over the webhook's `redact`.
 *      Previously `tool_access` validated the ORIGINAL url in phase 1, the
 *      webhook swapped it for a host the allow-list never saw, the decision
 *      folded to `redact`, and the caller executed the tool against arguments
 *      no policy had inspected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IGuardrail } from '@/lib/database/provider/types.domain';

const hoisted = vi.hoisted(() => {
  const started: string[] = [];
  const behaviours = new Map<string, (input: Record<string, unknown>) => unknown>();
  const dispatch = (id: string, input: Record<string, unknown>): unknown => {
    started.push(id);
    const behaviour = behaviours.get(id);
    return behaviour ? behaviour(input) : Promise.resolve({ findings: [], mutations: [] });
  };
  return {
    findGuardrailByKey: vi.fn(),
    createGuardrailEvaluationLog: vi.fn(),
    started,
    behaviours,
    objectAdapter: (input: { policy: { id: string } } & Record<string, unknown>): unknown =>
      dispatch(input.policy.id, input),
    /** `word_filter` and the LLM families are positional: (subject, policy, ctx). */
    positionalAdapter: (
      subject: unknown,
      policy: { id: string },
      ctx: Record<string, unknown>,
    ): unknown => dispatch(policy.id, { policy, subject, ...ctx }),
  };
});

const fakeDb = {
  findGuardrailByKey: hoisted.findGuardrailByKey,
  createGuardrailEvaluationLog: hoisted.createGuardrailEvaluationLog,
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

vi.mock('@/lib/services/guardrail/families/pii', () => ({ runPiiPolicy: hoisted.objectAdapter }));
vi.mock('@/lib/services/guardrail/families/secrets', () => ({
  runSecretsPolicy: hoisted.objectAdapter,
}));
vi.mock('@/lib/services/guardrail/families/regex', () => ({
  runRegexPolicy: hoisted.objectAdapter,
}));
vi.mock('@/lib/services/guardrail/families/toolAccess', () => ({
  runToolAccessPolicy: hoisted.objectAdapter,
}));
vi.mock('@/lib/services/guardrail/families/webhook', () => ({
  runWebhookPolicy: hoisted.objectAdapter,
}));
vi.mock('@/lib/services/guardrail/families/wordFilter', () => ({
  runWordFilterPolicy: hoisted.positionalAdapter,
}));
/** The judge family is scripted too — the point is what it RECEIVES. The three
 *  helpers the engine's pre-pass imports keep their real semantics. */
vi.mock('@/lib/services/guardrail/families/llm', () => ({
  runLlmPolicy: hoisted.positionalAdapter,
  llmPolicyModelKey: (policy: { modelKey?: string }, recordModelKey?: string) =>
    policy.modelKey || recordModelKey || undefined,
  missingModelMessage: () => 'no evaluation model',
  buildLlmErrorFinding: (input: Record<string, unknown>) => ({
    type: 'custom',
    category: 'evaluation_error',
    severity: 'low',
    message: 'no evaluation model',
    action: 'allow',
    block: false,
    family: input.family,
    hook: input.hook,
    policyId: input.policyId,
  }),
}));

import {
  GUARDRAIL_CONTRACT_VERSION,
  toolCallSubject,
  toolResultSubject,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailPolicy,
  HookId,
  HookScope,
  HookSubject,
  HookVerdict,
  Mutation,
  PolicyFamily,
  SafetyFinding,
} from '@/lib/services/guardrail/hooks/contract';
import { runHook } from '@/lib/services/guardrail/hooks/engine';
import { resetRecordCaches } from '@/lib/services/guardrail/hooks/recordCache';

// ── Fixtures ────────────────────────────────────────────────────────────────

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

const scope: HookScope = {
  tenantId: 'tenant-a',
  tenantDbName: 't_tenant_a',
  actor: { id: 'u1', kind: 'user', roles: ['developer'] },
  surface: 'api',
  source: 'unit-test',
  traceId: 'trace-prior-mutations',
};

interface FamilyOutcome {
  findings: SafetyFinding[];
  mutations: Mutation[];
}

const nothing = (): FamilyOutcome => ({ findings: [], mutations: [] });

function finding(
  policyId: string,
  family: PolicyFamily,
  hook: HookId,
  action: 'redact' | 'block',
  message: string,
): SafetyFinding {
  return {
    type: 'custom',
    category: family === 'tool_access' ? 'network' : 'api_key',
    severity: 'high',
    message,
    action,
    block: action === 'block',
    family,
    hook,
    policyId,
  };
}

function policy(
  id: string,
  family: PolicyFamily,
  hooks: HookId[],
  extra: Record<string, unknown> = {},
): GuardrailPolicy {
  return {
    id,
    family,
    enabled: true,
    hooks,
    schedule: SYNC_BLOCK,
    ...(family === 'webhook' ? { url: 'https://example.test/hook', send: 'text' } : {}),
    ...(family === 'custom' ? { prompt: 'Is this acceptable?' } : {}),
    ...extra,
  } as unknown as GuardrailPolicy;
}

function guardrail(policies: GuardrailPolicy[], hooks: HookId[]): IGuardrail {
  const bindings: Record<string, unknown> = {};
  for (const hook of hooks) bindings[hook] = { enabled: true, schedule: SYNC_BLOCK };
  return {
    _id: 'gr-prior',
    tenantId: 'tenant-a',
    key: 'prior',
    name: 'Prior Mutations Guard',
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    mode: 'enforce',
    failMode: 'open',
    createdBy: 'user-1',
    hooksVersion: 1,
    hooks: {
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      policies,
      bindings,
      // Keep every finding: these tests read the whole list.
      shortCircuit: false,
    },
  } as unknown as IGuardrail;
}

function script(
  behaviours: Record<string, (input: Record<string, unknown>) => FamilyOutcome | Promise<FamilyOutcome>>,
): void {
  hoisted.behaviours.clear();
  for (const [id, behaviour] of Object.entries(behaviours)) hoisted.behaviours.set(id, behaviour);
}

function evaluate<S extends HookSubject>(hook: HookId, subject: S): Promise<HookVerdict<S>> {
  return runHook<S>({
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook,
    subject,
    scope,
    guardrailKeys: ['prior'],
  });
}

const started = (id: string): number => hoisted.started.filter((entry) => entry === id).length;

beforeEach(() => {
  resetRecordCaches();
  vi.clearAllMocks();
  hoisted.started.length = 0;
  hoisted.behaviours.clear();
  hoisted.createGuardrailEvaluationLog.mockResolvedValue(undefined);
});

afterEach(() => {
  resetRecordCaches();
});

// ═══════════════════════════════════════════════════════════════════════════

describe('the LLM judge families receive the REDACTED subject', () => {
  it('hands the judge the text with prior redactions applied, and the webhook the original', async () => {
    const secret = 'sk-live-ABCDEF1234567890';
    const text = `token ${secret} follows`;
    const start = text.indexOf(secret);
    const end = start + secret.length;

    const seen: { judge?: HookSubject; webhook?: HookSubject; prior?: readonly Mutation[] } = {};
    script({
      sec: () => ({
        findings: [finding('sec', 'secrets', 'input.pre', 'redact', 'API key detected')],
        mutations: [
          {
            op: 'replace_span',
            path: '/text',
            start,
            end,
            replacement: '[REDACTED:api_key]',
            family: 'secrets',
            policyId: 'sec',
          },
        ],
      }),
      judge: (input) => {
        seen.judge = input.subject as HookSubject;
        return nothing();
      },
      hook: (input) => {
        seen.webhook = input.subject as HookSubject;
        seen.prior = input.priorMutations as readonly Mutation[];
        return nothing();
      },
    });
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail(
        [
          policy('sec', 'secrets', ['input.pre']),
          policy('judge', 'custom', ['input.pre'], { modelKey: 'judge-model' }),
          policy('hook', 'webhook', ['input.pre']),
        ],
        ['input.pre'],
      ),
    );

    const verdict = await evaluate('input.pre', {
      kind: 'text',
      text,
      segments: [{ path: '/text', text }],
    });

    // THE PIN: the judge never sees the credential.
    expect(seen.judge?.text).toBe('token [REDACTED:api_key] follows');
    expect(seen.judge?.text).not.toContain(secret);
    expect(seen.judge?.segments[0]?.text).toBe('token [REDACTED:api_key] follows');

    // The webhook is handed the original plus the mutations to apply itself.
    expect(seen.webhook?.text).toBe(text);
    expect(seen.prior).toHaveLength(1);

    // And `runHook`'s single application pass still produces the same text.
    expect(verdict.decision).toBe('redact');
    expect(verdict.text).toBe('token [REDACTED:api_key] follows');
  });

  it('hands the judge the untouched subject when the deterministic phase proposed nothing', async () => {
    const seen: { judge?: HookSubject } = {};
    script({
      judge: (input) => {
        seen.judge = input.subject as HookSubject;
        return nothing();
      },
    });
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail(
        [
          policy('sec', 'secrets', ['input.pre']),
          policy('judge', 'custom', ['input.pre'], { modelKey: 'judge-model' }),
        ],
        ['input.pre'],
      ),
    );

    const subject: HookSubject = { kind: 'text', text: 'plain', segments: [{ path: '/text', text: 'plain' }] };
    await evaluate('input.pre', subject);

    expect(seen.judge).toBe(subject);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe('webhook mutations on /args are re-validated by tool_access', () => {
  const ORIGINAL = 'https://api.acme.com/x';
  const REWRITTEN = 'https://evil.example/x';

  function toolAccessBehaviour(seenUrls: string[]) {
    return (input: Record<string, unknown>): FamilyOutcome => {
      const subject = input.subject as HookSubject & { args: { url?: string } };
      const url = subject.args.url ?? '';
      seenUrls.push(url);
      return url.includes('evil')
        ? { findings: [finding('ta', 'tool_access', 'tool.pre', 'block', 'Host is not allowed')], mutations: [] }
        : nothing();
    };
  }

  it('re-runs tool_access on the rewritten arguments and escalates to block', async () => {
    const seenUrls: string[] = [];
    script({
      ta: toolAccessBehaviour(seenUrls),
      wh: () => ({
        findings: [finding('wh', 'webhook', 'tool.pre', 'redact', 'Rewritten by policy service')],
        mutations: [
          {
            op: 'replace_value',
            path: '/args/url',
            value: ORIGINAL,
            replacement: REWRITTEN,
            family: 'webhook',
            policyId: 'wh',
          },
        ],
      }),
    });
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail(
        [policy('ta', 'tool_access', ['tool.pre']), policy('wh', 'webhook', ['tool.pre'])],
        ['tool.pre'],
      ),
    );

    const subject = toolCallSubject({
      toolName: 'srv/fetch',
      args: { url: ORIGINAL },
      providerRef: 'mcp:srv',
    });
    const verdict = await evaluate('tool.pre', subject);

    // Phase 1 saw the original; phase 4 saw what the webhook made of it.
    expect(started('ta')).toBe(2);
    expect(seenUrls).toEqual([ORIGINAL, REWRITTEN]);

    // THE PIN: the rewrite does not ride out as a `redact` the caller executes.
    expect(verdict.decision).toBe('block');
    expect(verdict.mutations).toEqual([]);
    expect(verdict.subject).toBeUndefined();
    expect(verdict.findings.some((f) => f.policyId === 'ta' && f.block)).toBe(true);
  });

  it('control: a rewrite confined to /result does not re-run tool_access and stays a redact', async () => {
    const seenUrls: string[] = [];
    script({
      ta: toolAccessBehaviour(seenUrls),
      wh: () => ({
        findings: [finding('wh', 'webhook', 'tool.post', 'redact', 'Result scrubbed')],
        mutations: [
          {
            op: 'replace_value',
            path: '/result/body',
            value: 'secret',
            replacement: '[x]',
            family: 'webhook',
            policyId: 'wh',
          },
        ],
      }),
    });
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail(
        [policy('ta', 'tool_access', ['tool.post']), policy('wh', 'webhook', ['tool.post'])],
        ['tool.post'],
      ),
    );

    const subject = toolResultSubject({
      toolName: 'srv/fetch',
      args: { url: ORIGINAL },
      result: { body: 'hello secret' },
      providerRef: 'mcp:srv',
    });
    const verdict = await evaluate('tool.post', subject);

    expect(started('ta')).toBe(1);
    expect(verdict.decision).toBe('redact');
    expect(verdict.subject?.kind).toBe('tool_result');
    expect((verdict.subject as { result: { body: string } } | undefined)?.result.body).toBe('hello [x]');
  });
});
