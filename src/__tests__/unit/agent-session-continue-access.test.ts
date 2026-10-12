/**
 * `decideSessionAccess`, the one place that answers "may this person touch somebody else's session":
 *
 *   view      asks `agent.session_view_others`
 *   manage    asks `agent.session_manage_others`
 *   continue  asks `agent.session_manage_others`, then `agent.session_view_others` - a new turn is answered by a
 *             model that has read the whole session, and the answer goes back to the sender
 *
 * The person who started the session is never asked. Whatever the engine cannot decide is a 503, never an allow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

const hoisted = vi.hoisted(() => ({ authorize: vi.fn() }));

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return { ...actual, authorizeResourceForRequest: hoisted.authorize };
});

import { RbacAuthorizationError } from '@/server/api/fastify-utils';
import { decideSessionAccess, type SessionNeed } from '@/server/api/plugins/agent-session-access';

const request = {} as FastifyRequest;
const conversation = { agentKey: 'support', projectId: 'p1', createdBy: 'starter' };
const actor = { tenantDbName: 'tenant_x', projectId: 'p1', userId: 'other' };
const agent = { _id: 'agent-1', key: 'support' };

/** The engine answers per action; anything unlisted is allowed. */
function engine(answers: Record<string, 'allow' | 'deny' | 'down'>) {
  hoisted.authorize.mockImplementation(async (_req: unknown, input: { action: string }) => {
    const answer = answers[input.action] ?? 'allow';
    if (answer === 'down') {
      throw new RbacAuthorizationError('authorization unavailable', 503, { decisionId: 'dec-down', code: 'authorization_unavailable' });
    }
    return answer === 'allow' ? { allowed: true } : { allowed: false, decisionId: `dec-${input.action}` };
  });
}
const decide = (need: SessionNeed, createdBy = conversation.createdBy) =>
  decideSessionAccess(request, { ...conversation, createdBy }, { need, agent, actor });
const asked = () => hoisted.authorize.mock.calls.map(([, input]) => (input as { action: string }).action);

beforeEach(() => {
  hoisted.authorize.mockReset();
  engine({});
});

describe('decideSessionAccess', () => {
  it('asks the person who did not start the session for the action of the need, and nothing else', async () => {
    await expect(decide('view')).resolves.toMatchObject({ ok: true, owner: false });
    expect(asked()).toEqual(['agent.session_view_others']);
    hoisted.authorize.mockClear();
    await expect(decide('manage')).resolves.toMatchObject({ ok: true, owner: false });
    expect(asked()).toEqual(['agent.session_manage_others']);
  });

  it('never asks the person who started it', async () => {
    for (const need of ['view', 'manage', 'continue'] as const) {
      await expect(decide(need, 'other')).resolves.toMatchObject({ ok: true, owner: true });
    }
    expect(hoisted.authorize).not.toHaveBeenCalled();
  });

  describe('continue', () => {
    it('is granted only when both actions are', async () => {
      await expect(decide('continue')).resolves.toMatchObject({ ok: true });
      expect(asked()).toEqual(['agent.session_manage_others', 'agent.session_view_others']);
    });

    it('is refused as VIEWING when a rule stops viewing, though changing is allowed - the content would come back in the reply', async () => {
      engine({ 'agent.session_view_others': 'deny' });
      await expect(decide('continue')).resolves.toMatchObject({ ok: false, status: 403, reason: 'forbidden', need: 'view', decisionId: 'dec-agent.session_view_others' });
    });

    it('is refused as CHANGING when a rule stops changing, without asking about viewing', async () => {
      engine({ 'agent.session_manage_others': 'deny' });
      await expect(decide('continue')).resolves.toMatchObject({ ok: false, status: 403, need: 'manage', decisionId: 'dec-agent.session_manage_others' });
      expect(asked()).toEqual(['agent.session_manage_others']);
    });

    it('is a 503 when the engine cannot decide either half - never an allow', async () => {
      engine({ 'agent.session_view_others': 'down' });
      await expect(decide('continue')).resolves.toMatchObject({ ok: false, status: 503, reason: 'unavailable', need: 'view' });
      engine({ 'agent.session_manage_others': 'down' });
      await expect(decide('continue')).resolves.toMatchObject({ ok: false, status: 503, reason: 'unavailable', need: 'manage' });
    });
  });

  it('the other changes (manage) stay independent of viewing: a rule that stops viewing does not stop them', async () => {
    engine({ 'agent.session_view_others': 'deny' });
    await expect(decide('manage')).resolves.toMatchObject({ ok: true });
    expect(asked()).toEqual(['agent.session_manage_others']);
  });

  it('reading stays independent of changing', async () => {
    engine({ 'agent.session_manage_others': 'deny' });
    await expect(decide('view')).resolves.toMatchObject({ ok: true });
  });
});
