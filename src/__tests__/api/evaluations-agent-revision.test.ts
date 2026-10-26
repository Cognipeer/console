/**
 * The HTTP contract of agent test revisions on the Evaluation API: a target's
 * default revision (create / patch) and a run's own override, on the dashboard
 * routes and on the client API, plus the rule that testing an agent (or saving
 * a target that points at one) takes write access to Agents, and that a PATCH
 * names only the fields it changes. The service layer is mocked (the
 * integration tests cover it); what is covered here is parsing, who is asked
 * and the status codes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => {
  class AgentRevisionError extends Error {}
  return {
    AgentRevisionError,
    db: null as unknown as ReturnType<typeof createMockDb>,
    createTarget: vi.fn(),
    updateTarget: vi.fn(),
    getTarget: vi.fn(),
    updateSuite: vi.fn(),
    runSuite: vi.fn(),
    runRowWritten: vi.fn(),
    authorizeServiceForRequest: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(),
    listSuites: vi.fn(),
    enqueueSuiteRun: vi.fn(),
    requireProjectContextForRequest: vi.fn(),
    requireSessionContext: vi.fn(),
  };
});

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    requireProjectContextForRequest: h.requireProjectContextForRequest,
    requireSessionContext: h.requireSessionContext,
    authorizeServiceForRequest: h.authorizeServiceForRequest,
    withClientApiRequestContext: (handler: (...args: unknown[]) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply),
    getApiTokenContextForRequest: async () => ({
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      tokenRecord: { userId: 'user-1' },
    }),
  };
});
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/agents/agentRevision', () => ({ AgentRevisionError: h.AgentRevisionError }));
vi.mock('@/lib/services/evaluation/service', () => ({
  createTarget: h.createTarget,
  updateTarget: h.updateTarget,
  getTarget: h.getTarget,
  updateSuite: h.updateSuite,
  runSuite: h.runSuite,
  getRun: h.getRun,
  listRuns: h.listRuns,
  listSuites: h.listSuites,
}));
vi.mock('@/lib/services/evaluation/evaluationRunJob', () => ({ enqueueSuiteRun: h.enqueueSuiteRun }));

import { RbacAuthorizationError } from '@/server/api/fastify-utils';
import { evaluationsApiPlugin } from '@/server/api/plugins/evaluations';
import { clientEvaluationsApiPlugin } from '@/server/api/plugins/client-evaluations';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const headers = {
  'x-license-type': 'ENTERPRISE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-user-id': 'user-1',
  'content-type': 'application/json',
};
const SESSION = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' };
const NEW_AGENT_TARGET = { name: 'Bot', kind: 'agent', agentKey: 'bot' };
const ALLOWED = { allowed: true, service: 'agents', required: 'write' };
const REFUSED = { allowed: false, service: 'agents', required: 'write', decisionId: 'dec-1' };

/**
 * Stands in for the service's `createPendingRun`: it asks the hook only once the
 * suite's target is an agent, and writes the run row after that, as the real one does.
 */
function serviceStartsRun(kind: 'agent' | 'model') {
  return async (params: { authorizeAgentRun?: () => Promise<void> }) => {
    if (kind === 'agent') await params.authorizeAgentRun?.();
    h.runRowWritten();
    return { id: 'run-1', status: 'pending' };
  };
}

describe('agent revisions on the Evaluation API', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let clientApp: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  // `payload` undefined sends no body at all, like an existing caller.
  const send = (
    target: typeof app,
    method: 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
  ) => target.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset, not just cleared: a queued once-value must not leak into the next test.
    h.authorizeServiceForRequest.mockReset();
    h.enqueueSuiteRun.mockReset();
    h.runSuite.mockReset();
    h.db = createMockDb();
    h.db.findUserById.mockResolvedValue({ _id: 'user-1', role: 'owner', tenantId: 'tenant-1' } as never);
    h.requireProjectContextForRequest.mockResolvedValue({ projectId: 'proj-1', session: SESSION });
    h.requireSessionContext.mockReturnValue(SESSION);
    h.createTarget.mockImplementation(async (_db, _tenant, _user, input) => ({ id: 't-1', key: 'bot', ...input }));
    h.updateTarget.mockImplementation(async (_db, id, _user, data) => ({ id, ...data }));
    h.updateSuite.mockImplementation(async (_db, id, _user, data) => ({ id, ...data }));
    h.getTarget.mockResolvedValue({ id: 't-1', key: 'bot', kind: 'agent', agentKey: 'bot' });
    h.authorizeServiceForRequest.mockResolvedValue(ALLOWED);
    h.enqueueSuiteRun.mockImplementation(serviceStartsRun('agent'));
    h.runSuite.mockImplementation(async (params: { authorizeAgentRun?: () => Promise<void> }) => {
      await params.authorizeAgentRun?.();
      h.runRowWritten();
      return {
        id: 'run-1',
        suiteKey: 'smoke',
        targetKey: 'bot',
        datasetKey: 'ds',
        status: 'completed',
        items: [],
        agentRevision: { requested: 'published', version: 2 },
      };
    });
    app = await createFastifyApiTestApp(evaluationsApiPlugin, { rawJsonBody: true });
    clientApp = await createFastifyApiTestApp(clientEvaluationsApiPlugin, { rawJsonBody: true });
  });

  describe('POST /api/evaluation/targets', () => {
    it.each([
      ['draft', 'draft'],
      [3, 3],
      ['3', 3],
      [null, null],
      ['published', null],
    ])('stores agentVersion %j as %j', async (sent, stored) => {
      const res = await send(app, 'POST', '/api/evaluation/targets', { ...NEW_AGENT_TARGET, agentVersion: sent });
      expect(res.statusCode).toBe(201);
      expect(h.createTarget.mock.calls[0][3].agentVersion).toBe(stored);
    });

    it('leaves the default out when none is sent', async () => {
      const res = await send(app, 'POST', '/api/evaluation/targets', NEW_AGENT_TARGET);
      expect(res.statusCode).toBe(201);
      expect(h.createTarget.mock.calls[0][3].agentVersion).toBeUndefined();
    });

    it.each([0, -1, 1.5, 'abc', true, {}])('refuses agentVersion %j', async (sent) => {
      const res = await send(app, 'POST', '/api/evaluation/targets', { ...NEW_AGENT_TARGET, agentVersion: sent });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/agentVersion/);
      expect(h.createTarget).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/evaluation/targets/:id', () => {
    it('does not pass the key when the body leaves it out', async () => {
      const res = await send(app, 'PATCH', '/api/evaluation/targets/t-1', { name: 'Renamed' });
      expect(res.statusCode).toBe(200);
      expect(h.updateTarget.mock.calls[0][3]).not.toHaveProperty('agentVersion');
    });

    it('passes null to clear the pin', async () => {
      await send(app, 'PATCH', '/api/evaluation/targets/t-1', { agentVersion: null });
      expect(h.updateTarget.mock.calls[0][3]).toHaveProperty('agentVersion', null);
    });

    it('passes the draft and a version', async () => {
      await send(app, 'PATCH', '/api/evaluation/targets/t-1', { agentVersion: 'draft' });
      await send(app, 'PATCH', '/api/evaluation/targets/t-1', { agentVersion: 5 });
      expect(h.updateTarget.mock.calls[0][3].agentVersion).toBe('draft');
      expect(h.updateTarget.mock.calls[1][3].agentVersion).toBe(5);
    });

    it('refuses a value it cannot read instead of unpinning', async () => {
      const res = await send(app, 'PATCH', '/api/evaluation/targets/t-1', { agentVersion: 0 });
      expect(res.statusCode).toBe(400);
      expect(h.updateTarget).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/evaluation/suites/:key/run', () => {
    it('runs with no body, as existing callers do', async () => {
      const res = await send(app, 'POST', '/api/evaluation/suites/smoke/run');
      expect(res.statusCode).toBe(202);
      expect(h.enqueueSuiteRun.mock.calls[0][0].agentVersion).toBeUndefined();
      expect(h.enqueueSuiteRun.mock.calls[0][0]).toMatchObject({ suiteKey: 'smoke', projectId: 'proj-1' });
    });

    it('passes the draft', async () => {
      const res = await send(app, 'POST', '/api/evaluation/suites/smoke/run', { agentVersion: 'draft' });
      expect(res.statusCode).toBe(202);
      expect(h.enqueueSuiteRun.mock.calls[0][0].agentVersion).toBe('draft');
    });

    it('reads a version sent as digits', async () => {
      await send(app, 'POST', '/api/evaluation/suites/smoke/run', { agentVersion: '7' });
      expect(h.enqueueSuiteRun.mock.calls[0][0].agentVersion).toBe(7);
    });

    it('reads agentVersion: null as no override, so the target default applies', async () => {
      const res = await send(app, 'POST', '/api/evaluation/suites/smoke/run', { agentVersion: null });
      expect(res.statusCode).toBe(202);
      expect(h.enqueueSuiteRun.mock.calls[0][0].agentVersion).toBeUndefined();
    });

    it('refuses a value it cannot read before queueing anything', async () => {
      const res = await send(app, 'POST', '/api/evaluation/suites/smoke/run', { agentVersion: 'latest' });
      expect(res.statusCode).toBe(400);
      expect(h.enqueueSuiteRun).not.toHaveBeenCalled();
    });

    it('answers 400 when the service cannot honour the revision', async () => {
      h.enqueueSuiteRun.mockRejectedValueOnce(new h.AgentRevisionError('Evaluation target "m" is not an agent target'));
      const res = await send(app, 'POST', '/api/evaluation/suites/smoke/run', { agentVersion: 'draft' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not an agent target/);
    });

    it('refuses a body it cannot read instead of running the default', async () => {
      // Raw, as a hand-quoted CI step might send it: unquoted keys, a bare string, an array.
      for (const payload of ['{agentVersion:draft}', '"draft"', '[]']) {
        const res = await app.inject({ method: 'POST', url: '/api/evaluation/suites/smoke/run', headers, payload });
        expect(res.statusCode).toBe(400);
      }
      expect(h.enqueueSuiteRun).not.toHaveBeenCalled();
    });

    it('reads an empty object or a literal null as no body', async () => {
      for (const payload of ['{}', 'null', '  ']) {
        const res = await app.inject({ method: 'POST', url: '/api/evaluation/suites/smoke/run', headers, payload });
        expect(res.statusCode).toBe(202);
      }
      expect(h.enqueueSuiteRun.mock.calls.map((call) => call[0].agentVersion)).toEqual([undefined, undefined, undefined]);
    });

    it('keeps answering 404 for a missing version and 409 for a run in progress', async () => {
      h.enqueueSuiteRun.mockRejectedValueOnce(new Error('Version 9 not found for agent "bot"'));
      expect((await send(app, 'POST', '/api/evaluation/suites/smoke/run', { agentVersion: 9 })).statusCode).toBe(404);
      h.enqueueSuiteRun.mockRejectedValueOnce(new Error('A run for suite "smoke" is already in progress on draft'));
      expect((await send(app, 'POST', '/api/evaluation/suites/smoke/run', { agentVersion: 'draft' })).statusCode).toBe(409);
    });
  });

  describe('POST /api/client/v1/evaluation/suites/:key/run', () => {
    const url = '/api/client/v1/evaluation/suites/smoke/run';

    it('runs with no body and reports the revision that answered', async () => {
      const res = await send(clientApp, 'POST', url);
      expect(res.statusCode).toBe(201);
      expect(h.runSuite.mock.calls[0][0].agentVersion).toBeUndefined();
      expect(res.json().run.agent_revision).toEqual({ requested: 'published', version: 2 });
    });

    it('reads agent_version', async () => {
      const published = await send(clientApp, 'POST', url, { agent_version: 'published' });
      expect(published.statusCode).toBe(201);
      expect(h.runSuite.mock.calls[0][0].agentVersion).toBe('published');
      await send(clientApp, 'POST', url, { agent_version: 'draft' });
      await send(clientApp, 'POST', url, { agent_version: '4' });
      expect(h.runSuite.mock.calls[1][0].agentVersion).toBe('draft');
      expect(h.runSuite.mock.calls[2][0].agentVersion).toBe(4);
    });

    it('reads agent_version: null as no override', async () => {
      const res = await send(clientApp, 'POST', url, { agent_version: null });
      expect(res.statusCode).toBe(201);
      expect(h.runSuite.mock.calls[0][0].agentVersion).toBeUndefined();
    });

    it('refuses a body it cannot read before running anything', async () => {
      const res = await clientApp.inject({ method: 'POST', url, headers, payload: '{agent_version: draft}' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/JSON object/);
      expect(h.runSuite).not.toHaveBeenCalled();
    });

    it('refuses a value it cannot read and names the field', async () => {
      const res = await send(clientApp, 'POST', url, { agent_version: 'newest' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/agent_version/);
      expect(h.runSuite).not.toHaveBeenCalled();
    });

    it('answers 400 when the service cannot honour the revision', async () => {
      h.runSuite.mockRejectedValueOnce(new h.AgentRevisionError('not an agent target'));
      const res = await send(clientApp, 'POST', url, { agent_version: 'draft' });
      expect(res.statusCode).toBe(400);
    });

    it('answers 409 when the same revision of the suite is already running', async () => {
      h.runSuite.mockRejectedValueOnce(new Error('A run for suite "smoke" is already in progress on draft'));
      const res = await send(clientApp, 'POST', url, { agent_version: 'draft' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/already in progress on draft/);
    });
  });

  describe('who may test an agent', () => {
    const runUrl = '/api/evaluation/suites/smoke/run';
    const clientRunUrl = '/api/client/v1/evaluation/suites/smoke/run';
    const refusal = (message: string, status = 403, headers?: Record<string, string>) =>
      new RbacAuthorizationError(
        message,
        status,
        { error: message, code: status === 503 ? 'authorization_unavailable' : 'forbidden', service: 'agents', required: 'write', decisionId: 'dec-2' },
        headers,
      );

    describe('running a suite on the dashboard', () => {
      it('asks for write access to Agents once the suite turns out to target an agent', async () => {
        const res = await send(app, 'POST', runUrl);
        expect(res.statusCode).toBe(202);
        expect(h.authorizeServiceForRequest).toHaveBeenCalledTimes(1);
        expect(h.authorizeServiceForRequest).toHaveBeenCalledWith(expect.anything(), 'agents', { level: 'write' });
        expect(h.runRowWritten).toHaveBeenCalledTimes(1);
      });

      it.each([undefined, 'published', 'draft', 4])('refuses a run of revision %j without it, and writes no run row', async (revision) => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        const res = await send(app, 'POST', runUrl, revision === undefined ? undefined : { agentVersion: revision });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'forbidden', service: 'agents', required: 'write', decisionId: 'dec-1' });
        expect(h.runRowWritten).not.toHaveBeenCalled();
      });

      it('does not ask about Agents when the suite targets a model', async () => {
        h.enqueueSuiteRun.mockImplementation(serviceStartsRun('model'));
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED); // it would refuse, were it asked
        const res = await send(app, 'POST', runUrl);
        expect(res.statusCode).toBe(202);
        expect(h.authorizeServiceForRequest).not.toHaveBeenCalled();
        expect(h.runRowWritten).toHaveBeenCalledTimes(1);
      });

      it('answers a bad body and an unknown suite before asking about Agents', async () => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        expect((await send(app, 'POST', runUrl, { agentVersion: 'latest' })).statusCode).toBe(400);
        h.enqueueSuiteRun.mockRejectedValueOnce(new Error('Evaluation suite "nope" not found'));
        expect((await send(app, 'POST', '/api/evaluation/suites/nope/run')).statusCode).toBe(404);
        expect(h.authorizeServiceForRequest).not.toHaveBeenCalled();
      });

      it('never reads a refusal as a 404 or a 409, whatever its message says', async () => {
        for (const message of ['agents service not found', 'a run is already in progress']) {
          h.authorizeServiceForRequest.mockRejectedValueOnce(refusal(message));
          const res = await send(app, 'POST', runUrl);
          expect(res.statusCode).toBe(403);
          expect(res.json()).toMatchObject({ error: message, decisionId: 'dec-2' });
        }
        expect(h.runRowWritten).not.toHaveBeenCalled();
      });

      it('answers the 503 with Retry-After when the engine cannot decide, and writes no run row', async () => {
        h.authorizeServiceForRequest.mockRejectedValueOnce(refusal('Authorization is temporarily unavailable', 503, { 'Retry-After': '5' }));
        const res = await send(app, 'POST', runUrl);
        expect(res.statusCode).toBe(503);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.json()).toMatchObject({ code: 'authorization_unavailable' });
        expect(h.runRowWritten).not.toHaveBeenCalled();
      });
    });

    describe('running a suite with a token', () => {
      it('refuses an agent suite when the token owner lacks Agents write, and writes no run row', async () => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        const res = await send(clientApp, 'POST', clientRunUrl, { agent_version: 'draft' });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'forbidden', service: 'agents', required: 'write', decisionId: 'dec-1' });
        expect(h.authorizeServiceForRequest).toHaveBeenCalledWith(expect.anything(), 'agents', { level: 'write' });
        expect(h.runRowWritten).not.toHaveBeenCalled();
      });

      it('runs an agent suite when it is allowed', async () => {
        const res = await send(clientApp, 'POST', clientRunUrl);
        expect(res.statusCode).toBe(201);
        expect(h.runRowWritten).toHaveBeenCalledTimes(1);
      });

      it('does not ask about Agents when the suite targets a model', async () => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        h.runSuite.mockImplementationOnce(async () => {
          h.runRowWritten();
          return { id: 'run-2', suiteKey: 'smoke', targetKey: 'm', datasetKey: 'ds', status: 'completed', items: [] };
        });
        const res = await send(clientApp, 'POST', clientRunUrl);
        expect(res.statusCode).toBe(201);
        expect(h.authorizeServiceForRequest).not.toHaveBeenCalled();
      });

      it('never reads a refusal as a 404, and answers the 503 with Retry-After', async () => {
        h.authorizeServiceForRequest.mockRejectedValueOnce(refusal('agents service not found'));
        const refused = await send(clientApp, 'POST', clientRunUrl);
        expect(refused.statusCode).toBe(403);
        h.authorizeServiceForRequest.mockRejectedValueOnce(refusal('Authorization is temporarily unavailable', 503, { 'Retry-After': '5' }));
        const unavailable = await send(clientApp, 'POST', clientRunUrl);
        expect(unavailable.statusCode).toBe(503);
        expect(unavailable.headers['retry-after']).toBe('5');
        expect(h.runRowWritten).not.toHaveBeenCalled();
      });

      it('keeps answering 404 for an unknown suite without asking about Agents', async () => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        h.runSuite.mockRejectedValueOnce(new Error('Evaluation suite "smoke" not found'));
        const res = await send(clientApp, 'POST', clientRunUrl);
        expect(res.statusCode).toBe(404);
        expect(h.authorizeServiceForRequest).not.toHaveBeenCalled();
      });
    });

    describe('saving a target', () => {
      it('refuses to create an agent target without Agents write', async () => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        const res = await send(app, 'POST', '/api/evaluation/targets', NEW_AGENT_TARGET);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'forbidden', service: 'agents', required: 'write', decisionId: 'dec-1' });
        expect(h.createTarget).not.toHaveBeenCalled();
      });

      it('creates an agent target when it is allowed', async () => {
        const res = await send(app, 'POST', '/api/evaluation/targets', NEW_AGENT_TARGET);
        expect(res.statusCode).toBe(201);
        expect(h.authorizeServiceForRequest).toHaveBeenCalledWith(expect.anything(), 'agents', { level: 'write' });
        expect(h.createTarget).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['model', { name: 'M', kind: 'model', modelKey: 'gpt' }],
        ['rag', { name: 'K', kind: 'rag', ragModuleKey: 'kb' }],
        ['external', { name: 'X', kind: 'external', external: { protocol: 'webhook', url: 'https://example.test/hook' } }],
      ])('does not ask for a %s target', async (_kind, body) => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED); // it would refuse, were it asked
        const res = await send(app, 'POST', '/api/evaluation/targets', body);
        expect(res.statusCode).toBe(201);
        expect(h.authorizeServiceForRequest).not.toHaveBeenCalled();
      });

      it('answers a malformed body with 400 before asking about Agents', async () => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        expect((await send(app, 'POST', '/api/evaluation/targets', { ...NEW_AGENT_TARGET, agentVersion: 'newest' })).statusCode).toBe(400);
        expect((await send(app, 'POST', '/api/evaluation/targets', { name: 'Bot', kind: 'agent' })).statusCode).toBe(400);
        expect(h.authorizeServiceForRequest).not.toHaveBeenCalled();
      });

      it('refuses to change a stored agent target without Agents write', async () => {
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        const res = await send(app, 'PATCH', '/api/evaluation/targets/t-1', { name: 'Renamed' });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'forbidden', service: 'agents', required: 'write' });
        expect(h.updateTarget).not.toHaveBeenCalled();
      });

      it('changes a stored agent target when it is allowed', async () => {
        const res = await send(app, 'PATCH', '/api/evaluation/targets/t-1', { name: 'Renamed' });
        expect(res.statusCode).toBe(200);
        expect(h.authorizeServiceForRequest).toHaveBeenCalledTimes(1);
        expect(h.updateTarget).toHaveBeenCalledTimes(1);
      });

      it('decides by the stored kind: a model target is changed without asking', async () => {
        h.getTarget.mockResolvedValue({ id: 't-2', key: 'm', kind: 'model' });
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED); // it would refuse, were it asked
        const res = await send(app, 'PATCH', '/api/evaluation/targets/t-2', { name: 'Renamed' });
        expect(res.statusCode).toBe(200);
        expect(h.authorizeServiceForRequest).not.toHaveBeenCalled();
        expect(h.updateTarget).toHaveBeenCalledTimes(1);
      });

      it('answers 404 for an unknown target without asking about Agents', async () => {
        h.getTarget.mockResolvedValue(null);
        h.authorizeServiceForRequest.mockResolvedValue(REFUSED);
        const res = await send(app, 'PATCH', '/api/evaluation/targets/t-9', { name: 'Renamed' });
        expect(res.statusCode).toBe(404);
        expect(h.authorizeServiceForRequest).not.toHaveBeenCalled();
        expect(h.updateTarget).not.toHaveBeenCalled();
      });
    });
  });

  describe('a PATCH names only what it changes', () => {
    const NOT_TEXT = [
      ['an empty name', { name: '' }, /name/],
      ['a blank name', { name: '   ' }, /name/],
      ['a number for the name', { name: 5 }, /name/],
      ['a null name', { name: null }, /name/],
      ['a null agentKey', { agentKey: null }, /agentKey/],
      ['an empty agentKey', { agentKey: '' }, /agentKey/],
      ['a number for the modelKey', { modelKey: 7 }, /modelKey/],
      ['an empty ragModuleKey', { ragModuleKey: '' }, /ragModuleKey/],
      ['a number for the description', { description: 5 }, /description/],
    ] as const;

    describe('targets', () => {
      const patch = (payload: unknown) => send(app, 'PATCH', '/api/evaluation/targets/t-1', payload);

      it('hands the service only the keys the body carries', async () => {
        const res = await patch({ name: 'Renamed' });
        expect(res.statusCode).toBe(200);
        expect(h.updateTarget.mock.calls[0][3]).toEqual({ name: 'Renamed' });
      });

      it('stores the name and the keys trimmed', async () => {
        await patch({ name: '  Bot 2 ', agentKey: ' bot ' });
        expect(h.updateTarget.mock.calls[0][3]).toEqual({ name: 'Bot 2', agentKey: 'bot' });
      });

      it('puts the default back on published when the target moves to another agent without a version', async () => {
        h.getTarget.mockResolvedValue({ id: 't-1', key: 'bot', kind: 'agent', agentKey: 'bot', agentVersion: 3 });
        await patch({ agentKey: 'other-bot' });
        expect(h.updateTarget.mock.calls[0][3]).toEqual({ agentKey: 'other-bot', agentVersion: null });
      });

      it('keeps the version sent with the new agent', async () => {
        h.getTarget.mockResolvedValue({ id: 't-1', key: 'bot', kind: 'agent', agentKey: 'bot', agentVersion: 3 });
        await patch({ agentKey: 'other-bot', agentVersion: 'draft' });
        expect(h.updateTarget.mock.calls[0][3]).toEqual({ agentKey: 'other-bot', agentVersion: 'draft' });
      });

      it('leaves the pin alone when the same agent is sent again', async () => {
        h.getTarget.mockResolvedValue({ id: 't-1', key: 'bot', kind: 'agent', agentKey: 'bot', agentVersion: 3 });
        await patch({ name: 'Bot', agentKey: 'bot' });
        expect(h.updateTarget.mock.calls[0][3]).toEqual({ name: 'Bot', agentKey: 'bot' });
      });

      it('passes what it is given for the optional knobs, and nothing for the ones it is not', async () => {
        await patch({ systemPrompt: 'Be brief', maxTokens: 256, responseFormat: { type: 'json_object' }, retrievalTopK: 5, retrievalMinScore: 0.4 });
        expect(h.updateTarget.mock.calls[0][3]).toEqual({
          systemPrompt: 'Be brief',
          maxTokens: 256,
          responseFormat: { type: 'json_object' },
          retrievalTopK: 5,
          retrievalMinScore: 0.4,
        });
      });

      it('clears an optional field when it is sent as null', async () => {
        const cleared = {
          description: null,
          systemPrompt: null,
          promptKey: null,
          promptVersion: null,
          responseFormat: null,
          maxTokens: null,
          defaultParams: null,
          retrievalTopK: null,
          retrievalMinScore: null,
          agentVersion: null,
        };
        const res = await patch(cleared);
        expect(res.statusCode).toBe(200);
        expect(h.updateTarget.mock.calls[0][3]).toEqual(cleared);
      });

      it('keeps an empty description as an empty description', async () => {
        await patch({ description: '' });
        expect(h.updateTarget.mock.calls[0][3]).toEqual({ description: '' });
      });

      it('leaves an out-of-range retrieval knob out of the update, as a create drops it', async () => {
        await patch({ name: 'Renamed', retrievalTopK: 0, retrievalMinScore: 2 });
        expect(h.updateTarget.mock.calls[0][3]).toEqual({ name: 'Renamed' });
      });

      it.each(NOT_TEXT)('refuses %s instead of storing it', async (_what, body, field) => {
        const res = await patch(body);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(field);
        expect(h.updateTarget).not.toHaveBeenCalled();
        expect(h.getTarget).not.toHaveBeenCalled();
      });
    });

    describe('suites', () => {
      const patch = (payload: unknown) => send(app, 'PATCH', '/api/evaluation/suites/s-1', payload);

      it('hands the service only the keys the body carries', async () => {
        const res = await patch({ name: 'Renamed' });
        expect(res.statusCode).toBe(200);
        expect(h.updateSuite.mock.calls[0][3]).toEqual({ name: 'Renamed' });
      });

      it('passes every field it is given', async () => {
        await patch({
          name: ' Nightly ',
          description: 'What it guards',
          targetKey: 'bot',
          datasetKey: 'ds',
          scorers: [{ type: 'assertion' }],
          judgeModelKey: 'judge',
          embeddingModelKey: 'embed',
          runConfig: { turnMode: 'perTurn' },
        });
        expect(h.updateSuite.mock.calls[0][3]).toEqual({
          name: 'Nightly',
          description: 'What it guards',
          targetKey: 'bot',
          datasetKey: 'ds',
          scorers: [{ type: 'assertion', weight: undefined, rubric: undefined, threshold: undefined, selectionWeight: undefined, sequenceWeight: undefined, argsWeight: undefined }],
          judgeModelKey: 'judge',
          embeddingModelKey: 'embed',
          runConfig: { turnMode: 'perTurn' },
        });
      });

      it('clears the description and the model keys when they are sent as null', async () => {
        const res = await patch({ description: null, judgeModelKey: null, embeddingModelKey: null });
        expect(res.statusCode).toBe(200);
        expect(h.updateSuite.mock.calls[0][3]).toEqual({ description: null, judgeModelKey: null, embeddingModelKey: null });
      });

      it('reads a blank model key as clearing it, and an empty description as empty', async () => {
        await patch({ judgeModelKey: '  ', embeddingModelKey: '', description: '' });
        expect(h.updateSuite.mock.calls[0][3]).toEqual({ judgeModelKey: null, embeddingModelKey: null, description: '' });
      });

      it('leaves runConfig out when nothing in it is usable', async () => {
        await patch({ name: 'Renamed', runConfig: { turnMode: 'sideways' } });
        expect(h.updateSuite.mock.calls[0][3]).toEqual({ name: 'Renamed' });
      });

      it.each([
        ...NOT_TEXT.filter(([, body]) => !('agentKey' in body) && !('modelKey' in body) && !('ragModuleKey' in body)),
        ['a null targetKey', { targetKey: null }, /targetKey/],
        ['an empty datasetKey', { datasetKey: '' }, /datasetKey/],
        ['a number for the judgeModelKey', { judgeModelKey: 3 }, /judgeModelKey/],
        ['a number for the embeddingModelKey', { embeddingModelKey: 3 }, /embeddingModelKey/],
      ] as const)('refuses %s instead of storing it', async (_what, body, field) => {
        const res = await patch(body);
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(field);
        expect(h.updateSuite).not.toHaveBeenCalled();
      });

      it('refuses scorers it cannot read instead of wiping them', async () => {
        const res = await patch({ scorers: 'assertion' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(/scorers/);
        expect(h.updateSuite).not.toHaveBeenCalled();
      });
    });
  });
});
