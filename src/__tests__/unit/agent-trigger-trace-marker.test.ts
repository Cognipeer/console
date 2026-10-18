import { describe, expect, it } from 'vitest';
import { buildTracingMetadata } from '@/lib/services/agents/agentService';
import { withTriggerMarker } from '@/lib/services/agents/agentRunService';

describe('trace marker of a trigger run', () => {
  it('stamps source, trigger id and kind on the runtime context of a run a trigger started', () => {
    const context = withTriggerMarker({ metadata: { a: 1 } }, { triggerId: 'trg_1', trigger: 'schedule' });
    expect(context).toMatchObject({ source: 'trigger', trigger: { id: 'trg_1', type: 'schedule' }, metadata: { a: 1 } });
    expect(buildTracingMetadata(context)).toEqual({ source: 'trigger', triggerId: 'trg_1', trigger: 'schedule' });
  });

  it('leaves the context of any other run alone', () => {
    const context = { source: 'api' as const };
    expect(withTriggerMarker(context, { triggerId: null, trigger: 'request' })).toBe(context);
  });
});
