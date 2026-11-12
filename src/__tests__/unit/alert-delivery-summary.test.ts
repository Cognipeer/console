import { describe, it, expect } from 'vitest';
import { summarizeDeliveries } from '@/components/alerts/deliverySummary';

describe('summarizeDeliveries', () => {
  it('classifies delivery outcomes', () => {
    expect(summarizeDeliveries(undefined).kind).toBe('none-attempted');
    expect(summarizeDeliveries([]).kind).toBe('none-attempted');
    expect(summarizeDeliveries([{ success: true }]).kind).toBe('all');
    expect(summarizeDeliveries([{ success: true }, { success: false }])).toEqual({ kind: 'partial', sent: 1, total: 2 });
    expect(summarizeDeliveries([{ success: false }]).kind).toBe('failed-one');
    expect(summarizeDeliveries([{ success: false }, { success: false }]).kind).toBe('failed-all');
  });
});
