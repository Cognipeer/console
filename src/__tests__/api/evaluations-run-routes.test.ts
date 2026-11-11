/**
 * HTTP contract of the evaluation run surface: cancel, the paginated run list, the 409/400 mapping of typed service
 * errors, scorer and run-config sanitising, dataset item validation, generation limits, the label-start ordering and
 * the client API's `wait: false`. The service layer is mocked; parsing, status codes and call order are covered here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  listRunSummaries: vi.fn(),
  compareRuns: vi.fn(),
  deleteTarget: vi.fn(),
  deleteDataset: vi.fn(),
  deleteSuite: vi.fn(),
  getDataset: vi.fn(),
  createSuite: vi.fn(),
  createDataset: vi.fn(),
  appendDatasetItems: vi.fn(),
  updateDatasetItem: vi.fn(),
  getDatasetItem: vi.fn(),
  patchDatasetMetadata: vi.fn(),
  enqueueDefinitionRun: vi.fn(),
  enqueueDatasetGeneration: vi.fn(),
  enqueueSuiteRun: vi.fn(),
  runSuite: vi.fn(),
  enforceServiceQuota: vi.fn(),
  requireProjectContextForRequest: vi.fn(),
  requireSessionContext: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    requireProjectContextForRequest: h.requireProjectContextForRequest,
    requireSessionContext: h.requireSessionContext,
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
  getDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/quota/serviceQuota', () => ({
  enforceServiceQuota: h.enforceServiceQuota,
  isQuotaExceededError: () => false,
  quotaExceededBody: () => ({ error: 'quota' }),
}));
vi.mock('@/lib/services/agents/agentRevision', () => ({ AgentRevisionError: class AgentRevisionError extends Error {} }));
vi.mock('@/lib/services/rag/ragService', () => ({ convertFileToText: vi.fn() }));
vi.mock('@/lib/services/analysis/analysisRunJob', () => ({ enqueueDefinitionRun: h.enqueueDefinitionRun }));
vi.mock('@/lib/services/evaluation/datasetGenerationJob', () => ({ enqueueDatasetGeneration: h.enqueueDatasetGeneration }));
vi.mock('@/lib/services/evaluation/evaluationRunJob', () => ({ enqueueSuiteRun: h.enqueueSuiteRun }));
vi.mock('../../server/api/plugins/agent-test-permission', () => ({
  requireAgentTestAccess: vi.fn(async () => undefined),
  sendAgentTestRefusal: () => null,
}));
vi.mock('@/lib/services/evaluation/service', () => ({
  cancelRun: h.cancelRun,
  listRunSummaries: h.listRunSummaries,
  listRuns: h.listRuns,
  compareRuns: h.compareRuns,
  deleteTarget: h.deleteTarget,
  deleteDataset: h.deleteDataset,
  deleteSuite: h.deleteSuite,
  getDataset: h.getDataset,
  createSuite: h.createSuite,
  createDataset: h.createDataset,
  appendDatasetItems: h.appendDatasetItems,
  updateDatasetItem: h.updateDatasetItem,
  getDatasetItem: h.getDatasetItem,
  patchDatasetMetadata: h.patchDatasetMetadata,
  runSuite: h.runSuite,
}));

import { EvaluationConflictError, EvaluationInputError } from '@/lib/services/evaluation/errors';
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

describe('evaluation run routes', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let clientApp: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  const send = (
    target: typeof app,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => target.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });

  beforeEach(async () => {
    vi.resetAllMocks();
    h.requireProjectContextForRequest.mockResolvedValue({ projectId: 'proj-1', session: SESSION });
    h.requireSessionContext.mockReturnValue(SESSION);
    h.enforceServiceQuota.mockResolvedValue(undefined);
    h.patchDatasetMetadata.mockResolvedValue({});
    h.getDataset.mockResolvedValue({ id: 'd-1', key: 'ds', name: 'DS', projectId: 'proj-1' });
    // Production accepts bodies up to 10 MB, so the route's own 5 MB source cap is what a large paste meets.
    app = await createFastifyApiTestApp(evaluationsApiPlugin, { rawJsonBody: true, bodyLimit: 10 * 1024 * 1024 });
    clientApp = await createFastifyApiTestApp(clientEvaluationsApiPlugin, { rawJsonBody: true });
  });

  describe('POST /api/evaluation/runs/:id/cancel', () => {
    it('answers 200 with the run and the outcome', async () => {
      h.cancelRun.mockResolvedValue({ run: { id: 'r-1', status: 'running', items: [] }, outcome: 'cancel_requested' });
      const res = await send(app, 'POST', '/api/evaluation/runs/r-1/cancel');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'cancel_requested', run: { id: 'r-1' } });
      expect(h.cancelRun).toHaveBeenCalledWith('tenant_acme', 'r-1', 'proj-1');
    });

    it('answers 404 when the run is unknown or belongs to another project', async () => {
      h.cancelRun.mockResolvedValue(null);
      const res = await send(app, 'POST', '/api/evaluation/runs/nope/cancel');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Run not found' });
    });

    it('answers 409 with the run when it already finished', async () => {
      h.cancelRun.mockResolvedValue({ run: { id: 'r-1', status: 'completed', items: [] }, outcome: 'already_finished' });
      const res = await send(app, 'POST', '/api/evaluation/runs/r-1/cancel');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'Run already finished', run: { id: 'r-1', status: 'completed' } });
    });
  });

  describe('GET /api/evaluation/runs', () => {
    it('returns { runs, total } with defaults of limit 50 and skip 0', async () => {
      h.listRunSummaries.mockResolvedValue({ runs: [{ id: 'r-1', items: [] }], total: 7 });
      const res = await send(app, 'GET', '/api/evaluation/runs');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ runs: [{ id: 'r-1', items: [] }], total: 7 });
      expect(h.listRunSummaries).toHaveBeenCalledWith('tenant_acme', expect.objectContaining({ projectId: 'proj-1', limit: 50, skip: 0 }));
    });

    it('clamps limit to 200 and skip to >= 0', async () => {
      h.listRunSummaries.mockResolvedValue({ runs: [], total: 0 });
      await send(app, 'GET', '/api/evaluation/runs?limit=5000&skip=-3&status=failed&suiteKey=s1');
      expect(h.listRunSummaries).toHaveBeenCalledWith(
        'tenant_acme',
        expect.objectContaining({ limit: 200, skip: 0, status: 'failed', suiteKey: 's1' }),
      );
    });

    it('accepts the cancelled status', async () => {
      h.listRunSummaries.mockResolvedValue({ runs: [], total: 0 });
      const res = await send(app, 'GET', '/api/evaluation/runs?status=cancelled');
      expect(res.statusCode).toBe(200);
    });

    it.each(['limit=abc', 'skip=1.5', 'limit=10x', 'status=bogus'])('answers 400 for %s', async (qs) => {
      const res = await send(app, 'GET', `/api/evaluation/runs?${qs}`);
      expect(res.statusCode).toBe(400);
      expect(h.listRunSummaries).not.toHaveBeenCalled();
    });
  });

  describe('typed service errors', () => {
    it('maps a refused delete to 409 with the message', async () => {
      h.deleteTarget.mockRejectedValue(new EvaluationConflictError('Target is used by suite "smoke"'));
      const res = await send(app, 'DELETE', '/api/evaluation/targets/t-1');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Target is used by suite "smoke"' });
    });

    it('maps a refused suite delete to 409', async () => {
      h.deleteSuite.mockRejectedValue(new EvaluationConflictError('Suite has a run in progress'));
      const res = await send(app, 'DELETE', '/api/evaluation/suites/s-1');
      expect(res.statusCode).toBe(409);
    });

    it('maps a compare of unfinished or mismatched runs to 409', async () => {
      h.compareRuns.mockRejectedValue(new EvaluationConflictError('Runs use different datasets'));
      const res = await send(app, 'GET', '/api/evaluation/runs/r-1/compare?baseline=r-0');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Runs use different datasets' });
    });

    it('maps running an empty dataset to 400', async () => {
      h.enqueueSuiteRun.mockRejectedValue(new EvaluationInputError('Dataset "ds" has no items to evaluate'));
      const res = await send(app, 'POST', '/api/evaluation/suites/smoke/run');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Dataset "ds" has no items to evaluate' });
    });
  });

  describe('suite scorers and run config', () => {
    const base = { name: 'S', targetKey: 't', datasetKey: 'd' };

    beforeEach(() => {
      h.createSuite.mockImplementation(async (_db, _tenant, _user, input) => ({ id: 's-1', ...input }));
    });

    it.each([
      [{ type: 'assertion', weight: -1 }, 'scorers[0].weight'],
      [{ type: 'assertion', weight: 'x' }, 'scorers[0].weight'],
      [{ type: 'assertion', threshold: 1.5 }, 'scorers[0].threshold'],
      [{ type: 'assertion', threshold: -0.1 }, 'scorers[0].threshold'],
      [{ type: 'assertion', applyWhen: 'sometimes' }, 'scorers[0].applyWhen'],
      [{ type: 'tool-call', allowExtraCalls: 'no' }, 'scorers[0].allowExtraCalls'],
      [{ type: 'json-shape', strict: 1 }, 'scorers[0].strict'],
    ])('rejects %j with a 400 naming the entry', async (scorer, fragment) => {
      const res = await send(app, 'POST', '/api/evaluation/suites', { ...base, scorers: [scorer] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain(fragment);
      expect(h.createSuite).not.toHaveBeenCalled();
    });

    it('names the index of the offending scorer', async () => {
      const res = await send(app, 'POST', '/api/evaluation/suites', {
        ...base,
        scorers: [{ type: 'assertion' }, { type: 'assertion', weight: -2 }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('scorers[1]');
    });

    it('passes applyWhen, allowExtraCalls and strict through', async () => {
      const res = await send(app, 'POST', '/api/evaluation/suites', {
        ...base,
        scorers: [
          { type: 'tool-call', allowExtraCalls: false, applyWhen: 'has-expected-tool-calls', weight: 0 },
          { type: 'json-shape', strict: true, threshold: 1 },
        ],
      });
      expect(res.statusCode).toBe(201);
      const scorers = h.createSuite.mock.calls[0][3].scorers;
      expect(scorers[0]).toMatchObject({ type: 'tool-call', allowExtraCalls: false, applyWhen: 'has-expected-tool-calls', weight: 0 });
      expect(scorers[1]).toMatchObject({ type: 'json-shape', strict: true, threshold: 1 });
    });

    it.each([
      [5000, 32],
      [0.4, undefined],
      [-4, 1],
      [8, 8],
    ])('clamps run concurrency %j to %j', async (sent, stored) => {
      const res = await send(app, 'POST', '/api/evaluation/suites', {
        ...base,
        scorers: [{ type: 'assertion' }],
        runConfig: { concurrency: sent, turnMode: 'single' },
      });
      expect(res.statusCode).toBe(201);
      expect(h.createSuite.mock.calls[0][3].runConfig.concurrency).toBe(stored);
    });
  });

  describe('dataset items', () => {
    const msg = { role: 'user', content: 'hi' };

    it('normalises OpenAI-shaped tool calls on create', async () => {
      h.createDataset.mockImplementation(async (_db, _tenant, _user, input) => ({ id: 'd-1', ...input }));
      const res = await send(app, 'POST', '/api/evaluation/datasets', {
        name: 'DS',
        items: [{
          id: 'i-1',
          input: [
            msg,
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
            { role: 'tool', content: 'ok', tool_call_id: 'c1' },
          ],
        }],
      });
      expect(res.statusCode).toBe(201);
      const stored = h.createDataset.mock.calls[0][3].items[0].input;
      expect(stored[1].toolCalls).toEqual([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]);
      expect(stored[1].tool_calls).toBeUndefined();
      expect(stored[2].toolCallId).toBe('c1');
    });

    it('rejects malformed items with a 400', async () => {
      const res = await send(app, 'POST', '/api/evaluation/datasets', {
        name: 'DS',
        items: [{ id: 'i-1', input: [{ role: 'robot', content: 'x' }] }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('role');
      expect(h.createDataset).not.toHaveBeenCalled();
    });

    it('rejects a bad argsMatch on append', async () => {
      const res = await send(app, 'POST', '/api/evaluation/datasets/d-1/items', {
        items: [{ id: 'i-1', input: [msg], expected: { toolCalls: [{ name: 'a', argsMatch: 'fuzzy' }] } }],
      });
      expect(res.statusCode).toBe(400);
      expect(h.appendDatasetItems).not.toHaveBeenCalled();
    });

    it('drops a client-sent labelMeta on append', async () => {
      h.appendDatasetItems.mockResolvedValue({ added: 1, total: 1 });
      const res = await send(app, 'POST', '/api/evaluation/datasets/d-1/items', {
        items: [{ id: 'i-1', input: [msg], labels: { topic: 'a' }, labelMeta: { source: 'human' } }],
      });
      expect(res.statusCode).toBe(201);
      expect(h.appendDatasetItems.mock.calls[0][2][0].labelMeta).toBeUndefined();
    });

    it('ignores a client-sent labelMeta on patch when no labels are sent', async () => {
      h.updateDatasetItem.mockResolvedValue({ id: 'i-1' });
      const res = await send(app, 'PATCH', '/api/evaluation/datasets/d-1/items/i-1', { tags: ['a'], labelMeta: { source: 'human' } });
      expect(res.statusCode).toBe(200);
      const data = h.updateDatasetItem.mock.calls[0][3];
      expect(data).toEqual({ tags: ['a'] });
    });

    it('stamps labelMeta server-side when labels are patched', async () => {
      h.updateDatasetItem.mockResolvedValue({ id: 'i-1' });
      h.getDatasetItem.mockResolvedValue(null);
      await send(app, 'PATCH', '/api/evaluation/datasets/d-1/items/i-1', { labels: { topic: 'a' }, labelMeta: { source: 'ai' } });
      const data = h.updateDatasetItem.mock.calls[0][3];
      expect(data.labelMeta).toMatchObject({ source: 'human', labeledBy: 'user-1' });
    });

    it('rejects a patch with an invalid message role', async () => {
      const res = await send(app, 'PATCH', '/api/evaluation/datasets/d-1/items/i-1', { input: [{ role: 'x', content: 'y' }] });
      expect(res.statusCode).toBe(400);
      expect(h.updateDatasetItem).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/evaluation/datasets/generate', () => {
    const valid = { name: 'G', generationModelKey: 'm', sourceType: 'text', text: 'some source text' };

    beforeEach(() => {
      h.enqueueDatasetGeneration.mockResolvedValue({ id: 'd-9' });
    });

    it.each([
      [{ count: 0 }, 'count'],
      [{ count: 201 }, 'count'],
      [{ count: 2.5 }, 'count'],
      [{ count: '10' }, 'count'],
      [{ sourceType: 'rag', ragModuleKey: 'k', maxChunks: 501 }, 'maxChunks'],
      [{ sourceType: 'rag', ragModuleKey: 'k', maxChunks: 0 }, 'maxChunks'],
    ])('rejects %j', async (patch, fragment) => {
      const res = await send(app, 'POST', '/api/evaluation/datasets/generate', { ...valid, ...patch });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain(fragment);
      expect(h.enqueueDatasetGeneration).not.toHaveBeenCalled();
      expect(h.enforceServiceQuota).not.toHaveBeenCalled();
    });

    it('rejects pasted text over 5 MB', async () => {
      const res = await send(app, 'POST', '/api/evaluation/datasets/generate', { ...valid, text: 'a'.repeat(5 * 1024 * 1024 + 1) });
      expect(res.statusCode).toBe(400);
      expect(h.enqueueDatasetGeneration).not.toHaveBeenCalled();
    });

    it('charges the evaluation quota and enqueues', async () => {
      const res = await send(app, 'POST', '/api/evaluation/datasets/generate', { ...valid, count: 200 });
      expect(res.statusCode).toBe(202);
      expect(h.enforceServiceQuota).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1' }),
        expect.objectContaining({ resourceKey: 'evaluation' }),
      );
      expect(h.enqueueDatasetGeneration.mock.calls[0][0].count).toBe(200);
    });
  });

  describe('POST /api/evaluation/datasets/:id/label', () => {
    it('writes the labeling block before enqueueing', async () => {
      const order: string[] = [];
      h.patchDatasetMetadata.mockImplementation(async () => { order.push('patch'); return {}; });
      h.enqueueDefinitionRun.mockImplementation(async () => { order.push('enqueue'); return { id: 'ar-1', status: 'pending' }; });
      const res = await send(app, 'POST', '/api/evaluation/datasets/d-1/label', { definitionKey: 'def' });
      expect(res.statusCode).toBe(202);
      expect(order[0]).toBe('patch');
      expect(order[1]).toBe('enqueue');
      expect(h.patchDatasetMetadata.mock.calls[0][2]).toMatchObject({ labeling: { definitionKey: 'def', status: 'pending' } });
    });

    it('patches the block to failed when the enqueue throws', async () => {
      h.enqueueDefinitionRun.mockRejectedValue(new Error('queue down'));
      const res = await send(app, 'POST', '/api/evaluation/datasets/d-1/label', { definitionKey: 'def' });
      expect(res.statusCode).toBe(500);
      const last = h.patchDatasetMetadata.mock.calls.at(-1)!;
      expect(last[2]).toMatchObject({ labeling: { status: 'failed', error: 'queue down' } });
    });
  });

  describe('POST /api/client/v1/evaluation/suites/:key/run', () => {
    it('queues the run and answers 202 when wait is false', async () => {
      h.enqueueSuiteRun.mockResolvedValue({
        id: 'r-1', suiteKey: 'smoke', targetKey: 't', datasetKey: 'd', status: 'pending',
      });
      const res = await send(clientApp, 'POST', '/api/client/v1/evaluation/suites/smoke/run', { wait: false });
      expect(res.statusCode).toBe(202);
      expect(res.json().run).toMatchObject({ id: 'r-1', status: 'pending', suite_key: 'smoke' });
      expect(h.enqueueSuiteRun).toHaveBeenCalledWith(expect.objectContaining({ suiteKey: 'smoke', projectId: 'proj-1' }));
      expect(h.runSuite).not.toHaveBeenCalled();
      expect(h.enforceServiceQuota).toHaveBeenCalledTimes(1);
    });

    it('still runs synchronously by default', async () => {
      h.runSuite.mockResolvedValue({ id: 'r-1', suiteKey: 'smoke', status: 'completed', items: [] });
      const res = await send(clientApp, 'POST', '/api/client/v1/evaluation/suites/smoke/run');
      expect(res.statusCode).toBe(201);
      expect(h.enqueueSuiteRun).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean wait', async () => {
      const res = await send(clientApp, 'POST', '/api/client/v1/evaluation/suites/smoke/run', { wait: 'no' });
      expect(res.statusCode).toBe(400);
    });

    it('maps typed errors to 409 and 400', async () => {
      h.runSuite.mockRejectedValueOnce(new EvaluationConflictError('already running'));
      const conflict = await send(clientApp, 'POST', '/api/client/v1/evaluation/suites/smoke/run');
      expect(conflict.statusCode).toBe(409);
      h.enqueueSuiteRun.mockRejectedValueOnce(new EvaluationInputError('no items'));
      const input = await send(clientApp, 'POST', '/api/client/v1/evaluation/suites/smoke/run', { wait: false });
      expect(input.statusCode).toBe(400);
    });
  });
});
