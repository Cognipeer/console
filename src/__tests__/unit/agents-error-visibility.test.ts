/**
 * Who reads the raw message of an unrecognized agent-run failure: a tenant
 * owner/admin or an admin on the Agents service, never anyone else, and never a
 * request authenticated with an API token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest } from 'fastify';

const authorizeServiceForRequest = vi.fn();
vi.mock('@/server/api/fastify-utils', () => ({
  authorizeServiceForRequest: (...args: unknown[]) => authorizeServiceForRequest(...args),
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
    authorizeServiceForRequest.mockReset();
    authorizeServiceForRequest.mockResolvedValue({ allowed: false });
  });

  it('is true for a tenant owner or admin without asking the policy engine', async () => {
    expect(await canSeeRawProviderErrors(request({ rbacUser: { role: 'owner' } }))).toBe(true);
    expect(await canSeeRawProviderErrors(request({ apiContextHeaders: { 'x-user-role': 'admin' } }))).toBe(true);
    expect(authorizeServiceForRequest).not.toHaveBeenCalled();
  });

  it('is true for a member holding admin on the agents service', async () => {
    authorizeServiceForRequest.mockResolvedValue({ allowed: true });
    expect(await canSeeRawProviderErrors(request({ rbacUser: { role: 'member' } }))).toBe(true);
    expect(authorizeServiceForRequest).toHaveBeenCalledWith(expect.anything(), 'agents', { level: 'admin' });
  });

  it('is false for a member without that right', async () => {
    expect(await canSeeRawProviderErrors(request({ rbacUser: { role: 'member' } }))).toBe(false);
  });

  it('is false for an API-token request, whoever owns the token', async () => {
    expect(await canSeeRawProviderErrors(request({ apiTokenContext: { tenantId: 't' }, rbacUser: { role: 'owner' } }))).toBe(false);
    expect(authorizeServiceForRequest).not.toHaveBeenCalled();
  });

  it('is false when the policy engine cannot decide', async () => {
    authorizeServiceForRequest.mockRejectedValue(new Error('engine down'));
    expect(await canSeeRawProviderErrors(request({ rbacUser: { role: 'member' } }))).toBe(false);
  });
});

const GENERIC = 'The agent run failed.';

describe('the message a viewer reads', () => {
  const failure = new Error('Cannot read properties of undefined (reading "foo") using key sk-proj-abcdefghijklmnopqrstuv');

  beforeEach(() => {
    authorizeServiceForRequest.mockReset();
    authorizeServiceForRequest.mockResolvedValue({ allowed: false });
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
