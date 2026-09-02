import { describe, expect, it } from 'vitest';
import {
  HOOK_PRESETS,
  canPolicyBind,
  cellState,
  policyDisplayName,
  describeIssues,
  emptyHooksConfig,
  estimateStreamCost,
  isCellOn,
  isPolicyOn,
  isLiftedPolicy,
  matrixColumns,
  setCell,
  setPolicyHook,
  setHookEnabled,
} from '@/components/guardrails/GuardrailHooksMatrix';
import type {
  GuardrailPolicy,
  GuardrailHooksConfig,
  HookId,
} from '@/lib/services/guardrail/hooks/contract';
import { GUARDRAIL_CONTRACT_VERSION } from '@/lib/services/guardrail/hooks/contract';

// ── fixtures ──────────────────────────────────────────────────────────────

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

/** A regex policy with a declared bound, so it is stream-eligible. */
function regexPolicy(
  id: string,
  hooks: HookId[],
  overrides: Partial<{ label: string; enabled: boolean; maxMatchChars: number }> = {},
): GuardrailPolicy {
  return {
    id,
    family: 'regex',
    enabled: overrides.enabled ?? true,
    hooks,
    schedule: SYNC_BLOCK,
    label: overrides.label,
    rules: [
      {
        id: `${id}-rule`,
        label: `${id} rule`,
        pattern: 'secret-\\d+',
        category: 'internal',
        severity: 'medium',
        maxMatchChars: overrides.maxMatchChars ?? 32,
      },
    ],
  };
}

function configOf(policies: GuardrailPolicy[]): GuardrailHooksConfig {
  const bindings: GuardrailHooksConfig['bindings'] = {};
  for (const policy of policies) {
    if (!policy.enabled) continue;
    for (const hook of policy.hooks) bindings[hook] = { enabled: true, schedule: SYNC_BLOCK };
  }
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    policies,
    bindings,
    stream: { enabled: true },
    shortCircuit: true,
  };
}

/**
 * The configuration the whole redesign exists for: two policies of ONE family,
 * running in two different places. The family grid could not represent it.
 */
const TWO_REGEXES = configOf([
  regexPolicy('regex:sqli', ['tool.pre'], { label: 'SQL injection · tool args' }),
  regexPolicy('regex:internal-url', ['output.pre', 'output.stream.delta'], {
    label: 'Internal URL leak',
  }),
]);

// ── presets ───────────────────────────────────────────────────────────────

describe('hook matrix presets', () => {
  it('every preset binds every hook its policies name', () => {
    for (const preset of HOOK_PRESETS) {
      const hooks = preset.build('model-a');
      for (const policy of hooks.policies) {
        for (const hook of policy.hooks) {
          expect(hooks.bindings[hook]?.enabled, `${preset.id}/${policy.id}/${hook}`).toBe(true);
        }
      }
    }
  });

  it('only reports issues an operator has to supply', () => {
    for (const preset of HOOK_PRESETS) {
      const issues = describeIssues(preset.build('model-a'));
      for (const issue of issues) {
        expect(issue.message, `${preset.id}: ${issue.policyId} — ${issue.message}`).toMatch(
          /PII policy/,
        );
      }
    }
  });

  it('output-safety binds the stream hook with a bounded overlap', () => {
    const hooks = HOOK_PRESETS.find((p) => p.id === 'output-safety')!.build();
    const cost = estimateStreamCost(hooks, 160);
    expect(hooks.stream?.enabled).toBe(true);
    expect(cost.requiredOverlap).toBeGreaterThan(0);
    expect(cost.holdBackChars).toBeGreaterThanOrEqual(cost.requiredOverlap);
    expect(cost.addedTtftMs).toBeGreaterThan(0);
  });

  it('names every policy it creates, because a name is now a column header', () => {
    for (const preset of HOOK_PRESETS) {
      for (const column of matrixColumns(preset.build('model-a'))) {
        // Not merely non-empty: a real name, not the id dressed up.
        expect(column.name, `${preset.id}/${column.policyId}`).not.toContain(column.policyId);
      }
    }
  });
});

describe('empty config', () => {
  it('defaults streaming ON for a newly authored guardrail', () => {
    expect(emptyHooksConfig().stream?.enabled).toBe(true);
  });
  it('has nothing to complain about', () => {
    expect(describeIssues(emptyHooksConfig())).toEqual([]);
  });
  it('produces no columns, which is what the empty state keys off', () => {
    expect(matrixColumns(emptyHooksConfig())).toEqual([]);
  });
});

// ── the column model ──────────────────────────────────────────────────────

describe('the column model', () => {
  it('gives two policies of one family two columns', () => {
    const columns = matrixColumns(TWO_REGEXES);
    expect(columns.map((c) => c.policyId)).toEqual(['regex:sqli', 'regex:internal-url']);
    expect(columns.every((c) => c.family === 'regex')).toBe(true);
    expect(columns.map((c) => c.name)).toEqual(['SQL injection · tool args', 'Internal URL leak']);
  });

  it('keeps stored order rather than sorting, because that IS the run order', () => {
    const reversed = configOf([
      regexPolicy('b', ['input.pre'], { label: 'B' }),
      regexPolicy('a', ['input.pre'], { label: 'A' }),
    ]);
    expect(matrixColumns(reversed).map((c) => c.policyId)).toEqual(['b', 'a']);
  });

  it('reports the hooks a policy can actually take, not just its family list', () => {
    const bounded = matrixColumns(configOf([regexPolicy('r', ['output.pre'])]))[0];
    expect(bounded.validHooks).toContain('output.stream.delta');

    // Same family, same hook list — but no declared bound, so the stream hook
    // is unreachable for THIS policy.
    const unbounded = matrixColumns(
      configOf([regexPolicy('r', ['output.pre'], { maxMatchChars: 0 })]),
    )[0];
    expect(unbounded.validHooks).not.toContain('output.stream.delta');
  });

  it('hides disabled policies only when asked', () => {
    const mixed = configOf([
      regexPolicy('on', ['input.pre'], { label: 'On' }),
      regexPolicy('off', ['input.pre'], { label: 'Off', enabled: false }),
    ]);
    expect(matrixColumns(mixed)).toHaveLength(2);
    expect(matrixColumns(mixed, { enabledOnly: true }).map((c) => c.policyId)).toEqual(['on']);
  });

  it('falls back to the family and id, then to the family, when a policy has no label', () => {
    // Shared with the Policies tab (policyFamilyMeta.ts) so a policy cannot be
    // called one thing in the grid and another in the list.
    const unlabelled = regexPolicy('regex:2', ['input.pre']);
    expect(policyDisplayName(unlabelled)).toBe('Regex · regex:2');
    expect(policyDisplayName(Object.assign({}, unlabelled, { id: '' }))).toBe('Regex');
  });
});

// ── legacy rows ───────────────────────────────────────────────────────────

describe('a lifted legacy guardrail', () => {
  /** Exactly what `liftLegacyPolicies` emits for `policy.wordFilter.enabled`. */
  const lifted = configOf([
    {
      id: 'legacy:word_filter',
      family: 'word_filter',
      enabled: true,
      hooks: ['input.pre', 'output.pre'],
      schedule: SYNC_BLOCK,
      action: 'block',
      words: ['zzz'],
    },
  ]);

  it('renders as columns rather than as an empty grid', () => {
    const columns = matrixColumns(lifted);
    expect(columns).toHaveLength(1);
    expect(columns[0].lifted).toBe(true);
    // The shared display name puts the family in front of a policy that was
    // never given one, which is what a lifted policy always is.
    expect(columns[0].name).toBe('Word filter · legacy:word_filter');
  });

  it('is valid as it stands, so the screen shows no manufactured errors', () => {
    expect(describeIssues(lifted)).toEqual([]);
  });

  it('marks only lifted ids as lifted', () => {
    expect(isLiftedPolicy(lifted.policies[0])).toBe(true);
    expect(isLiftedPolicy(regexPolicy('regex:sqli', ['tool.pre']))).toBe(false);
  });
});

// ── cell state ────────────────────────────────────────────────────────────

describe('cell state', () => {
  it('separates on, off and invalid', () => {
    expect(cellState(TWO_REGEXES, 'regex:sqli', 'tool.pre')).toBe('on');
    expect(cellState(TWO_REGEXES, 'regex:sqli', 'output.pre')).toBe('off');
    expect(cellState(TWO_REGEXES, 'regex:sqli', 'input.pre')).toBe('off');
  });

  it('calls a hook the family cannot serve invalid', () => {
    const wordFilter = configOf([
      {
        id: 'wf',
        family: 'word_filter',
        enabled: true,
        hooks: ['input.pre'],
        schedule: SYNC_BLOCK,
        words: ['zzz'],
      },
    ]);
    expect(cellState(wordFilter, 'wf', 'output.stream.delta')).toBe('invalid');
    expect(cellState(wordFilter, 'wf', 'tool.pre')).toBe('invalid');
  });

  it('calls the stream hook invalid for a policy with no declared bound', () => {
    const unbounded = configOf([regexPolicy('r', ['output.pre'], { maxMatchChars: 0 })]);
    expect(cellState(unbounded, 'r', 'output.stream.delta')).toBe('invalid');
    expect(cellState(unbounded, 'r', 'output.pre')).toBe('on');
  });

  it('still reads ON for a bound policy that has since become illegal', () => {
    // Reachable: the rule lost its bound after it was bound to the stream.
    const stale = configOf([
      regexPolicy('r', ['output.pre', 'output.stream.delta'], { maxMatchChars: 0 }),
    ]);
    // Hiding it as 'invalid' would conceal a config the server will reject.
    expect(cellState(stale, 'r', 'output.stream.delta')).toBe('on');
    expect(
      describeIssues(stale).some((issue) => /bounded match length/.test(issue.message)),
    ).toBe(true);
  });

  it('treats an unknown policy id as invalid rather than throwing', () => {
    expect(cellState(TWO_REGEXES, 'nope', 'input.pre')).toBe('invalid');
  });

  it('reads a disabled policy as off everywhere, even where it is bound', () => {
    const parked = configOf([regexPolicy('r', ['input.pre'], { enabled: false })]);
    expect(cellState(parked, 'r', 'input.pre')).toBe('off');
    expect(isPolicyOn(parked, 'r', 'input.pre')).toBe(false);
  });
});

// ── the instance-level state machine ──────────────────────────────────────

describe('the policy / hook state machine', () => {
  it('moves ONE policy without touching its sibling in the same family', () => {
    // The whole point of the redesign: the family grid could not do this.
    const next = setPolicyHook(TWO_REGEXES, 'regex:sqli', 'output.pre', true);
    expect(isPolicyOn(next, 'regex:sqli', 'output.pre')).toBe(true);
    expect(isPolicyOn(next, 'regex:sqli', 'tool.pre')).toBe(true);
    expect(isPolicyOn(next, 'regex:internal-url', 'tool.pre')).toBe(false);
    expect(next.policies.find((c) => c.id === 'regex:internal-url')).toEqual(
      TWO_REGEXES.policies.find((c) => c.id === 'regex:internal-url'),
    );
  });

  it('enables the binding a newly filled cell needs', () => {
    const next = setPolicyHook(TWO_REGEXES, 'regex:sqli', 'input.pre', true);
    expect(next.bindings['input.pre']?.enabled).toBe(true);
    expect(describeIssues(next)).toEqual([]);
  });

  it('refuses a hook the policy cannot serve instead of authoring a rejected config', () => {
    const unbounded = configOf([regexPolicy('r', ['output.pre'], { maxMatchChars: 0 })]);
    const next = setPolicyHook(unbounded, 'r', 'output.stream.delta', true);
    expect(next).toBe(unbounded);
    expect(isPolicyOn(next, 'r', 'output.stream.delta')).toBe(false);
  });

  it('is a no-op for an unknown policy id', () => {
    expect(setPolicyHook(TWO_REGEXES, 'nope', 'input.pre', true)).toBe(TWO_REGEXES);
  });

  it('parks the policy on its last cell instead of deleting its payload', () => {
    const before = TWO_REGEXES.policies.find((c) => c.id === 'regex:sqli');
    const off = setPolicyHook(TWO_REGEXES, 'regex:sqli', 'tool.pre', false);
    const parked = off.policies.find((c) => c.id === 'regex:sqli');

    expect(isPolicyOn(off, 'regex:sqli', 'tool.pre')).toBe(false);
    // The rules survive, and the policy still names a hook: the validator
    // rejects a policy bound to nothing, even a disabled one.
    expect(parked).toEqual({ ...before, enabled: false });
    expect(describeIssues(off)).toEqual([]);
  });

  it('drops one hook and keeps the rest when a policy runs in several places', () => {
    const off = setPolicyHook(TWO_REGEXES, 'regex:internal-url', 'output.stream.delta', false);
    const policy = off.policies.find((c) => c.id === 'regex:internal-url');
    expect(policy?.enabled).toBe(true);
    expect(policy?.hooks).toEqual(['output.pre']);
  });

  it('lights up only the cell that was clicked when a parked policy comes back', () => {
    let hooks = setPolicyHook(TWO_REGEXES, 'regex:internal-url', 'output.pre', false);
    hooks = setPolicyHook(hooks, 'regex:internal-url', 'output.stream.delta', false);
    // Parked. Re-tick a DIFFERENT cell: its stale hook list must not come back.
    hooks = setPolicyHook(hooks, 'regex:internal-url', 'input.pre', true);

    expect(isPolicyOn(hooks, 'regex:internal-url', 'input.pre')).toBe(true);
    expect(isPolicyOn(hooks, 'regex:internal-url', 'output.pre')).toBe(false);
    expect(isPolicyOn(hooks, 'regex:internal-url', 'output.stream.delta')).toBe(false);
    expect(describeIssues(hooks)).toEqual([]);
  });

  it('switching a hook off can never strand an enabled policy on it', () => {
    const off = setHookEnabled(TWO_REGEXES, 'output.pre', false);
    expect(off.bindings['output.pre']?.enabled).toBe(false);
    expect(isPolicyOn(off, 'regex:internal-url', 'output.pre')).toBe(false);
    // The other hook that policy runs on is untouched.
    expect(isPolicyOn(off, 'regex:internal-url', 'output.stream.delta')).toBe(true);
    expect(isPolicyOn(off, 'regex:sqli', 'tool.pre')).toBe(true);
    // The state the server rejects — an enabled policy on a dead binding — is
    // unreachable, not merely refused.
    expect(describeIssues(off)).toEqual([]);
  });

  it('parks a policy whose only hook was switched off', () => {
    const off = setHookEnabled(TWO_REGEXES, 'tool.pre', false);
    const parked = off.policies.find((c) => c.id === 'regex:sqli');
    expect(parked?.enabled).toBe(false);
    expect(parked?.hooks).toEqual(['tool.pre']);
    expect(describeIssues(off)).toEqual([]);
  });
});

// ── the family-level helpers, still used by presets ───────────────────────

describe('the family-level helpers', () => {
  it('ticking a cell enables the binding it needs', () => {
    const next = setCell(emptyHooksConfig(), 'secrets', 'input.pre', true);
    expect(isCellOn(next, 'secrets', 'input.pre')).toBe(true);
    expect(next.bindings['input.pre']?.enabled).toBe(true);
    expect(describeIssues(next)).toEqual([]);
  });

  it('unticking the last cell parks the policy instead of deleting its payload', () => {
    const on = setCell(emptyHooksConfig(), 'regex', 'output.pre', true);
    const rules = on.policies.find((c) => c.family === 'regex');
    const off = setCell(on, 'regex', 'output.pre', false);
    const parked = off.policies.find((c) => c.family === 'regex');

    expect(isCellOn(off, 'regex', 'output.pre')).toBe(false);
    expect(parked).toBeDefined();
    expect(parked?.enabled).toBe(false);
    expect(parked?.hooks.length).toBeGreaterThan(0);
    expect(parked).toEqual({ ...rules, enabled: false });
  });

  it('re-ticking a parked policy lights up only the cell that was clicked', () => {
    let hooks = setCell(emptyHooksConfig(), 'secrets', 'input.pre', true);
    hooks = setCell(hooks, 'secrets', 'output.pre', true);
    hooks = setCell(hooks, 'secrets', 'input.pre', false);
    hooks = setCell(hooks, 'secrets', 'output.pre', false);
    hooks = setCell(hooks, 'secrets', 'output.pre', true);

    expect(isCellOn(hooks, 'secrets', 'output.pre')).toBe(true);
    expect(isCellOn(hooks, 'secrets', 'input.pre')).toBe(false);
  });

  it('switching a hook off can never strand an enabled policy on it', () => {
    let hooks = setCell(emptyHooksConfig(), 'secrets', 'input.pre', true);
    hooks = setCell(hooks, 'word_filter', 'input.pre', true);
    expect(describeIssues(hooks)).toEqual([]);

    const off = setHookEnabled(hooks, 'input.pre', false);
    expect(off.bindings['input.pre']?.enabled).toBe(false);
    expect(isCellOn(off, 'secrets', 'input.pre')).toBe(false);
    expect(isCellOn(off, 'word_filter', 'input.pre')).toBe(false);
    expect(describeIssues(off)).toEqual([]);
  });

  it('a PII policy bound to the stream gives up its obfuscation pass', () => {
    const hooks = setCell(emptyHooksConfig(), 'pii', 'output.stream.delta', true);
    const policy = hooks.policies.find((c) => c.family === 'pii');
    expect(policy && 'detectObfuscated' in policy ? policy.detectObfuscated : undefined).toBe(false);
    // …which is what gives it a bounded match length, and therefore a window.
    expect(estimateStreamCost(hooks, 160).requiredOverlap).toBeGreaterThan(0);
  });

  it('keeps a stream-ineligible family off the streaming row entirely', () => {
    const hooks = setCell(emptyHooksConfig(), 'word_filter', 'output.stream.delta', true);
    // word_filter is not in POLICY_VALID_HOOKS for the delta hook, so the cell
    // is invalid in the UI; the helper must not invent a policy for it either.
    expect(isCellOn(hooks, 'word_filter', 'output.stream.delta')).toBe(false);
  });

  it('agrees with canPolicyBind about what the streaming hook accepts', () => {
    const wordFilter = configOf([
      {
        id: 'wf',
        family: 'word_filter',
        enabled: true,
        hooks: ['input.pre'],
        schedule: SYNC_BLOCK,
        words: ['zzz'],
      },
    ]).policies[0];
    expect(canPolicyBind(wordFilter, 'output.stream.delta')).toBe(false);
    expect(canPolicyBind(wordFilter, 'input.pre')).toBe(true);
    expect(canPolicyBind(regexPolicy('r', []), 'output.stream.delta')).toBe(true);
  });
});

// ── the streaming cost readout ────────────────────────────────────────────

describe('the streaming cost estimate', () => {
  it('says the gate engages when a bounded policy is bound and switched on', () => {
    const cost = estimateStreamCost(TWO_REGEXES, 160);
    expect(cost.gated).toBe(true);
    expect(cost.notGatedReason).toBeUndefined();
    expect(cost.addedTtftMs).toBeGreaterThan(0);
  });

  it('reports zero cost — and why — when nothing bounded is bound here', () => {
    // The hook is switched ON and empty, which is the state an operator reaches
    // by turning the streaming row on before binding anything to it.
    const emptyStreamHook: GuardrailHooksConfig = {
      ...configOf([regexPolicy('r', ['output.pre'])]),
      bindings: {
        'output.pre': { enabled: true, schedule: SYNC_BLOCK },
        'output.stream.delta': { enabled: true, schedule: SYNC_BLOCK },
      },
    };
    const cost = estimateStreamCost(emptyStreamHook, 160);
    expect(cost.gated).toBe(false);
    expect(cost.notGatedReason).toMatch(/bounded match length/);
    // The hypothetical figures survive: the page uses them to say what turning
    // it on WOULD cost.
    expect(cost.holdBackChars).toBeGreaterThan(0);
  });

  it('is not gated when the streaming hook itself is switched off', () => {
    const off = setHookEnabled(TWO_REGEXES, 'output.stream.delta', false);
    const cost = estimateStreamCost(off, 160);
    expect(cost.gated).toBe(false);
    expect(cost.notGatedReason).toMatch(/switched off/);
  });

  it('is not gated when streaming enforcement is off for the guardrail', () => {
    const cost = estimateStreamCost({ ...TWO_REGEXES, stream: { enabled: false } }, 160);
    expect(cost.gated).toBe(false);
    expect(cost.notGatedReason).toMatch(/Streaming enforcement is off/);
  });

  it('is not gated in monitor mode, because the engine skips the gate there', () => {
    expect(estimateStreamCost(TWO_REGEXES, 160, 'monitor').gated).toBe(false);
    expect(estimateStreamCost(TWO_REGEXES, 160, 'enforce').gated).toBe(true);
    // No mode given means "assume the guardrail enforces", which is what the
    // two existing call sites want.
    expect(estimateStreamCost(TWO_REGEXES, 160).gated).toBe(true);
  });

  it('reports that ONE unbounded policy disables the whole guardrail gate', () => {
    // `foldStreamSettings` breaks out of the guardrail on the first unbounded
    // policy, so the bounded sibling stops enforcing on the stream too. That is
    // the single most surprising behaviour on this screen; it must be said.
    const mixed = configOf([
      regexPolicy('good', ['output.stream.delta'], { label: 'Bounded' }),
      regexPolicy('bad', ['output.stream.delta'], { label: 'Unbounded', maxMatchChars: 0 }),
    ]);
    const cost = estimateStreamCost(mixed, 160);
    expect(cost.gated).toBe(false);
    expect(cost.notGatedReason).toMatch(/Unbounded/);
    expect(cost.notGatedReason).toMatch(/skip/);
  });
});

// ── the local validator ───────────────────────────────────────────────────

describe('the local issue list', () => {
  it('names the policy the way its column does', () => {
    const noPolicy = configOf([
      {
        id: 'pii:corporate',
        family: 'pii',
        enabled: true,
        hooks: ['input.pre'],
        schedule: SYNC_BLOCK,
        label: 'Corporate PII',
        piiPolicyKey: '',
      },
    ]);
    const issues = describeIssues(noPolicy);
    expect(issues).toHaveLength(1);
    expect(issues[0].policyName).toBe('Corporate PII');
    expect(issues[0].policyId).toBe('pii:corporate');
  });

  it('reports a policy bound to no hook, enabled or not', () => {
    for (const enabled of [true, false]) {
      const orphan = configOf([regexPolicy('r', [], { enabled })]);
      expect(
        describeIssues(orphan).some((issue) => /bound to no hook/.test(issue.message)),
        `enabled: ${enabled}`,
      ).toBe(true);
    }
  });

  it('reports a contract version this console cannot write', () => {
    // `GuardrailContractVersion` is the literal 2, so a v1 row is only
    // reachable through a cast — which is exactly how it reaches the UI too:
    // off a database row an older build wrote.
    const stale = {
      ...emptyHooksConfig(),
      contractVersion: 1,
    } as unknown as GuardrailHooksConfig;
    const issues = describeIssues(stale);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/contract version/);
  });

  it('reports two policies that share an id, because a finding names the id', () => {
    const clash = configOf([
      regexPolicy('regex:1', ['input.pre'], { label: 'First' }),
      regexPolicy('regex:1', ['input.pre'], { label: 'Second' }),
    ]);
    expect(describeIssues(clash).some((issue) => /share this id/.test(issue.message))).toBe(true);
  });
});
