/**
 * Unit tests — Dynamic LLM routing engine (`dynamicRouting.ts`).
 * Pure logic: signal extraction, rule evaluation (operators, match types,
 * first-match-wins), decider prompt build + label parsing, and config detection.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDeciderMessages,
  evaluateCondition,
  evaluateRules,
  extractRoutingSignals,
  getDynamicRoutingConfig,
  parseDeciderLabel,
  publicSignals,
} from '@/lib/services/models/dynamicRouting';
import type {
  IDynamicDeciderConfig,
  IDynamicRoutingConfig,
  IDynamicRoutingRule,
  IModel,
} from '@/lib/database';

const baseSignals = () =>
  extractRoutingSignals({ messages: [{ role: 'user', content: 'hello world' }] });

describe('extractRoutingSignals', () => {
  it('estimates tokens (~chars/4) and counts messages', () => {
    const signals = extractRoutingSignals({
      messages: [
        { role: 'system', content: 'abcd' }, // 4 chars
        { role: 'user', content: 'abcdefgh' }, // 8 chars
      ],
    });
    expect(signals.messageCount).toBe(2);
    expect(signals.inputTokensEst).toBe(Math.ceil(12 / 4));
    expect(signals.lastUserLength).toBe(8);
    expect(signals.lastUserText).toBe('abcdefgh');
  });

  it('detects tools, response_format and images', () => {
    const signals = extractRoutingSignals({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url: 'data:...' } },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'x' } }],
      response_format: { type: 'json_object' },
    });
    expect(signals.hasTools).toBe(true);
    expect(signals.hasResponseFormat).toBe(true);
    expect(signals.hasImages).toBe(true);
  });

  it('treats tool_choice "none" as no tools', () => {
    const signals = extractRoutingSignals({
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'none',
    });
    expect(signals.hasTools).toBe(false);
  });

  it('publicSignals omits raw user text', () => {
    const pub = publicSignals(baseSignals());
    expect(pub).not.toHaveProperty('lastUserText');
    expect(pub).toHaveProperty('inputTokensEst');
  });
});

describe('evaluateCondition', () => {
  it('numeric operators', () => {
    const s = extractRoutingSignals({
      messages: [{ role: 'user', content: 'x'.repeat(40) }], // ~10 tokens
    });
    expect(evaluateCondition({ signal: 'inputTokensEst', operator: 'gte', value: 10 }, s)).toBe(true);
    expect(evaluateCondition({ signal: 'inputTokensEst', operator: 'lt', value: 10 }, s)).toBe(false);
  });

  it('boolean operators', () => {
    const s = extractRoutingSignals({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{}],
    });
    expect(evaluateCondition({ signal: 'hasTools', operator: 'isTrue' }, s)).toBe(true);
    expect(evaluateCondition({ signal: 'hasTools', operator: 'isFalse' }, s)).toBe(false);
  });

  it('keyword contains and regex matches', () => {
    const s = extractRoutingSignals({
      messages: [{ role: 'user', content: 'Please write some Python code' }],
    });
    expect(evaluateCondition({ signal: 'keyword', operator: 'contains', value: 'python' }, s)).toBe(true);
    expect(evaluateCondition({ signal: 'keyword', operator: 'matches', value: 'py(thon)?' }, s)).toBe(true);
    expect(evaluateCondition({ signal: 'keyword', operator: 'contains', value: 'rust' }, s)).toBe(false);
  });

  it('invalid regex is safe (returns false, no throw)', () => {
    const s = baseSignals();
    expect(evaluateCondition({ signal: 'keyword', operator: 'matches', value: '(' }, s)).toBe(false);
  });
});

describe('evaluateRules', () => {
  const rules: IDynamicRoutingRule[] = [
    {
      label: 'complex',
      targetModelKey: 'big',
      matchType: 'all',
      conditions: [
        { signal: 'inputTokensEst', operator: 'gt', value: 100 },
        { signal: 'hasTools', operator: 'isTrue' },
      ],
    },
    {
      label: 'has-image',
      targetModelKey: 'vision',
      matchType: 'any',
      conditions: [{ signal: 'hasImages', operator: 'isTrue' }],
    },
  ];

  it('returns the first matching rule (all conditions)', () => {
    const s = extractRoutingSignals({
      messages: [{ role: 'user', content: 'x'.repeat(500) }],
      tools: [{}],
    });
    expect(evaluateRules(rules, s)?.targetModelKey).toBe('big');
  });

  it('falls through to a later rule when the first does not match', () => {
    const s = extractRoutingSignals({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }],
    });
    expect(evaluateRules(rules, s)?.label).toBe('has-image');
  });

  it('returns null when nothing matches', () => {
    const s = extractRoutingSignals({ messages: [{ role: 'user', content: 'hi' }] });
    expect(evaluateRules(rules, s)).toBeNull();
  });

  it('skips rules with no conditions', () => {
    const s = baseSignals();
    expect(evaluateRules([{ label: 'x', targetModelKey: 'm', conditions: [] }], s)).toBeNull();
  });
});

describe('decider helpers', () => {
  const decider: IDynamicDeciderConfig = {
    modelKey: 'classifier',
    labels: [
      { label: 'simple', description: 'small talk', targetModelKey: 'mini' },
      { label: 'complex', description: 'reasoning', targetModelKey: 'big' },
    ],
  };

  it('builds a system + user message pair', () => {
    const messages = buildDeciderMessages(decider, baseSignals());
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('simple');
    expect(messages[1].role).toBe('user');
  });

  it('parses exact and decorated labels', () => {
    expect(parseDeciderLabel('complex', decider.labels)?.targetModelKey).toBe('big');
    expect(parseDeciderLabel('Category: simple', decider.labels)?.targetModelKey).toBe('mini');
    expect(parseDeciderLabel('unknown', decider.labels)).toBeNull();
  });
});

describe('getDynamicRoutingConfig', () => {
  const cfg: IDynamicRoutingConfig = { strategy: 'rule-based', defaultModelKey: 'mini', rules: [] };

  it('detects a router model', () => {
    const model = { settings: { dynamic: cfg } } as unknown as IModel;
    expect(getDynamicRoutingConfig(model)).toEqual(cfg);
  });

  it('returns null for a regular model', () => {
    const model = { settings: { temperature: 0.5 } } as unknown as IModel;
    expect(getDynamicRoutingConfig(model)).toBeNull();
  });

  it('returns null when dynamic lacks required fields', () => {
    const model = { settings: { dynamic: { strategy: 'rule-based' } } } as unknown as IModel;
    expect(getDynamicRoutingConfig(model)).toBeNull();
  });
});
