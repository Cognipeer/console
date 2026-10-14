/**
 * Agent reasoning, pure parts: the precedence rule, per-model picks, the
 * migration of the old Advanced-tab block, request parsing and config
 * validation. The wire effect of the rule is in agent-reasoning-wire.test.ts
 * and the run wiring in agent-reasoning-run.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { IAgentConfig } from '@/lib/database';
import {
  agentReasoningForModel,
  agentShowsReasoning,
  applyModelToConfig,
  migrateAgentReasoning,
  parseAgentRequestReasoning,
  reasoningConfigIssues,
  resolveAgentReasoning,
  titleReasoning,
} from '@/lib/services/agents/agentReasoning';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';
import { resolveAgentRuntimeOptions } from '@/lib/services/agents/agentRuntimeConfig';

describe('precedence: agent > Model Hub > API request > nothing', () => {
  const agent = { effort: 'low' as const };
  const modelSettings = { reasoning: { effort: 'medium' } };
  const request = { effort: 'high' as const };

  it.each([
    ['all three set', { agent, modelSettings, request }, 'agent', 'low'],
    ['no agent pick', { modelSettings, request }, 'model', 'medium'],
    ['only the request', { request }, 'request', 'high'],
    ['agent over request, no Model Hub', { agent, request }, 'agent', 'low'],
    ['agent over Model Hub, no request', { agent, modelSettings }, 'agent', 'low'],
  ] as const)('%s', (_name, input, source, effort) => {
    const resolved = resolveAgentReasoning(input);
    expect(resolved.source).toBe(source);
    expect(resolved.reasoning?.effort).toBe(effort);
  });

  it('nothing set sends nothing', () => {
    expect(resolveAgentReasoning({})).toEqual({ source: 'none' });
    expect(resolveAgentReasoning({ agent: {}, modelSettings: {} })).toEqual({ source: 'none' });
  });

  it('"none" is a value that is sent, and it beats a Model Hub default', () => {
    const resolved = resolveAgentReasoning({ agent: { effort: 'none' }, modelSettings });
    expect(resolved).toMatchObject({ source: 'agent', reasoning: { effort: 'none' } });
  });

  it('is a whole-value pick: a request budget is not grafted onto the agent effort', () => {
    const resolved = resolveAgentReasoning({ agent: { effort: 'low' }, request: { effort: 'high', budgetTokens: 9000 } });
    expect(resolved.reasoning).toEqual({ effort: 'low' });
  });
});

describe('per-model picks', () => {
  const config: IAgentConfig = {
    modelKey: 'main',
    reasoningEffort: 'high',
    reasoningBudgetTokens: 6000,
    additionalModels: [{ modelKey: 'cheap', reasoningEffort: 'none' }, { modelKey: 'plain' }],
  };

  it('reads the main model\'s fields, an additional model\'s entry, or nothing', () => {
    expect(agentReasoningForModel(config, 'main')).toEqual({ effort: 'high', budgetTokens: 6000 });
    expect(agentReasoningForModel(config, 'cheap')).toEqual({ effort: 'none' });
    expect(agentReasoningForModel(config, 'plain')).toBeUndefined();
    expect(agentReasoningForModel(config, 'unknown')).toBeUndefined();
  });

  it('ignores a budget next to "none"', () => {
    expect(agentReasoningForModel({ modelKey: 'm', reasoningEffort: 'none', reasoningBudgetTokens: 5000 }, 'm')).toEqual({ effort: 'none' });
  });

  it('applyModelToConfig swaps the pick along with the model', () => {
    const cheap = applyModelToConfig(config, 'cheap');
    expect(cheap.modelKey).toBe('cheap');
    expect(cheap.reasoningEffort).toBe('none');
    expect(cheap.reasoningBudgetTokens).toBeUndefined();

    const plain = applyModelToConfig(config, 'plain');
    expect(plain.modelKey).toBe('plain');
    expect(plain.reasoningEffort).toBeUndefined();
    expect(plain.reasoningBudgetTokens).toBeUndefined();
    // the input is not mutated
    expect(config).toMatchObject({ modelKey: 'main', reasoningEffort: 'high' });
  });

  it('applyModelToConfig is a no-op for the main model', () => {
    expect(applyModelToConfig(config, 'main')).toBe(config);
  });
});

describe('migration of the old Advanced-tab reasoning', () => {
  it('moves effort and budget onto the main model and keeps only reflection', () => {
    const migrated = migrateAgentReasoning({
      modelKey: 'm',
      runtime: { profile: 'deep', reasoning: { enabled: true, effort: 'medium', budgetTokens: 4096, includeThoughts: true, reflection: false } },
    });
    expect(migrated.reasoningEffort).toBe('medium');
    expect(migrated.reasoningBudgetTokens).toBe(4096);
    expect(migrated.runtime).toEqual({ profile: 'deep', reasoning: { reflection: false } });
  });

  it('falls back to the level when no provider effort was set', () => {
    expect(migrateAgentReasoning({ modelKey: 'm', runtime: { reasoning: { enabled: true, level: 'high' } } }).reasoningEffort).toBe('high');
  });

  it('a disabled block migrates to "Model default" (nothing set)', () => {
    const migrated = migrateAgentReasoning({ modelKey: 'm', runtime: { reasoning: { enabled: false, effort: 'high' } } });
    expect(migrated.reasoningEffort).toBeUndefined();
    expect(migrated.runtime).toBeUndefined();
  });

  it('an explicit new-style pick wins over a stale old one', () => {
    const migrated = migrateAgentReasoning({ modelKey: 'm', reasoningEffort: 'low', runtime: { reasoning: { enabled: true, effort: 'high' } } });
    expect(migrated.reasoningEffort).toBe('low');
    expect(migrated.runtime).toBeUndefined();
  });

  it('is idempotent and leaves a config without the old block untouched', () => {
    const once = migrateAgentReasoning({ modelKey: 'm', runtime: { reasoning: { enabled: true, effort: 'low', budgetTokens: 2000 } } });
    expect(migrateAgentReasoning(once)).toEqual(once);
    const clean: IAgentConfig = { modelKey: 'm', runtime: { profile: 'fast', reasoning: { reflection: false } } };
    expect(migrateAgentReasoning(clean)).toBe(clean);
  });

  it('drops a budget that sat next to "none"', () => {
    const migrated = migrateAgentReasoning({ modelKey: 'm', runtime: { reasoning: { enabled: true, effort: 'none', budgetTokens: 3000 } } });
    expect(migrated.reasoningEffort).toBe('none');
    expect(migrated.reasoningBudgetTokens).toBeUndefined();
  });

  it('the SDK runtime options read reflection only', () => {
    const old = resolveAgentRuntimeOptions({ modelKey: 'm', runtime: { reasoning: { enabled: true, effort: 'high', budgetTokens: 5000, reflection: false } } });
    expect(old.reasoning).toEqual({ enabled: true, reflection: false });
    expect(JSON.stringify(old.reasoning)).not.toContain('native');
    expect(resolveAgentRuntimeOptions({ modelKey: 'm', runtime: { reasoning: { enabled: true, effort: 'high' } } }).reasoning).toBeUndefined();
  });
});

describe('request parsing (reasoning_effort / reasoning: { effort })', () => {
  it('reads either form, the object winning', () => {
    expect(parseAgentRequestReasoning({ reasoning_effort: 'low' }).value).toEqual({ effort: 'low' });
    expect(parseAgentRequestReasoning({ reasoning: { effort: 'High' } }).value).toEqual({ effort: 'high' });
    expect(parseAgentRequestReasoning({ reasoning_effort: 'low', reasoning: { effort: 'high' } }).value).toEqual({ effort: 'high' });
    expect(parseAgentRequestReasoning({ reasoning_effort: 'none' }).value).toEqual({ effort: 'none' });
  });

  it('sends nothing when the request has nothing', () => {
    expect(parseAgentRequestReasoning({})).toEqual({ value: undefined });
    expect(parseAgentRequestReasoning(undefined)).toEqual({});
    expect(parseAgentRequestReasoning({ reasoning_effort: null })).toEqual({ value: undefined });
  });

  it.each([
    [{ reasoning_effort: 'extreme' }, /reasoning_effort must be one of/],
    [{ reasoning_effort: 5 }, /reasoning_effort must be one of/],
    [{ reasoning: { effort: 'turbo' } }, /reasoning\.effort must be one of/],
    [{ reasoning: 'high' }, /reasoning must be an object/],
    [{ reasoning: ['high'] }, /reasoning must be an object/],
  ])('refuses %j', (body, message) => {
    const parsed = parseAgentRequestReasoning(body);
    expect(parsed.error).toMatch(message);
    expect(parsed.value).toBeUndefined();
  });
});

describe('config validation', () => {
  it('accepts valid picks', () => {
    expect(reasoningConfigIssues({
      modelKey: 'm', reasoningEffort: 'low', reasoningBudgetTokens: 2000, showReasoning: false,
      additionalModels: [{ modelKey: 'x', reasoningEffort: 'none' }],
    })).toEqual([]);
  });

  it('names the field of each bad value', () => {
    const issues = reasoningConfigIssues({
      modelKey: 'm',
      reasoningEffort: 'ultra' as never,
      reasoningBudgetTokens: -1,
      showReasoning: 'yes' as never,
      additionalModels: [{ modelKey: 'x', reasoningEffort: 'ultra' as never }],
    });
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      'additionalModels[0].reasoningEffort',
      'reasoningBudgetTokens',
      'reasoningEffort',
      'showReasoning',
    ]);
  });

  it('is part of the save-time shape check', () => {
    const validation = validateAgentConfigShape({ modelKey: 'm', reasoningEffort: 'ultra' as never });
    expect(validation.errors).toContainEqual({ field: 'reasoningEffort', message: expect.stringContaining('must be one of') });
    expect(validateAgentConfigShape({ modelKey: 'm', reasoningEffort: 'low' }).errors).toEqual([]);
  });
});

describe('visibility and title generation', () => {
  it('showReasoning defaults to true and only an explicit false hides', () => {
    expect(agentShowsReasoning({})).toBe(true);
    expect(agentShowsReasoning({ showReasoning: true })).toBe(true);
    expect(agentShowsReasoning({ showReasoning: false })).toBe(false);
    expect(agentShowsReasoning(undefined)).toBe(true);
  });

  it('a title never thinks', () => {
    expect(titleReasoning().effort).toBe('none');
    expect(titleReasoning('anthropic').effort).toBe('none');
  });
});
