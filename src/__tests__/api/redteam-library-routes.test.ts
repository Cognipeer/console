/**
 * The probe library's dashboard routes: the built-in definition, the custom
 * probe fields the library added (polarity, named detectors, history, clone
 * lineage), and the import. The service is stood in for, so these tests pin
 * what the routes accept, refuse and hand on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBuiltinProbeDefinition: vi.fn(),
  createCustomProbe: vi.fn(),
  updateCustomProbe: vi.fn(),
  getCustomProbe: vi.fn(),
  importCustomProbes: vi.fn(),
}));

vi.mock('@/lib/services/redteam/service', () => {
  class RedTeamValidationError extends Error {}
  return {
    createCampaign: vi.fn(),
    getCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    listCampaigns: vi.fn(async () => []),
    listCustomProbes: vi.fn(async () => []),
    compareRuns: vi.fn(),
    createCustomProbe: mocks.createCustomProbe,
    deleteCampaign: vi.fn(),
    deleteCustomProbe: vi.fn(),
    getCustomProbe: mocks.getCustomProbe,
    getBuiltinProbeDefinition: mocks.getBuiltinProbeDefinition,
    importCustomProbes: mocks.importCustomProbes,
    getOverview: vi.fn(),
    getRun: vi.fn(),
    listRunsPage: vi.fn(async () => ({ runs: [], total: 0 })),
    cancelRun: vi.fn(),
    reviewAttempt: vi.fn(),
    updateCustomProbe: mocks.updateCustomProbe,
    validateCampaignInput: vi.fn(),
    CustomProbeError: class CustomProbeError extends Error {},
    RedTeamConflictError: class RedTeamConflictError extends Error {},
    RedTeamForbiddenError: class RedTeamForbiddenError extends Error {},
    RedTeamNotFoundError: class RedTeamNotFoundError extends Error {},
    RedTeamValidationError,
  };
});
vi.mock('@/lib/services/redteam/campaignJob', () => ({ enqueueCampaignRun: vi.fn() }));
vi.mock('@/server/api/restrictedKnowledgeRequest', () => ({
  restrictedKnowledgeReaderFor: vi.fn(() => ({ mayRead: async () => true })),
  withoutRestrictedAttempts: vi.fn(async (_request: unknown, _viewer: unknown, run: unknown) => run),
}));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  type Handler = (request: unknown, reply: unknown, ctx?: unknown) => unknown;
  const session = { tenantDbName: 'tenant_db', tenantId: 'tenant-1', userId: 'user-1' };
  return {
    ...actual,
    authorizeServiceForRequest: vi.fn(async () => ({ allowed: true, service: 'agents', required: 'write' })),
    withApiRequestContext: (handler: Handler) => async (request: unknown, reply: unknown) => handler(request, reply),
    requireSessionContext: vi.fn(() => session),
    requireProjectContextForRequest: vi.fn(async () => ({ projectId: 'proj-1', session })),
  };
});

import { redTeamApiPlugin } from '@/server/api/plugins/redteam';
import { BUILTIN_PROBE_KEYS } from '@/lib/services/redteam/probes';
import { CUSTOM_PROBE_LIMITS, IMPORT_LIMITS } from '@/lib/services/redteam/limits';
import { RedTeamValidationError } from '@/lib/services/redteam/service';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

type App = Awaited<ReturnType<typeof createFastifyApiTestApp>>;

const call = (app: App, method: 'GET' | 'PATCH' | 'POST', url: string, payload?: unknown) =>
  app.inject({
    method, url,
    headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });

const BODY = {
  name: 'Library probe',
  category: 'LLM01-prompt-injection',
  severity: 'medium',
  attempts: [{ id: 'a1', turns: ['and now?'] }],
  detectors: { refusal: true, pattern: false },
};

const SOURCE = { name: 'Placeholder set', license: 'MIT', url: 'https://example.com/set', format: 'custom-csv', fileName: 'set.csv' };
const DRAFT = {
  name: 'Harmless prompts',
  description: 'Imported',
  family: 'imported',
  category: 'LLM09-misinformation',
  severity: 'low',
  polarity: 'over-refusal',
  attempts: [{ id: 'row-1', turns: ['How do I stop a running process?'], refusalExpected: false }],
  detectors: { refusal: true },
  source: SOURCE,
};

describe('probe library routes', () => {
  let app: App;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.createCustomProbe.mockImplementation(async (_db, _tenant, _user, input) => ({ id: 'p1', key: 'custom:x', ...input }));
    mocks.updateCustomProbe.mockImplementation(async (_db, id, _user, data) => ({ id, ...data }));
    mocks.getCustomProbe.mockResolvedValue({
      id: 'p1', key: 'custom:x', projectId: 'proj-1', category: 'LLM01-prompt-injection',
      attempts: [{ id: 'a1', turns: ['hi'] }], detectors: { refusal: true, pattern: false }, polarity: 'attack',
    });
    mocks.importCustomProbes.mockImplementation(async (_db, input) => input.drafts.map((d: object, i: number) => ({ id: `p${i}`, ...d })));
    app = await createFastifyApiTestApp(redTeamApiPlugin, { rawJsonBody: true });
  });

  describe('GET /api/redteam/probes/builtin/:key', () => {
    it('serves the definition of a built-in probe', async () => {
      mocks.getBuiltinProbeDefinition.mockReturnValue({ key: 'markdown-exfil', version: 1, attempts: [] });
      const res = await call(app, 'GET', '/api/redteam/probes/builtin/markdown-exfil');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ probe: { key: 'markdown-exfil', version: 1, attempts: [] } });
      expect(mocks.getBuiltinProbeDefinition).toHaveBeenCalledWith('markdown-exfil');
    });

    it('answers 404 for an unknown or custom key', async () => {
      mocks.getBuiltinProbeDefinition.mockReturnValue(null);
      for (const key of ['nope', 'custom:mine']) {
        const res = await call(app, 'GET', `/api/redteam/probes/builtin/${encodeURIComponent(key)}`);
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'Probe not found' });
      }
    });
  });

  describe('POST /api/redteam/custom-probes', () => {
    it('hands on polarity, named detectors and history', async () => {
      const res = await call(app, 'POST', '/api/redteam/custom-probes', {
        ...BODY,
        polarity: 'attack',
        detectors: { refusal: true, pattern: false, named: ['non-refusal'] },
        attempts: [{
          id: 'a1',
          turns: ['go ahead'],
          history: [{ role: 'user', content: 'can you help?' }, { role: 'assistant', content: 'yes, ask me' }],
        }],
      });
      expect(res.statusCode).toBe(201);
      const input = mocks.createCustomProbe.mock.calls[0][3];
      expect(input.polarity).toBe('attack');
      expect(input.detectors.named).toEqual(['non-refusal']);
      expect(input.attempts[0].history).toEqual([
        { role: 'user', content: 'can you help?' },
        { role: 'assistant', content: 'yes, ask me' },
      ]);
      expect(input.projectId).toBe('proj-1');
    });

    it('turns the pattern detector off by default on an over-refusal probe', async () => {
      const { detectors: _omitted, ...rest } = BODY;
      void _omitted;
      const res = await call(app, 'POST', '/api/redteam/custom-probes', { ...rest, polarity: 'over-refusal' });
      expect(res.statusCode).toBe(201);
      const input = mocks.createCustomProbe.mock.calls[0][3];
      expect(input.polarity).toBe('over-refusal');
      expect(input.detectors.pattern).toBe(false);
    });

    it('accepts the lineage of a clone of a built-in', async () => {
      const probeKey = BUILTIN_PROBE_KEYS[0];
      const res = await call(app, 'POST', '/api/redteam/custom-probes', { ...BODY, clonedFrom: { probeKey, version: 2 } });
      expect(res.statusCode).toBe(201);
      expect(mocks.createCustomProbe.mock.calls[0][3].clonedFrom).toEqual({ probeKey, version: 2 });
    });

    it('refuses a clone whose key is not a built-in or whose version is not a positive integer', async () => {
      const probeKey = BUILTIN_PROBE_KEYS[0];
      for (const clonedFrom of [
        { probeKey: 'custom:other', version: 1 },
        { probeKey: 'no-such-probe', version: 1 },
        { probeKey, version: 0 },
        { probeKey, version: 1.5 },
        { probeKey, version: '1' },
        { probeKey: 7, version: 1 },
      ]) {
        const res = await call(app, 'POST', '/api/redteam/custom-probes', { ...BODY, clonedFrom });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('clonedFrom');
      }
      expect(mocks.createCustomProbe).not.toHaveBeenCalled();
    });

    it('refuses a polarity that is neither attack nor over-refusal', async () => {
      const res = await call(app, 'POST', '/api/redteam/custom-probes', { ...BODY, polarity: 'sideways' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('polarity');
    });

    it('refuses malformed history', async () => {
      const bad: unknown[] = [
        'not a list',
        [{ role: 'system', content: 'x' }],
        [{ role: 'user', content: '   ' }],
        [{ role: 'user' }],
        [null],
        Array.from({ length: CUSTOM_PROBE_LIMITS.maxHistoryMessages + 1 }, () => ({ role: 'user', content: 'x' })),
        [{ role: 'user', content: 'x'.repeat(CUSTOM_PROBE_LIMITS.maxTurnChars + 1) }],
      ];
      for (const history of bad) {
        const res = await call(app, 'POST', '/api/redteam/custom-probes', {
          ...BODY, attempts: [{ id: 'a1', turns: ['hi'], history }],
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('history');
      }
      expect(mocks.createCustomProbe).not.toHaveBeenCalled();
    });

    it('refuses named detectors that are not a list of keys, or too many', async () => {
      for (const named of ['non-refusal', [1], Array.from({ length: CUSTOM_PROBE_LIMITS.maxNamedDetectors + 1 }, () => 'pii')]) {
        const res = await call(app, 'POST', '/api/redteam/custom-probes', { ...BODY, detectors: { refusal: true, pattern: false, named } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toContain('named detector');
      }
    });

    it('refuses a named detector that does not exist', async () => {
      const res = await call(app, 'POST', '/api/redteam/custom-probes', {
        ...BODY, detectors: { refusal: true, pattern: false, named: ['made-up'] },
      });
      expect(res.statusCode).toBe(400);
      expect(mocks.createCustomProbe).not.toHaveBeenCalled();
    });

    it('counts a named detector as a detector', async () => {
      const res = await call(app, 'POST', '/api/redteam/custom-probes', {
        ...BODY, detectors: { refusal: false, pattern: false, named: ['non-refusal'] },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('PATCH /api/redteam/custom-probes/:id', () => {
    it('changes the polarity and the named detectors', async () => {
      const res = await call(app, 'PATCH', '/api/redteam/custom-probes/p1', {
        ...BODY, polarity: 'over-refusal', detectors: { refusal: true, pattern: false },
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.updateCustomProbe.mock.calls[0][3].polarity).toBe('over-refusal');
    });

    it('never passes a clone lineage on', async () => {
      const probeKey = BUILTIN_PROBE_KEYS[0];
      const res = await call(app, 'PATCH', '/api/redteam/custom-probes/p1', { ...BODY, clonedFrom: { probeKey, version: 1 } });
      expect(res.statusCode).toBe(200);
      const data = mocks.updateCustomProbe.mock.calls[0][3];
      expect(data).not.toHaveProperty('clonedFrom');
      expect(data).not.toHaveProperty('origin');
      expect(data).not.toHaveProperty('source');
    });
  });

  describe('POST /api/redteam/custom-probes/import', () => {
    it('creates the probes and answers 201 with them', async () => {
      const res = await call(app, 'POST', '/api/redteam/custom-probes/import', { probes: [DRAFT, { ...DRAFT, name: 'Second' }] });
      expect(res.statusCode).toBe(201);
      expect(res.json().probes).toHaveLength(2);

      const [db, input] = mocks.importCustomProbes.mock.calls[0];
      expect(db).toBe('tenant_db');
      expect(input).toMatchObject({ tenantId: 'tenant-1', projectId: 'proj-1', createdBy: 'user-1' });
      expect(input.drafts[0]).toMatchObject({
        name: 'Harmless prompts',
        family: 'imported',
        polarity: 'over-refusal',
        severity: 'low',
        category: 'LLM09-misinformation',
        source: SOURCE,
      });
      expect(input.drafts[0].attempts[0].id).toBe('row-1');
    });

    it('keeps only the known source fields', async () => {
      await call(app, 'POST', '/api/redteam/custom-probes/import', {
        probes: [{ ...DRAFT, source: { ...SOURCE, importedAt: '2020-01-01', evil: 'x' } }],
      });
      expect(mocks.importCustomProbes.mock.calls[0][1].drafts[0].source).toEqual(SOURCE);
    });

    it('refuses a body with no probes, or more than one import may create', async () => {
      for (const body of [{}, { probes: [] }, { probes: 'x' }]) {
        const res = await call(app, 'POST', '/api/redteam/custom-probes/import', body);
        expect(res.statusCode).toBe(400);
      }
      const many = Array.from({ length: IMPORT_LIMITS.maxProbesPerImport + 1 }, (_, i) => ({ ...DRAFT, name: `P${i}` }));
      const res = await call(app, 'POST', '/api/redteam/custom-probes/import', { probes: many });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain(String(IMPORT_LIMITS.maxProbesPerImport));
      expect(mocks.importCustomProbes).not.toHaveBeenCalled();
    });

    it('names the probe that is not valid and creates nothing', async () => {
      const res = await call(app, 'POST', '/api/redteam/custom-probes/import', {
        probes: [DRAFT, { ...DRAFT, name: 'Broken one', severity: 'enormous' }],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('probe 2');
      expect(res.json().error).toContain('Broken one');
      expect(mocks.importCustomProbes).not.toHaveBeenCalled();
    });

    it('answers 400 with the service message when the service refuses a draft', async () => {
      mocks.importCustomProbes.mockRejectedValue(new RedTeamValidationError('probe 1 ("Harmless prompts"): source.url must be an http or https link'));
      const res = await call(app, 'POST', '/api/redteam/custom-probes/import', { probes: [DRAFT] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('source.url');
    });
  });
});
