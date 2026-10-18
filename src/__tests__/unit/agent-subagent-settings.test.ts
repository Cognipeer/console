import { describe, expect, it } from 'vitest';

import type { IAgentSubagent, IAgentSubagentPolicy } from '@/lib/database/provider/types.domain';
import { subagentPolicyToStore } from '@/components/agents/studio/subagentSettings';

const roster = [{ kind: 'inline', name: 'helper', header: 'h' }] as unknown as IAgentSubagent[];

describe('subagentPolicyToStore', () => {
  const policy: IAgentSubagentPolicy = { mode: 'registry_and_adhoc', maxDepth: 2 };

  it('keeps the policy of a roster', () => {
    expect(subagentPolicyToStore(roster, policy)).toBe(policy);
    expect(subagentPolicyToStore(roster, { mode: 'off' })).toEqual({ mode: 'off' });
  });

  it('keeps a policy that allows delegation while the roster is still empty (ad-hoc sub-agents need no roster)', () => {
    expect(subagentPolicyToStore([], policy)).toBe(policy);
  });

  it('drops a switched-off policy with nothing to delegate to, and no policy at all', () => {
    expect(subagentPolicyToStore([], { mode: 'off' })).toBeUndefined();
    expect(subagentPolicyToStore([], undefined)).toBeUndefined();
  });
});
