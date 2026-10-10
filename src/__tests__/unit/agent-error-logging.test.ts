/**
 * A failed agent call is logged by what it was: a refusal the API is
 * designed to give is one line without a stack; only a server fault is an
 * error. The classification (status, type) is the one the response uses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunConflictError } from '@/lib/database/provider/errors';
import {
  AgentAttachmentError,
  AgentBudgetReachedError,
  AgentPendingActionError,
  AgentSpendLimitError,
} from '@/lib/services/agents/agentErrors';
import { logAgentRouteError } from '@/lib/services/agents/agentErrorLogging';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => vi.clearAllMocks());

describe('logAgentRouteError', () => {
  it.each([
    ['a spent session budget', new AgentBudgetReachedError(2, 1), 402, 'budget_reached'],
    ['a session waiting on a person', new AgentPendingActionError(['act_1']), 409, 'pending_action'],
    ['a busy conversation', new AgentRunConflictError('conv-1'), 409, 'agent_run_conflict'],
  ])('%s is info: one line, status/type/code, no error object', (_label, error, status, type) => {
    const classified = logAgentRouteError(log, 'boom', error, { agentKey: 'support' });
    expect(classified).toMatchObject({ status, error: { type } });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    const [message, detail] = log.info.mock.calls[0]!;
    expect(message).toBe('boom');
    expect(detail).toMatchObject({ status, type, agentKey: 'support' });
    expect(detail).not.toHaveProperty('error');
  });

  it.each([
    ['a rejected attachment', new AgentAttachmentError(415, 'unsupported_file_type', 'nope'), 415],
    ['an exhausted spend limit', new AgentSpendLimitError('daily limit used up'), 429],
    ['an unknown model', new Error('Model "x" not found'), 409],
    ['a missing session', new Error('Session "s" not found'), 404],
  ])('%s is a warning without a stack', (_label, error, status) => {
    const classified = logAgentRouteError(log, 'boom', error);
    expect(classified.status).toBe(status);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![1]).toMatchObject({ status, reason: expect.any(String) });
    expect(log.warn.mock.calls[0]![1]).not.toHaveProperty('error');
  });

  it('a server fault stays an error with the error object (and its stack)', () => {
    const failure = new Error('kaboom');
    const classified = logAgentRouteError(log, 'boom', failure, { agentKey: 'support' });
    expect(classified.status).toBeGreaterThanOrEqual(500);
    expect(log.error).toHaveBeenCalledWith('boom', { error: failure, agentKey: 'support' });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
