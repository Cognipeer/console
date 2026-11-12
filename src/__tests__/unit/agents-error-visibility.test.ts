/**
 * Who reads the raw message of an unrecognized agent-run failure: a tenant
 * owner/admin or an admin on the Agents service, never anyone else, and never a
 * request authenticated with an API token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

const serviceActionAllowedForRequest = vi.fn();
vi.mock('@/server/api/fastify-utils', () => ({
  serviceActionAllowedForRequest: (...args: unknown[]) => serviceActionAllowedForRequest(...args),
}));

import { canSeeRawProviderErrors } from '@/server/api/plugins/agents/agentsErrorVisibility';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';

const request = (extra: Record<string, unknown> = {}) => ({ ...extra }) as unknown as FastifyRequest;

/** What a route puts in the response for a failure the classifier does not recognize. */
async function messageFor(req: FastifyRequest, error: Error): Promise<string> {
  return classifyAgentRunError(error, { exposeInternal: await canSeeRawProviderErrors(req) }).error.message;
}

describe('canSeeRawProviderErrors', () => {
  beforeEach(() => {
    serviceActionAllowedForRequest.mockReset();
    serviceActionAllowedForRequest.mockResolvedValue(false);
  });

  it('is true for a tenant owner or admin without asking the policy engine', async () => {
    expect(await canSeeRawProviderErrors(request({ rbacUser: { role: 'owner' } }))).toBe(true);
    expect(await canSeeRawProviderErrors(request({ apiContextHeaders: { 'x-user-role': 'admin' } }))).toBe(true);
    expect(serviceActionAllowedForRequest).not.toHaveBeenCalled();
  });

  it('is true for a member holding admin on the agents service', async () => {
    serviceActionAllowedForRequest.mockResolvedValue(true);
    expect(await canSeeRawProviderErrors(request({ rbacUser: { role: 'member' } }))).toBe(true);
    expect(serviceActionAllowedForRequest).toHaveBeenCalledWith(expect.anything(), 'agents', 'admin');
  });

  it('is false for a member without that right', async () => {
    expect(await canSeeRawProviderErrors(request({ rbacUser: { role: 'member' } }))).toBe(false);
  });

  it('is false for an API-token request, whoever owns the token', async () => {
    expect(await canSeeRawProviderErrors(request({ apiTokenContext: { tenantId: 't' }, rbacUser: { role: 'owner' } }))).toBe(false);
    expect(serviceActionAllowedForRequest).not.toHaveBeenCalled();
  });

  it('is false when the policy engine cannot decide', async () => {
    serviceActionAllowedForRequest.mockRejectedValue(new Error('engine down'));
    expect(await canSeeRawProviderErrors(request({ rbacUser: { role: 'member' } }))).toBe(false);
  });

  it('leaves the request decision state as it found it', async () => {
    const req = request({ rbacUser: { role: 'member' } }) as FastifyRequest & { iamDenial?: unknown; iamDecisionId?: string };
    serviceActionAllowedForRequest.mockImplementation(async (r: typeof req) => {
      r.iamDecisionId = 'dec-visibility';
      r.iamDenial = { code: 'authorization_unavailable' };
      throw new Error('engine down');
    });
    expect(await canSeeRawProviderErrors(req)).toBe(false);
    expect(req.iamDecisionId).toBeUndefined();
    expect(req.iamDenial).toBeUndefined();
  });
});

const GENERIC = 'The agent run failed.';

describe('the message a viewer reads', () => {
  const failure = new Error('Cannot read properties of undefined (reading "foo") using key sk-proj-abcdefghijklmnopqrstuv');

  beforeEach(() => {
    serviceActionAllowedForRequest.mockReset();
    serviceActionAllowedForRequest.mockResolvedValue(false);
  });

  it('is the generic line for a viewer without the right', async () => {
    expect(await messageFor(request({ rbacUser: { role: 'member' } }), failure)).toBe(GENERIC);
  });

  it('is the raw message, secrets redacted, for an admin', async () => {
    const message = await messageFor(request({ rbacUser: { role: 'admin' } }), failure);
    expect(message).toContain('reading "foo"');
    expect(message).not.toContain('sk-proj-abcdefghijklmnopqrstuv');
  });

  it('stays generic on the client API', async () => {
    expect(await messageFor(request({ apiTokenContext: { tenantId: 't' }, rbacUser: { role: 'admin' } }), failure)).toBe(GENERIC);
  });
});
