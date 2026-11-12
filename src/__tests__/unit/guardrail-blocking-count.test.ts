import { describe, it, expect } from 'vitest';
import { countBlockingGuardrails } from '@/components/guardrails/blockingCount';

describe('countBlockingGuardrails', () => {
  it('counts only enforcing block guardrails', () => {
    expect(
      countBlockingGuardrails([
        { action: 'block', mode: 'enforce', enabled: true },
        { action: 'block', mode: 'monitor', enabled: true },
        { action: 'block', mode: 'disabled', enabled: true },
        { action: 'block', enabled: false },
        { action: 'block', enabled: true },
        { action: 'warn', mode: 'enforce', enabled: true },
      ]),
    ).toBe(2);
  });
});
