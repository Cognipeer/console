/**
 * Unit tests - side-call and evaluation follow-ups: a side call whose model's thinking cannot be switched off
 * from here gets no first cap (and keeps its retry), the title control sees the model id, the shared Azure
 * api-version resolver, `truncated` surviving a perTurn replay, and a human review keeping the red-team
 * `inconclusive` flag.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));

import {
  sideCallPlan,
  sideCallThinkingUncontrolled,
  titleReasoning,
} from '@/lib/services/agents/agentReasoning';
import { azureApiVersion } from '@/lib/providers/contracts/azureApiVersion';
import { replayPerTurn } from '@/lib/services/evaluation/runner';
import { computeAggregate } from '@/lib/services/redteam/service';
import type { TargetOutput } from '@/lib/services/evaluation/types';

describe('sideCallThinkingUncontrolled', () => {
  it('is true on Vertex Gemini (thinks dynamically, nothing here turns it off)', () => {
    expect(sideCallThinkingUncontrolled({ providerDriver: 'vertex', modelId: 'gemini-2.5-pro' })).toBe(true);
  });

  it('is false where the thinking is switched off or down', () => {
    expect(sideCallThinkingUncontrolled({ providerDriver: 'anthropic', modelId: 'claude-sonnet-5-5' })).toBe(false);
    expect(sideCallThinkingUncontrolled({ providerDriver: 'openai', modelId: 'gpt-5-mini' })).toBe(false);
  });

  it('is false for opt-in thinking (budget-style Claude) and for chat models', () => {
    expect(sideCallThinkingUncontrolled({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' })).toBe(false);
    expect(sideCallThinkingUncontrolled({ providerDriver: 'openai', modelId: 'gpt-4o' })).toBe(false);
  });

  it('is false for a Dynamic LLM, which is routed to models this cannot know', () => {
    expect(sideCallThinkingUncontrolled({ providerDriver: 'vertex', modelId: 'gemini-2.5-pro' }, { dynamic: true })).toBe(false);
  });
});

describe('sideCallPlan', () => {
  it('is sideCallLimits for a model whose thinking is controlled', () => {
    const plan = sideCallPlan({ providerDriver: 'anthropic', modelId: 'claude-sonnet-5-5' }, 1024);
    expect(plan.limit).toBe(1024);
    expect(plan.retryAfter()).toBe(2048);
    expect(plan.retryAfter(999999)).toBe(2048);
  });

  it('sends no first limit where the thinking cannot be switched off', () => {
    const plan = sideCallPlan({ providerDriver: 'vertex', modelId: 'gemini-2.5-pro' }, 1024);
    expect(plan.limit).toBeUndefined();
  });

  it('retries from the observed output, doubled and capped by the model maximum', () => {
    const plan = sideCallPlan(
      { providerDriver: 'vertex', modelId: 'gemini-2.5-pro', metadata: { capabilities: { maxOutputTokens: 5000 } } },
      1024,
    );
    expect(plan.retryAfter(2000)).toBe(4000);
    expect(plan.retryAfter(3000)).toBe(5000);
  });

  it('retries at the model maximum when nothing was observed, and not at all when already there', () => {
    const plan = sideCallPlan(
      { providerDriver: 'vertex', modelId: 'gemini-2.5-pro', metadata: { capabilities: { maxOutputTokens: 8000 } } },
      1024,
    );
    expect(plan.retryAfter()).toBe(8000);
    expect(plan.retryAfter(8000)).toBeUndefined();
  });
});

describe('titleReasoning', () => {
  it('takes the model id: a Bedrock non-Claude model has no thinking control, so it gets none', () => {
    expect(titleReasoning('bedrock', 'amazon.nova-pro-v1:0')).toEqual({ effort: 'none' });
  });

  it('keeps the driver-only behaviour when no model id is given', () => {
    expect(titleReasoning('anthropic').effort).toBe('none');
    expect(titleReasoning().effort).toBe('none');
  });
});

describe('azureApiVersion', () => {
  it('keeps the provider version for a chat model', () => {
    expect(azureApiVersion('2024-10-21', {})).toBe('2024-10-21');
    expect(azureApiVersion('2024-10-21', undefined)).toBe('2024-10-21');
  });

  it('upgrades a Responses model on an older dated provider version', () => {
    expect(azureApiVersion('2024-10-21', { upstreamApi: 'responses' })).toBe('2025-04-01-preview');
  });

  it('keeps a provider version that already has the Responses route, or an undated one', () => {
    expect(azureApiVersion('2025-03-01-preview', { upstreamApi: 'responses' })).toBe('2025-03-01-preview');
    expect(azureApiVersion('preview', { upstreamApi: 'responses' })).toBe('preview');
  });

  it('honours the per-model azureApiVersion over everything', () => {
    expect(azureApiVersion('2024-10-21', { azureApiVersion: ' 2025-06-01 ', upstreamApi: 'responses' })).toBe('2025-06-01');
    expect(azureApiVersion('2024-10-21', { azureApiVersion: '   ' })).toBe('2024-10-21');
  });
});

describe('replayPerTurn keeps truncated', () => {
  const item = {
    id: 'i1',
    input: [
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'user' as const, content: 'q2' },
    ],
  };

  it('flags the replay when ANY turn was cut off, not only the last', async () => {
    const outputs: TargetOutput[] = [{ text: 'part', truncated: true }, { text: 'full' }];
    const result = await replayPerTurn(item as never, async () => outputs.shift() as TargetOutput);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('full');
  });

  it('leaves the key out when no turn was cut off', async () => {
    const result = await replayPerTurn(item as never, async () => ({ text: 'ok' }));
    expect('truncated' in result).toBe(false);
  });
});

describe('computeAggregate keeps the judge-error signal across a human review', () => {
  const attempt = (judgeFailed: boolean, outcome: 'safe' | 'vulnerable' = 'safe', reviewed?: 'safe' | 'vulnerable') => ({
    probeKey: 'p',
    attemptId: Math.random().toString(),
    family: 'f',
    category: 'c',
    severity: 'low',
    outcome,
    decidedBy: 'detectors',
    transcript: [],
    signals: [{ detectorKey: 'j', kind: 'llm-judge', hit: false, score: 0, ...(judgeFailed ? { error: 'timeout' } : {}) }],
    ...(reviewed ? { review: { outcome: reviewed } } : {}),
  });

  it('counts judge errors and flags the run inconclusive above 20% of the judged attempts', () => {
    const attempts = [attempt(true), attempt(true), attempt(false), attempt(false)];
    const aggregate = computeAggregate(attempts as never);
    expect(aggregate.judgeErrors).toBe(2);
    expect(aggregate.inconclusive).toBe(true);
  });

  it('still says inconclusive after a human overrode one attempt', () => {
    const attempts = [attempt(true, 'safe', 'vulnerable'), attempt(true), attempt(false), attempt(false)];
    const aggregate = computeAggregate(attempts as never);
    expect(aggregate.vulnerable).toBe(1);
    expect(aggregate.inconclusive).toBe(true);
  });

  it('is conclusive when the judge did not fail', () => {
    const aggregate = computeAggregate([attempt(false), attempt(false)] as never);
    expect(aggregate.judgeErrors).toBe(0);
    expect(aggregate.inconclusive).toBe(false);
  });
});
