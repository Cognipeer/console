import { describe, expect, it } from 'vitest';
import { formatUsd } from '@/lib/utils/formatUsd';
import { AgentBudgetReachedError } from '@/lib/services/agents/agentErrors';

describe('human-readable amounts in refusals', () => {
  it('formatUsd keeps small amounts visible', () => {
    expect(formatUsd(12.3456)).toBe('12.35');
    expect(formatUsd(0.013)).toBe('0.0130');
    expect(formatUsd(0.00001)).toBe('0.00001');
    expect(formatUsd(0.0000123)).toBe('0.000012');
    expect(formatUsd(0)).toBe('0.00');
  });

  it('the 402 budget message never reads $0.0000', () => {
    const message = new AgentBudgetReachedError(0.013, 0.00001).message;
    expect(message).not.toContain('0.0000 ');
    expect(message).toContain('$0.00001');
  });
});
