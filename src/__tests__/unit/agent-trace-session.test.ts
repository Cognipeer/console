/**
 * resolveTraceSession: a trace thread's id is the conversation's id, and the session's
 * routes are addressed by the agent's id and the conversation's id.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveTraceSession } from '@/lib/services/agents/traceSession';

const input = { tenantDbName: 'tenant_acme', projectId: 'proj-1', threadId: 'conv-1' };
const conversation = (overrides: Record<string, unknown> = {}) => ({ _id: 'conv-1', agentKey: 'field-ops', projectId: 'proj-1', ...overrides }) as never;
const agent = { _id: 'agent-9', key: 'field-ops', projectId: 'proj-1' } as never;

function lookups(over: { conversation?: unknown; agent?: unknown; throws?: boolean } = {}) {
  return {
    getConversationById: vi.fn(async () => {
      if (over.throws) throw new Error('not an id');
      return ('conversation' in over ? over.conversation : conversation()) as never;
    }),
    getAgentByKey: vi.fn(async () => ('agent' in over ? over.agent : agent) as never),
  };
}

describe('resolveTraceSession', () => {
  it('names the agent by its id and the session by the conversation’s id', async () => {
    const deps = lookups();
    expect(await resolveTraceSession(input, deps)).toEqual({ agentId: 'agent-9', sessionId: 'conv-1' });
    expect(deps.getConversationById).toHaveBeenCalledWith('tenant_acme', 'conv-1');
    // The agent is looked up by the conversation's key, inside the caller's project.
    expect(deps.getAgentByKey).toHaveBeenCalledWith('tenant_acme', 'field-ops', 'proj-1');
  });

  it('is null for a thread that is no conversation, or one that cannot be looked up', async () => {
    expect(await resolveTraceSession(input, lookups({ conversation: null }))).toBeNull();
    expect(await resolveTraceSession(input, lookups({ throws: true }))).toBeNull();
  });

  it('is null for a conversation of another project, without looking for its agent', async () => {
    const deps = lookups({ conversation: conversation({ projectId: 'proj-2' }) });
    expect(await resolveTraceSession(input, deps)).toBeNull();
    expect(deps.getAgentByKey).not.toHaveBeenCalled();
  });

  it('is null when the agent is gone', async () => {
    expect(await resolveTraceSession(input, lookups({ agent: null }))).toBeNull();
  });
});
