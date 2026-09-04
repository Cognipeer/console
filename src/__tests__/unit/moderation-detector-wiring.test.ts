/**
 * Regression guards for the two places a moderation policy is REBUILT field by
 * field on its way to the evaluator. Both dropped `detector` when it was added,
 * which sent a classifier policy down the LLM-judge path and failed the run with
 * "not an LLM model" — a silent misroute that no type error catches, because
 * both shapes are structurally valid without the optional field.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (relative: string) =>
  readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('the moderation policy keeps its detector across every rebuild', () => {
  it('the legacy record converter carries it', () => {
    const source = read('src/lib/services/guardrail/hooks/legacy.ts');
    const block = source.slice(source.indexOf("family: 'moderation'"));
    const end = block.indexOf('satisfies ModerationPolicyConfig');
    expect(end).toBeGreaterThan(-1);
    expect(block.slice(0, end)).toContain('detector');
  });

  it('the family dispatcher carries it', () => {
    const source = read('src/lib/services/guardrail/families/llm.ts');
    const block = source.slice(source.indexOf("case 'moderation':"));
    const end = block.indexOf("case 'prompt_shield':");
    expect(end).toBeGreaterThan(-1);
    expect(block.slice(0, end)).toContain('detector: policy.detector');
  });

  it('the catalog exposes a control for it, so it is reachable from the UI', () => {
    const source = read('src/lib/services/guardrail/catalog/families.ts');
    const block = source.slice(source.indexOf('  moderation: {'));
    const end = block.indexOf('  prompt_shield: {');
    expect(end).toBeGreaterThan(-1);
    const moderation = block.slice(0, end);
    expect(moderation).toContain("key: 'detector'");
    // `llm` has to stay the default: it is the only detector every provider can
    // serve, so a policy authored before any moderation model exists still runs.
    expect(moderation).toContain("detector: 'llm' as const");
  });
});
