/**
 * The decision layer of the Analysis API: definitions with a decision model /
 * agent-session source / review settings, estimate, calibration, the agent
 * session browser, the results list + detail and the human review. The service
 * layer is mocked (it has its own tests); what is covered here is the HTTP
 * contract: validation, visibility (403/404) and the shape of the views.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => {
  class AnalysisReviewError extends Error {
    readonly status = 400;
  }
  return {
    AnalysisReviewError,
    db: null as unknown as ReturnType<typeof createMockDb>,
    createDefinition: vi.fn(),
    getDefinition: vi.fn(),
    updateDefinition: vi.fn(),
    enqueueDefinitionRun: vi.fn(),
    estimateRun: vi.fn(),
    getCalibration: vi.fn(),
    getResultDetail: vi.fn(),
    listAgentSessionRows: vi.fn(),
    listResults: vi.fn(),
    saveResultReview: vi.fn(),
    sessionListScope: vi.fn(),
    getAgentByKey: vi.fn(),
    getModelByKey: vi.fn(),
    getDataset: vi.fn(),
    requireProjectContextForRequest: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(),
    deleteDefinition: vi.fn(),
    visibleRunItems: vi.fn(),
  };
});

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return { ...actual, requireProjectContextForRequest: h.requireProjectContextForRequest };
});
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/services/analysis/service', () => ({
  createDefinition: h.createDefinition,
  getDefinition: h.getDefinition,
  updateDefinition: h.updateDefinition,
  deleteDefinition: h.deleteDefinition,
  deleteConversation: vi.fn(),
  getConversation: vi.fn(),
  getRun: h.getRun,
  ingestConversations: vi.fn(),
  listConversations: vi.fn(),
  listDefinitions: vi.fn(),
  listRuns: h.listRuns,
}));
vi.mock('@/lib/services/analysis/results', () => ({
  AnalysisReviewError: h.AnalysisReviewError,
  estimateRun: h.estimateRun,
  getCalibration: h.getCalibration,
  getResultDetail: h.getResultDetail,
  listAgentSessionRows: h.listAgentSessionRows,
  listResults: h.listResults,
  saveResultReview: h.saveResultReview,
  visibleRunItems: h.visibleRunItems,
}));
vi.mock('@/lib/services/analysis/analysisRunJob', () => ({ enqueueDefinitionRun: h.enqueueDefinitionRun }));
vi.mock('@/server/api/plugins/agent-session-access', () => ({
  sessionListScope: h.sessionListScope,
  SESSION_RESTRICTED_MESSAGE: 'This session used knowledge base documents that are not open to everyone.',
}));
vi.mock('@/lib/services/agents', () => ({ getAgentByKey: h.getAgentByKey }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: h.getModelByKey }));
vi.mock('@/lib/services/evaluation/service', () => ({ getDataset: h.getDataset }));

import { analysisApiPlugin } from '@/server/api/plugins/analysis';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const headers = {
  'x-license-type': 'ENTERPRISE',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-email': 'ada@acme.test',
  'x-user-id': 'user-1',
  'x-user-role': 'owner',
  'content-type': 'application/json',
};
const SESSION = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' };

const decisionField = { key: 'resolved', type: 'boolean', description: 'Was it resolved?' };
const baseDefinition = {
  name: 'Support quality',
  fieldSet: [decisionField],
  decisionModelKey: 'decider',
};

const RESULT = {
  id: 'res-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  definitionKey: 'support-quality',
  sourceKind: 'agent_session',
  sourceId: 'conv-1',
  title: 'Refund question',
  agentKey: 'support',
  ownerId: 'user-9',
  runId: 'run-1',
  decisions: {
    resolved: { answer: true, probabilities: { yes: 0.62, no: 0.38 }, confidence: 0.62, confidenceSource: 'native', needsReview: true },
  },
  extractedFields: { note: 'x' },
  judge: { score: 4, passed: true, reasoning: 'ok', error: undefined },
  accuracy: { score: 1, perField: {}, comparedCount: 2 },
  needsReview: true,
  reviewReason: 'low_confidence',
  minConfidence: 0.62,
  review: null,
  sourceVersion: { messageCount: 4, lastMessageAt: '2026-10-20T10:00:00.000Z' },
  analyzedAt: new Date('2026-10-21T10:00:00Z'),
  createdAt: new Date('2026-10-21T10:00:00Z'),
  updatedAt: new Date('2026-10-21T10:00:00Z'),
};

describe('/api/analysis decision layer', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });

  beforeEach(async () => {
    vi.clearAllMocks();
    h.db = createMockDb();
    h.db.findUserById.mockResolvedValue({ _id: 'user-1', role: 'owner', tenantId: 'tenant-1' } as never);
    h.requireProjectContextForRequest.mockResolvedValue({ projectId: 'proj-1', session: SESSION });
    // An unrestricted caller unless a test says otherwise.
    h.sessionListScope.mockResolvedValue({ userId: 'user-1' });
    h.getModelByKey.mockResolvedValue({ key: 'decider', category: 'decision' });
    h.getAgentByKey.mockImplementation(async (_t: string, key: string) => (key === 'ghost' ? null : { key }));
    h.createDefinition.mockImplementation(async (_t, _tenant, _user, input) => ({ id: 'def-1', key: 'support-quality', ...input }));
    h.getDefinition.mockResolvedValue({
      id: 'def-1',
      key: 'support-quality',
      projectId: 'proj-1',
      fieldSet: [decisionField],
      decisionModelKey: 'decider',
      extractionModelKey: undefined,
    });
    h.updateDefinition.mockImplementation(async (_t, id, _u, data) => ({ id, key: 'support-quality', ...data }));
    h.db.findAnalysisDefinitionByKey.mockResolvedValue({
      key: 'support-quality',
      source: { kind: 'agent_sessions', agentKeys: ['support'] },
    } as never);
    h.enqueueDefinitionRun.mockResolvedValue({ id: 'run-1', status: 'pending' });
    app = await createFastifyApiTestApp(analysisApiPlugin, { rawJsonBody: true });
  });

  // ── Definitions ──────────────────────────────────────────────────

  describe('POST /api/analysis/definitions', () => {
    it('stores the decision model, agent-session source, review settings and score levels', async () => {
      const res = await send('POST', '/api/analysis/definitions', {
        ...baseDefinition,
        fieldSet: [
          decisionField,
          { key: 'tone', type: 'score', levels: ['Poor', ' Fair ', 'Good'], reviewBelow: 0.8 },
        ],
        source: { kind: 'agent_sessions', agentKeys: ['support', 'support', ' sales '], minMessages: 3, idleMinutes: 0, days: 14 },
        review: { threshold: 0.75, spotCheckPct: 10 },
      });
      expect(res.statusCode).toBe(201);
      expect(h.getModelByKey).toHaveBeenCalledWith('tenant_acme', 'decider', 'proj-1');
      const input = h.createDefinition.mock.calls[0][3];
      expect(input).toMatchObject({
        decisionModelKey: 'decider',
        review: { threshold: 0.75, spotCheckPct: 10 },
        source: { kind: 'agent_sessions', agentKeys: ['support', 'sales'], minMessages: 3, idleMinutes: 0, days: 14 },
      });
      expect(input.fieldSet[1]).toMatchObject({ key: 'tone', type: 'score', levels: ['Poor', 'Fair', 'Good'], reviewBelow: 0.8 });
      expect(input.extractionModelKey).toBeUndefined();
    });

    it('a definition without the new fields is accepted as before', async () => {
      const res = await send('POST', '/api/analysis/definitions', {
        name: 'Legacy',
        fieldSet: [{ key: 'topic', type: 'string' }],
        extractionModelKey: 'gpt',
      });
      expect(res.statusCode).toBe(201);
      const input = h.createDefinition.mock.calls[0][3];
      expect(input.decisionModelKey).toBeUndefined();
      expect(input.source).toBeUndefined();
      expect(input.review).toBeUndefined();
      expect(h.getModelByKey).not.toHaveBeenCalled();
    });

    it.each([
      ['a model that is not a decision model', () => h.getModelByKey.mockResolvedValue({ key: 'decider', category: 'llm' })],
      ['an unknown model', () => h.getModelByKey.mockResolvedValue(null)],
    ])('rejects %s as decisionModelKey', async (_name, arrange) => {
      arrange();
      const res = await send('POST', '/api/analysis/definitions', baseDefinition);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('decisionModelKey must name a decision model');
      expect(h.createDefinition).not.toHaveBeenCalled();
    });

    it('requires extractionModelKey only when a field routes to extraction', async () => {
      const text = await send('POST', '/api/analysis/definitions', {
        ...baseDefinition,
        fieldSet: [decisionField, { key: 'summary', type: 'string' }],
      });
      expect(text.statusCode).toBe(400);
      expect(text.json().error).toBe('extractionModelKey is required for Text and Number fields');

      const noDecisionModel = await send('POST', '/api/analysis/definitions', { name: 'X', fieldSet: [decisionField] });
      expect(noDecisionModel.statusCode).toBe(400);
      expect(noDecisionModel.json().error).toBe('extractionModelKey is required for Text and Number fields');

      const withModel = await send('POST', '/api/analysis/definitions', {
        ...baseDefinition,
        fieldSet: [decisionField, { key: 'summary', type: 'string' }],
        extractionModelKey: 'gpt',
      });
      expect(withModel.statusCode).toBe(201);
    });

    it.each([
      ['a score with one level', { key: 's', type: 'score', levels: ['Only'] }],
      ['a score with duplicate levels', { key: 's', type: 'score', levels: ['A', 'a'] }],
      ['a score with an empty level', { key: 's', type: 'score', levels: ['A', ' '] }],
      ['a score with a level over 64 characters', { key: 's', type: 'score', levels: ['A', 'b'.repeat(65)] }],
      ['a score with more than 20 levels', { key: 's', type: 'score', levels: Array.from({ length: 21 }, (_, i) => `L${i}`) }],
      ['an enum value over 128 characters', { key: 'e', type: 'enum', enumValues: ['ok', 'x'.repeat(129)] }],
      ['reviewBelow above 1', { key: 'b', type: 'boolean', reviewBelow: 1.5 }],
    ])('rejects %s', async (_name, field) => {
      const res = await send('POST', '/api/analysis/definitions', { ...baseDefinition, fieldSet: [field] });
      expect(res.statusCode).toBe(400);
      expect(h.createDefinition).not.toHaveBeenCalled();
    });

    it('rejects more than 64 decision fields', async () => {
      const fieldSet = Array.from({ length: 65 }, (_, i) => ({ key: `q${i}`, type: 'boolean' }));
      const res = await send('POST', '/api/analysis/definitions', { ...baseDefinition, fieldSet });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/at most 64/);
    });

    it.each([
      ['no agents', { kind: 'agent_sessions', agentKeys: [] }],
      ['more than 50 agents', { kind: 'agent_sessions', agentKeys: Array.from({ length: 51 }, (_, i) => `a${i}`) }],
      ['minMessages 0', { kind: 'agent_sessions', agentKeys: ['support'], minMessages: 0 }],
      ['idleMinutes above 10080', { kind: 'agent_sessions', agentKeys: ['support'], idleMinutes: 10081 }],
      ['days 366', { kind: 'agent_sessions', agentKeys: ['support'], days: 366 }],
      ['a fractional days', { kind: 'agent_sessions', agentKeys: ['support'], days: 1.5 }],
      ['an unknown kind', { kind: 'files' }],
    ])('rejects a source with %s', async (_name, source) => {
      const res = await send('POST', '/api/analysis/definitions', { ...baseDefinition, source });
      expect(res.statusCode).toBe(400);
      expect(h.createDefinition).not.toHaveBeenCalled();
    });

    it('rejects a source agent that does not exist in the project', async () => {
      const res = await send('POST', '/api/analysis/definitions', {
        ...baseDefinition,
        source: { kind: 'agent_sessions', agentKeys: ['support', 'ghost'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Agent "ghost" not found');
      expect(h.getAgentByKey).toHaveBeenCalledWith('tenant_acme', 'support', 'proj-1');
    });

    it('answers 403 when the caller may not analyze an agent of the source', async () => {
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: ['sales'] } });
      const res = await send('POST', '/api/analysis/definitions', {
        ...baseDefinition,
        source: { kind: 'agent_sessions', agentKeys: ['sales', 'support'] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('You cannot analyze sessions of agent "support"');
      expect(h.createDefinition).not.toHaveBeenCalled();
    });

    it('lets a restricted caller analyze the agents they may view', async () => {
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: ['support'] } });
      const res = await send('POST', '/api/analysis/definitions', {
        ...baseDefinition,
        source: { kind: 'agent_sessions', agentKeys: ['support'] },
      });
      expect(res.statusCode).toBe(201);
    });

    it.each([
      ['threshold above 1', { threshold: 1.2 }],
      ['a negative spotCheckPct', { spotCheckPct: -1 }],
      ['spotCheckPct above 100', { spotCheckPct: 101 }],
    ])('rejects review settings with %s', async (_name, review) => {
      const res = await send('POST', '/api/analysis/definitions', { ...baseDefinition, review });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/analysis/definitions/:id', () => {
    it('updates the decision model, source and review', async () => {
      const res = await send('PATCH', '/api/analysis/definitions/def-1', {
        decisionModelKey: 'decider',
        source: { kind: 'agent_sessions', agentKeys: ['support'], days: 30 },
        review: { threshold: 0.9 },
      });
      expect(res.statusCode).toBe(200);
      expect(h.getModelByKey).toHaveBeenCalledWith('tenant_acme', 'decider', 'proj-1');
      expect(h.updateDefinition.mock.calls[0][3]).toMatchObject({
        decisionModelKey: 'decider',
        source: { kind: 'agent_sessions', agentKeys: ['support'], days: 30 },
        review: { threshold: 0.9 },
      });
    });

    it('leaves the new fields alone when the body does not name them', async () => {
      const res = await send('PATCH', '/api/analysis/definitions/def-1', { name: 'Renamed' });
      expect(res.statusCode).toBe(200);
      const data = h.updateDefinition.mock.calls[0][3];
      expect(data).not.toHaveProperty('decisionModelKey');
      expect(data).not.toHaveProperty('source');
      expect(data).not.toHaveProperty('review');
    });

    it('re-checks the routing against the stored definition when the field set changes', async () => {
      const res = await send('PATCH', '/api/analysis/definitions/def-1', {
        fieldSet: [decisionField, { key: 'summary', type: 'number' }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('extractionModelKey is required for Text and Number fields');
    });

    it('rejects a non-decision model and answers 404 for an unknown definition', async () => {
      h.getModelByKey.mockResolvedValue({ key: 'decider', category: 'llm' });
      const bad = await send('PATCH', '/api/analysis/definitions/def-1', { decisionModelKey: 'decider' });
      expect(bad.statusCode).toBe(400);

      h.getDefinition.mockResolvedValue(null);
      const missing = await send('PATCH', '/api/analysis/definitions/nope', { name: 'x' });
      expect(missing.statusCode).toBe(404);
    });

    it('answers 403 for a source the caller may not analyze', async () => {
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1' } });
      const res = await send('PATCH', '/api/analysis/definitions/def-1', {
        source: { kind: 'agent_sessions', agentKeys: ['support'] },
      });
      expect(res.statusCode).toBe(403);
      expect(h.updateDefinition).not.toHaveBeenCalled();
    });
  });

  // ── Run + estimate ───────────────────────────────────────────────

  describe('POST /api/analysis/definitions/:key/run', () => {
    it('runs an agent-session definition with the requested window and selection', async () => {
      const res = await send('POST', '/api/analysis/definitions/support-quality/run', {
        selection: { strategy: 'changed' },
        target: { kind: 'agent_sessions', days: 3 },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ run: { id: 'run-1', status: 'pending' } });
      expect(h.enqueueDefinitionRun).toHaveBeenCalledWith(expect.objectContaining({
        tenantDbName: 'tenant_acme',
        projectId: 'proj-1',
        createdBy: 'user-1',
        definitionKey: 'support-quality',
        selection: expect.objectContaining({ strategy: 'changed' }),
        target: { kind: 'agent_sessions', days: 3 },
      }));
    });

    it('with no body leaves the target to the definition source', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/analysis/definitions/support-quality/run', headers });
      expect(res.statusCode).toBe(202);
      expect(h.enqueueDefinitionRun.mock.calls[0][0].target).toBeUndefined();
    });

    it('selects session ids with the keys strategy', async () => {
      await send('POST', '/api/analysis/definitions/support-quality/run', {
        selection: { strategy: 'keys', conversationKeys: ['c1', 'c2'] },
      });
      expect(h.enqueueDefinitionRun.mock.calls[0][0].selection).toMatchObject({ strategy: 'keys', conversationKeys: ['c1', 'c2'] });
    });

    it('answers 403 when the caller may not analyze the definition agents', async () => {
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: [] } });
      const res = await send('POST', '/api/analysis/definitions/support-quality/run', {});
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('You cannot analyze sessions of agent "support"');
      expect(h.enqueueDefinitionRun).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown definition', async () => {
      h.db.findAnalysisDefinitionByKey.mockResolvedValue(null);
      const res = await send('POST', '/api/analysis/definitions/nope/run', {});
      expect(res.statusCode).toBe(404);
    });

    it.each([
      ['an unknown target kind', { target: { kind: 'files' } }],
      ['a fractional window', { target: { kind: 'agent_sessions', days: 0.5 } }],
      ['more than 5000 keys', { selection: { strategy: 'keys', conversationKeys: Array.from({ length: 5001 }, (_, i) => `c${i}`) } }],
    ])('answers 400 for %s', async (_name, body) => {
      const res = await send('POST', '/api/analysis/definitions/support-quality/run', body);
      expect(res.statusCode).toBe(400);
      expect(h.enqueueDefinitionRun).not.toHaveBeenCalled();
    });

    it('maps the service errors: 400 / 404 / 409', async () => {
      h.enqueueDefinitionRun.mockRejectedValueOnce(new Error('This definition does not analyze agent sessions'));
      expect((await send('POST', '/api/analysis/definitions/support-quality/run', {})).statusCode).toBe(400);
      h.enqueueDefinitionRun.mockRejectedValueOnce(new Error('No conversations to analyze with this selection.'));
      expect((await send('POST', '/api/analysis/definitions/support-quality/run', {})).statusCode).toBe(400);
      h.enqueueDefinitionRun.mockRejectedValueOnce(new Error('Analysis definition "x" not found'));
      expect((await send('POST', '/api/analysis/definitions/support-quality/run', {})).statusCode).toBe(404);
      h.enqueueDefinitionRun.mockRejectedValueOnce(new Error('A run of this definition is already in progress'));
      expect((await send('POST', '/api/analysis/definitions/support-quality/run', {})).statusCode).toBe(409);
      h.enqueueDefinitionRun.mockRejectedValueOnce(new Error('boom'));
      expect((await send('POST', '/api/analysis/definitions/support-quality/run', {})).statusCode).toBe(500);
    });

    it('keeps the dataset target working and project-checks the dataset', async () => {
      h.db.findAnalysisDefinitionByKey.mockResolvedValue({ key: 'labeler' } as never);
      h.getDataset.mockResolvedValueOnce({ key: 'ds', name: 'DS', projectId: 'proj-other' });
      const foreign = await send('POST', '/api/analysis/definitions/labeler/run', { target: { kind: 'dataset', datasetId: 'd1' } });
      expect(foreign.statusCode).toBe(404);

      h.getDataset.mockResolvedValueOnce({ key: 'ds', name: 'DS', projectId: 'proj-1' });
      const ok = await send('POST', '/api/analysis/definitions/labeler/run', { target: { kind: 'dataset', datasetId: 'd1' } });
      expect(ok.statusCode).toBe(202);
      expect(h.enqueueDefinitionRun.mock.calls[0][0].target).toEqual({ kind: 'dataset', datasetId: 'd1', datasetKey: 'ds', datasetName: 'DS' });
    });
  });

  describe('POST /api/analysis/definitions/:key/estimate', () => {
    const ESTIMATE = {
      conversations: 12,
      sampled: 12,
      avgChars: 900,
      inputTokens: 9000,
      outputTokens: 1500,
      cost: { decision: 0.02, extraction: null, judge: null, total: 0.02, currency: 'USD' },
    };

    it('returns the estimate for the same request a run takes', async () => {
      h.estimateRun.mockResolvedValue(ESTIMATE);
      const res = await send('POST', '/api/analysis/definitions/support-quality/estimate', {
        selection: { strategy: 'random', sampleSize: 12 },
        target: { kind: 'agent_sessions' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ estimate: ESTIMATE });
      expect(h.estimateRun).toHaveBeenCalledWith(expect.objectContaining({
        definitionKey: 'support-quality',
        projectId: 'proj-1',
        selection: expect.objectContaining({ strategy: 'random', sampleSize: 12 }),
        target: { kind: 'agent_sessions' },
      }));
      expect(h.enqueueDefinitionRun).not.toHaveBeenCalled();
    });

    it('answers 403 for agents the caller may not analyze, 404 for an unknown definition, 400 for service errors', async () => {
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1' } });
      expect((await send('POST', '/api/analysis/definitions/support-quality/estimate', {})).statusCode).toBe(403);

      h.sessionListScope.mockResolvedValue({ userId: 'user-1' });
      h.db.findAnalysisDefinitionByKey.mockResolvedValue(null);
      expect((await send('POST', '/api/analysis/definitions/nope/estimate', {})).statusCode).toBe(404);

      h.db.findAnalysisDefinitionByKey.mockResolvedValue({ key: 'support-quality' } as never);
      h.estimateRun.mockRejectedValue(new Error('This definition does not analyze agent sessions'));
      expect((await send('POST', '/api/analysis/definitions/support-quality/estimate', { target: { kind: 'agent_sessions' } })).statusCode).toBe(400);
    });
  });

  // ── Calibration ──────────────────────────────────────────────────

  describe('GET /api/analysis/definitions/:id/calibration', () => {
    it('returns the calibration of the definition', async () => {
      const calibration = {
        definitionKey: 'support-quality',
        targetAccuracy: 0.9,
        reviewed: 14,
        spotChecks: 3,
        questions: [
          { key: 'resolved', type: 'boolean', reviewed: 14, accuracy: 0.86, avgConfidence: 0.8, ece: 0.05, threshold: 0.7, suggestedThreshold: 0.8 },
        ],
      };
      h.getCalibration.mockResolvedValue(calibration);
      const res = await send('GET', '/api/analysis/definitions/def-1/calibration');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ calibration });
      expect(h.getCalibration).toHaveBeenCalledWith('tenant_acme', { projectId: 'proj-1', definitionId: 'def-1' });
    });

    it('answers 404 when the definition is not in the project', async () => {
      h.getCalibration.mockResolvedValue(null);
      const res = await send('GET', '/api/analysis/definitions/nope/calibration');
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Agent session browser ────────────────────────────────────────

  describe('GET /api/analysis/sources/agent-sessions', () => {
    const ROW = {
      id: 'conv-1',
      title: 'Refund question',
      agentKey: 'support',
      messageCount: 6,
      updatedAt: new Date('2026-10-22T08:00:00Z'),
      origin: 'api',
      result: {
        id: 'res-1',
        needsReview: true,
        reviewed: false,
        stale: true,
        analyzedAt: new Date('2026-10-21T10:00:00Z'),
        decisions: { resolved: { answer: true, confidence: 0.6 } },
      },
    };

    it('lists the sessions with their results as ISO strings and passes the paging through', async () => {
      h.listAgentSessionRows.mockResolvedValue({ rows: [ROW, { ...ROW, id: 'conv-2', result: null }], nextCursor: 'abc' });
      const res = await send('GET', '/api/analysis/sources/agent-sessions?definitionKey=support-quality&agentKey=support&days=7&limit=500&cursor=zzz');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.nextCursor).toBe('abc');
      expect(body.rows[0]).toMatchObject({
        id: 'conv-1',
        updatedAt: '2026-10-22T08:00:00.000Z',
        origin: 'api',
        result: { id: 'res-1', stale: true, analyzedAt: '2026-10-21T10:00:00.000Z', decisions: { resolved: { answer: true, confidence: 0.6 } } },
      });
      expect(body.rows[1].result).toBeNull();
      expect(h.listAgentSessionRows).toHaveBeenCalledWith('tenant_acme', {
        projectId: 'proj-1',
        definitionKey: 'support-quality',
        agentKey: 'support',
        days: 7,
        limit: 100,
        cursor: 'zzz',
        ownOnly: undefined,
      });
    });

    it('restricts the rows inside the query for a caller who may only see some sessions', async () => {
      const ownOnly = { userId: 'user-1', viewableAgentKeys: ['sales'] };
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly });
      h.listAgentSessionRows.mockResolvedValue({ rows: [] });
      const res = await send('GET', '/api/analysis/sources/agent-sessions?definitionKey=support-quality');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ rows: [] });
      expect(h.listAgentSessionRows.mock.calls[0][1]).toMatchObject({ ownOnly, limit: 50 });
    });

    it('answers 400 without a definitionKey or with a bad window, and maps service errors', async () => {
      expect((await send('GET', '/api/analysis/sources/agent-sessions')).statusCode).toBe(400);
      expect((await send('GET', '/api/analysis/sources/agent-sessions?definitionKey=x&days=400')).statusCode).toBe(400);

      h.listAgentSessionRows.mockRejectedValueOnce(new Error('This definition does not analyze agent sessions'));
      expect((await send('GET', '/api/analysis/sources/agent-sessions?definitionKey=x')).statusCode).toBe(400);
      h.listAgentSessionRows.mockRejectedValueOnce(new Error('Invalid cursor'));
      expect((await send('GET', '/api/analysis/sources/agent-sessions?definitionKey=x&cursor=bad')).statusCode).toBe(400);
      h.listAgentSessionRows.mockRejectedValueOnce(new Error('Analysis definition "x" not found'));
      expect((await send('GET', '/api/analysis/sources/agent-sessions?definitionKey=x')).statusCode).toBe(404);
    });
  });

  // ── Results ──────────────────────────────────────────────────────

  describe('GET /api/analysis/results', () => {
    it('lists result rows without probabilities or extraction detail', async () => {
      h.listResults.mockResolvedValue({ results: [RESULT], total: 41 });
      const res = await send('GET', '/api/analysis/results?definitionKey=support-quality&needsReview=true&sort=confidence&limit=20&skip=40');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(41);
      expect(body.results).toHaveLength(1);
      const row = body.results[0];
      expect(row).toEqual({
        id: 'res-1',
        definitionKey: 'support-quality',
        sourceKind: 'agent_session',
        sourceId: 'conv-1',
        title: 'Refund question',
        agentKey: 'support',
        needsReview: true,
        reviewReason: 'low_confidence',
        reviewed: false,
        minConfidence: 0.62,
        decisions: { resolved: { answer: true, confidence: 0.62, confidenceSource: 'native', needsReview: true } },
        analyzedAt: '2026-10-21T10:00:00.000Z',
        runId: 'run-1',
      });
      expect(row.decisions.resolved).not.toHaveProperty('probabilities');
      expect(h.listResults).toHaveBeenCalledWith('tenant_acme', {
        projectId: 'proj-1',
        definitionKey: 'support-quality',
        needsReview: true,
        sort: 'confidence',
        limit: 20,
        skip: 40,
        viewer: undefined,
      });
    });

    it('applies defaults and passes a restricted viewer to the service', async () => {
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: ['sales'] } });
      h.listResults.mockResolvedValue({ results: [], total: 0 });
      const res = await send('GET', '/api/analysis/results?needsReview=false&limit=9999');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ results: [], total: 0 });
      expect(h.listResults.mock.calls[0][1]).toMatchObject({
        needsReview: false,
        sort: undefined,
        limit: 200,
        skip: 0,
        viewer: { userId: 'user-1', agentKeys: ['sales'] },
      });
    });

    it('treats a restricted viewer with no viewable agents as an empty agent list', async () => {
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1' } });
      h.listResults.mockResolvedValue({ results: [], total: 0 });
      await send('GET', '/api/analysis/results');
      expect(h.listResults.mock.calls[0][1].viewer).toEqual({ userId: 'user-1', agentKeys: [] });
    });
  });

  describe('a result of a session that drew on restricted knowledge base documents', () => {
    const MARKED = { ...RESULT, kbRestricted: ['proj-1:handbook'] };

    // The knowledge base gave up the admin exception: the workspace owner reads it only if they had the session.
    beforeEach(() => {
      h.db.findRagModuleByKey.mockResolvedValue({ key: 'handbook', projectId: 'proj-1', access: { enabled: true, adminBypass: false } } as never);
    });

    it('stays on the list without its title or decisions', async () => {
      h.listResults.mockResolvedValue({ results: [MARKED, { ...RESULT, id: 'res-2' }], total: 2 });
      const res = await send('GET', '/api/analysis/results?definitionKey=support-quality');
      expect(res.statusCode).toBe(200);
      const [hidden, open] = res.json().results;
      expect(hidden).toMatchObject({ id: 'res-1', title: null, decisions: {}, restricted: true });
      expect(JSON.stringify(hidden)).not.toContain('Refund question');
      expect(open).toMatchObject({ id: 'res-2', title: 'Refund question' });
    });

    it('is refused as a detail and as a review, without its content', async () => {
      h.getResultDetail.mockResolvedValue({ result: MARKED, definition: null, source: { kind: 'agent_session', id: 'conv-1', available: true, transcript: [{ role: 'user', content: 'secret' }] } });
      const detail = await send('GET', '/api/analysis/results/res-1');
      expect(detail.statusCode).toBe(403);
      expect(detail.json()).toMatchObject({ code: 'session_restricted' });
      expect(detail.body).not.toContain('secret');

      h.db.findAnalysisResultById.mockResolvedValue(MARKED as never);
      const review = await send('POST', '/api/analysis/results/res-1/review', { values: { resolved: true } });
      expect(review.statusCode).toBe(403);
      expect(h.saveResultReview).not.toHaveBeenCalled();
    });

    it('is also hidden when only the live session is marked (marked after the analysis ran)', async () => {
      h.db.findRestrictedAgentConversations.mockResolvedValue([{ _id: 'conv-1', createdBy: 'user-9', kbRestricted: ['proj-1:handbook'] }] as never);
      h.listResults.mockResolvedValue({ results: [RESULT], total: 1 });
      const res = await send('GET', '/api/analysis/results?definitionKey=support-quality');
      expect(res.json().results[0]).toMatchObject({ restricted: true, title: null });
    });

    it('is read whole by the person whose session it was', async () => {
      h.requireProjectContextForRequest.mockResolvedValue({ projectId: 'proj-1', session: { ...SESSION, userId: 'user-9' } });
      h.listResults.mockResolvedValue({ results: [MARKED], total: 1 });
      const res = await send('GET', '/api/analysis/results?definitionKey=support-quality');
      expect(res.json().results[0]).toMatchObject({ title: 'Refund question' });
      expect(res.json().results[0].restricted).toBeUndefined();
    });
  });

  describe('GET /api/analysis/results/:id', () => {
    const DETAIL = {
      result: RESULT,
      definition: { id: 'def-1', key: 'support-quality', name: 'Support quality', fieldSet: [decisionField], decisionModelKey: 'decider' },
      source: {
        kind: 'agent_session',
        id: 'conv-1',
        available: true,
        title: 'Refund question',
        agentKey: 'support',
        href: '/dashboard/agents/agent-1/sessions/conv-1',
        messageCount: 2,
        transcript: [{ role: 'user', content: 'hi' }],
      },
    };

    it('returns the result with probabilities, its definition and the source transcript', async () => {
      h.getResultDetail.mockResolvedValue(DETAIL);
      const res = await send('GET', '/api/analysis/results/res-1');
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.decisions.resolved.probabilities).toEqual({ yes: 0.62, no: 0.38 });
      expect(body.result).toMatchObject({
        id: 'res-1',
        extractedFields: { note: 'x' },
        judge: { score: 4, passed: true, reasoning: 'ok' },
        accuracy: { score: 1, comparedCount: 2 },
        review: null,
        sourceVersion: { messageCount: 4, lastMessageAt: '2026-10-20T10:00:00.000Z' },
        analyzedAt: '2026-10-21T10:00:00.000Z',
      });
      expect(body.result).not.toHaveProperty('ownerId');
      expect(body.result.accuracy).not.toHaveProperty('perField');
      expect(body.definition).toEqual(DETAIL.definition);
      expect(body.source).toEqual(DETAIL.source);
      expect(h.getResultDetail).toHaveBeenCalledWith('tenant_acme', { projectId: 'proj-1', id: 'res-1', viewer: undefined });
    });

    it('answers 404 for a missing result or one the viewer may not see', async () => {
      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: [] } });
      h.getResultDetail.mockResolvedValue(null);
      const res = await send('GET', '/api/analysis/results/res-9');
      expect(res.statusCode).toBe(404);
      expect(h.getResultDetail.mock.calls[0][1].viewer).toEqual({ userId: 'user-1', agentKeys: [] });
    });
  });

  describe('POST /api/analysis/results/:id/review', () => {
    it('saves the human answers and returns the result with its review', async () => {
      h.saveResultReview.mockResolvedValue({
        ...RESULT,
        review: { values: { resolved: false }, by: 'user-1', at: '2026-10-23T09:00:00.000Z' },
      });
      const res = await send('POST', '/api/analysis/results/res-1/review', { values: { resolved: false } });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toMatchObject({
        id: 'res-1',
        reviewed: true,
        review: { values: { resolved: false }, by: 'user-1', at: '2026-10-23T09:00:00.000Z' },
      });
      expect(h.saveResultReview).toHaveBeenCalledWith('tenant_acme', {
        projectId: 'proj-1',
        id: 'res-1',
        userId: 'user-1',
        values: { resolved: false },
        viewer: undefined,
      });
    });

    it('answers 400 for a body that is missing, not an object, or has no values', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/analysis/results/res-1/review', headers })).statusCode).toBe(400);
      expect((await send('POST', '/api/analysis/results/res-1/review', { values: ['x'] })).statusCode).toBe(400);
      expect((await send('POST', '/api/analysis/results/res-1/review', {})).statusCode).toBe(400);
      expect(h.saveResultReview).not.toHaveBeenCalled();
    });

    it('answers 400 for values the service rejects and 404 for a result the viewer may not see', async () => {
      h.saveResultReview.mockRejectedValueOnce(new h.AnalysisReviewError('Unknown question "nope"'));
      const bad = await send('POST', '/api/analysis/results/res-1/review', { values: { nope: true } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('Unknown question "nope"');

      h.sessionListScope.mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: [] } });
      h.saveResultReview.mockResolvedValueOnce(null);
      const hidden = await send('POST', '/api/analysis/results/res-1/review', { values: { resolved: true } });
      expect(hidden.statusCode).toBe(404);
      expect(h.saveResultReview.mock.calls[1][1].viewer).toEqual({ userId: 'user-1', agentKeys: [] });
    });
  });

  // ── Who may see and change what ─────────────────────────────────

  describe('runs and definitions of agent sessions', () => {
    const sessionRun = {
      id: 'run-1',
      projectId: 'proj-1',
      definitionKey: 'support-quality',
      target: { kind: 'agent_sessions', agentKeys: ['support'], minMessages: 2, idleMinutes: 30, from: 'a', to: 'b' },
      items: [{ conversationKey: 'conv-1' }, { conversationKey: 'conv-2' }],
    };
    const restricted = { userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: [] } };

    it('GET /analysis/runs/:id is not found from another project', async () => {
      h.getRun.mockResolvedValueOnce({ ...sessionRun, projectId: 'proj-2' });
      expect((await send('GET', '/api/analysis/runs/run-1')).statusCode).toBe(404);
    });

    it('GET /analysis/runs/:id gives a restricted caller only the session items they may see', async () => {
      h.getRun.mockResolvedValue(sessionRun);
      expect((await send('GET', '/api/analysis/runs/run-1')).json().run.items).toHaveLength(2);
      expect(h.visibleRunItems).not.toHaveBeenCalled();

      h.sessionListScope.mockResolvedValue(restricted);
      h.visibleRunItems.mockResolvedValueOnce([{ conversationKey: 'conv-2' }]);
      const res = await send('GET', '/api/analysis/runs/run-1');
      expect(res.statusCode).toBe(200);
      expect(res.json().run.items).toEqual([{ conversationKey: 'conv-2' }]);
      expect(h.visibleRunItems.mock.calls[0][2]).toEqual({ userId: 'user-1', agentKeys: [] });
    });

    it('GET /analysis/runs drops session items for a restricted caller', async () => {
      h.listRuns.mockResolvedValue([sessionRun, { id: 'run-2', definitionKey: 'corpus', items: [{ conversationKey: 'c' }] }]);
      h.sessionListScope.mockResolvedValue(restricted);
      const runs = (await send('GET', '/api/analysis/runs')).json().runs;
      expect(runs[0].items).toEqual([]);
      expect(runs[1].items).toHaveLength(1);
    });

    it('PATCH and DELETE of an agent-session definition need the right to analyze its agents', async () => {
      h.getDefinition.mockResolvedValue({
        id: 'def-1', key: 'support-quality', projectId: 'proj-1', fieldSet: [decisionField], decisionModelKey: 'decider',
        source: { kind: 'agent_sessions', agentKeys: ['support'] },
      });
      h.sessionListScope.mockResolvedValue(restricted);
      expect((await send('PATCH', '/api/analysis/definitions/def-1', { extractionInstructions: 'copy everything' })).statusCode).toBe(403);
      expect(h.updateDefinition).not.toHaveBeenCalled();
      expect((await send('DELETE', '/api/analysis/definitions/def-1')).statusCode).toBe(403);
      expect(h.deleteDefinition).not.toHaveBeenCalled();

      h.sessionListScope.mockResolvedValue({ userId: 'user-1' });
      h.deleteDefinition.mockResolvedValueOnce(true);
      expect((await send('DELETE', '/api/analysis/definitions/def-1')).statusCode).toBe(200);
    });

    it('a PATCH carries only the keys the body names', async () => {
      await send('PATCH', '/api/analysis/definitions/def-1', { name: 'Renamed' });
      expect(h.updateDefinition.mock.calls[0][3]).toEqual({ name: 'Renamed' });
    });

    it('a repeated query parameter is not a 500', async () => {
      h.listResults.mockResolvedValue({ results: [], total: 0 });
      const res = await send('GET', '/api/analysis/results?definitionKey=a&definitionKey=b');
      expect(res.statusCode).toBe(200);
      expect(h.listResults.mock.calls[0][1].definitionKey).toBeUndefined();
    });
  });
});
