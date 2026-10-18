/**
 * Executing a Tools-service action through the dashboard:
 * an argument the action cannot take (a missing or invalid path parameter) is
 * reported as a request error and never reaches the upstream, while a failure
 * of the call itself keeps its status.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

const hoisted = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock('@/lib/security/outboundFetch', () => ({ safeFetch: hoisted.safeFetch }));

vi.mock('@/lib/services/tools', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/tools')>()),
  getTool: vi.fn(),
  getToolByKey: vi.fn(),
  logToolRequest: vi.fn(),
}));

vi.mock('@/server/api/fastify-utils', async (importActual) => ({
  ...(await importActual<typeof import('@/server/api/fastify-utils')>()),
  withApiRequestContext: (handler: (request: FastifyRequest, reply: FastifyReply) => unknown) =>
    async (request: FastifyRequest, reply: FastifyReply) => handler(request, reply),
  withClientApiRequestContext: (handler: (request: FastifyRequest, reply: FastifyReply, auth: unknown) => unknown) =>
    async (request: FastifyRequest, reply: FastifyReply) => handler(request, reply, {}),
  requireProjectContextForRequest: vi.fn(async () => ({
    projectId: 'proj-1',
    user: { role: 'owner' },
    session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
  })),
  getApiTokenContextForRequest: vi.fn(async () => ({
    tenantDbName: 'tenant_acme',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    tokenRecord: { _id: 'tok-1' },
  })),
}));

import type { ITool } from '@/lib/database';
import { getTool, getToolByKey, logToolRequest, parseOpenApiToActions } from '@/lib/services/tools';
import { toolsApiPlugin } from '@/server/api/plugins/tools';

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Upstream', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
});

function buildTool(): ITool {
  const parsed = parseOpenApiToActions(SPEC);
  return {
    _id: 'tool-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    key: 'upstream',
    name: 'Upstream',
    type: 'openapi',
    status: 'active',
    actions: parsed.actions,
    openApiSpec: parsed.normalizedSpec,
    upstreamBaseUrl: parsed.baseUrl,
    upstreamAuth: { type: 'token', token: 'upstream-token-123456' },
    createdBy: 'user-1',
  } as ITool;
}

describe('executing a tool action', () => {
  let app: FastifyInstance;
  let tool: ITool;
  let actionKey: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tool = buildTool();
    actionKey = tool.actions[0].key;
    vi.mocked(getTool).mockResolvedValue(tool);
    vi.mocked(getToolByKey).mockResolvedValue(tool);
    hoisted.safeFetch.mockImplementation(async () => new Response(JSON.stringify({ id: 'u-1' }), {
      headers: { 'content-type': 'application/json' },
    }));
    app = Fastify({ logger: false });
    await app.register(toolsApiPlugin, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
  });

  const dashboard = (args: unknown) => app.inject({
    method: 'POST',
    url: `/api/tools/tool-1/actions/${actionKey}/execute`,
    payload: { arguments: args },
  });
  describe('from the dashboard', () => {
    it('answers an invalid path argument with 400 and the reason, without calling the upstream', async () => {
      const response = await dashboard({ id: '..' });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'Invalid value for path parameter "id"' });
      expect(hoisted.safeFetch).not.toHaveBeenCalled();
    });

    it('answers a missing path argument with 400', async () => {
      const response = await dashboard({});
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(/path parameter "id"/i);
    });

    it('still logs the refused call as an error', async () => {
      await dashboard({ id: '%2e%2e' });
      expect(logToolRequest).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logToolRequest).mock.calls[0][6]).toBe('error');
    });

    it('serves a valid call', async () => {
      const response = await dashboard({ id: 'u-1' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).result).toEqual({ id: 'u-1' });
      expect(hoisted.safeFetch.mock.calls[0][0]).toBe('https://api.example.com/v1/users/u-1');
    });

    it('keeps 500 for a call that failed on its way to the upstream', async () => {
      hoisted.safeFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      const response = await dashboard({ id: 'u-1' });
      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body).error).toContain('ECONNREFUSED');
    });
  });
});
