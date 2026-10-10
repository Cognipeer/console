/**
 * The IAM center's API client: request shaping, error mapping and the tolerant
 * response normalizers (a missing optional field must become a safe default,
 * never a crash in a table or card).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  IamApiError,
  buildQuery,
  errorMessage,
  iamApi,
  iamLookupApi,
  isAbortError,
  normalizeAudit,
  normalizeCatalog,
  normalizeCompile,
  normalizeDecision,
  normalizeEngineStats,
  normalizeLevels,
  normalizePolicyRow,
  normalizePreview,
  normalizePrincipalDetail,
  normalizePrincipalList,
  normalizeSettings,
  normalizeSimulate,
  normalizeSimulateInput,
  normalizeSpec,
  toAllowed,
} from '@/components/iam/api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => responder(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// ── query / transport ────────────────────────────────────────────────────

describe('buildQuery', () => {
  it('drops empty values and encodes the rest', () => {
    expect(buildQuery({ a: 'x y', b: undefined, c: '', d: null, e: 0, f: false })).toBe('?a=x+y&e=0&f=false');
    expect(buildQuery()).toBe('');
    expect(buildQuery({ a: undefined })).toBe('');
  });
});

describe('transport', () => {
  it('lists policies without caching and normalizes the rows', async () => {
    const fetchMock = mockFetch(() =>
      json({
        managed: [{ id: 'managed:rbac:user-read', name: 'User read', description: 'd', cedar: 'permit(...);' }],
        custom: [{ policyId: 'p1', name: 'Block', effect: 'forbid', enabled: true, cedar: 'forbid(...);' }],
      }),
    );
    const res = await iamApi.listPolicies();
    expect(fetchMock).toHaveBeenCalledWith('/api/iam/policies', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    expect(res.managed).toHaveLength(1);
    expect(res.custom[0]).toMatchObject({ policyId: 'p1', spec: null, description: '', statementCount: 1 });
  });

  it('sends JSON for writes and returns the created row', async () => {
    const fetchMock = mockFetch(() => json({ policyId: 'p9', name: 'n', effect: 'permit', enabled: true, cedar: 'c' }, 201));
    const row = await iamApi.createPolicy({
      name: 'n',
      enabled: true,
      spec: { effect: 'permit', principals: { any: true }, actions: ['Read'], resources: { any: true } },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/iam/policies');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toMatchObject({ name: 'n', spec: { actions: ['Read'] } });
    // A policy is enabled or disabled: no mode travels with it any more.
    expect(JSON.parse(init?.body as string)).not.toHaveProperty('mode');
    expect(row.policyId).toBe('p9');
  });

  it('treats 204 as success with no body', async () => {
    const fetchMock = mockFetch(() => new Response(null, { status: 204 }));
    await expect(iamApi.deletePolicy('p 1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/iam/policies/p%201');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
  });

  it('maps a validation error to IamApiError with line and column', async () => {
    mockFetch(() =>
      json(
        { error: 'Policy is not valid', code: 'validation', details: [{ message: 'unexpected token', line: 3, col: 7 }, { message: 'no action' }] },
        400,
      ),
    );
    const error = await iamApi
      .updatePolicy('p1', { name: 'n', enabled: true, cedar: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IamApiError);
    expect(error).toBeInstanceOf(ApiError); // the shared base class of the center's errors
    const e = error as IamApiError;
    expect(e.status).toBe(400);
    expect(e.code).toBe('validation');
    expect(e.details).toEqual([{ message: 'unexpected token', line: 3, col: 7 }, { message: 'no action' }]);
    expect(errorMessage(e)).toBe('unexpected token; no action');
  });

  it('survives a non-JSON error body', async () => {
    mockFetch(() => new Response('<html>boom</html>', { status: 502 }));
    const e = (await iamApi.getCatalog().catch((x: unknown) => x)) as IamApiError;
    expect(e.status).toBe(502);
    expect(e.message).toBe('HTTP 502');
    expect(e.details).toEqual([]);
  });

  it('keeps the contract on the principal endpoints', async () => {
    const fetchMock = mockFetch(() => json({ items: [], nextCursor: null }));
    await iamApi.listPrincipals({ type: 'user', q: 'ann', limit: 20, cursor: 'c1' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/iam/principals?type=user&q=ann&limit=20&cursor=c1');

    fetchMock.mockImplementation(async () => json({ principal: { type: 'user', id: 'u/1', label: 'Ann' }, effective: [] }));
    await iamApi.getPrincipal('user', 'u/1', 'proj 1');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/iam/principals/user/u%2F1?projectId=proj+1');
  });

  it('builds the audit list and export URLs from the same filters', async () => {
    const fetchMock = mockFetch(() => json({ items: [], nextCursor: null }));
    await iamApi.listAudit({ kind: 'denials', principalType: 'token', principalId: 't1', service: 'agents', limit: 50 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/iam/audit?kind=denials&principalType=token&principalId=t1&service=agents&limit=50');
    expect(iamApi.auditExportUrl({ kind: 'changes', from: '2026-01-01' })).toBe('/api/iam/audit/export?kind=changes&from=2026-01-01');
  });

  it('simulates and replays decisions', async () => {
    const fetchMock = mockFetch((url) =>
      url.includes('/decisions/')
        ? json({
            decisionId: 'dec 1',
            at: '2026-10-01T10:00:00Z',
            principal: { type: 'user', id: 'u1', label: 'Ann' },
            service: 'agents',
            required: 'write',
            route: '/api/agents',
            method: 'POST',
            code: 'forbidden',
            simulateInput: {
              principal: { type: 'user', id: 'u1' },
              action: 'agents.write',
              resource: { kind: 'service', service: 'agents' },
              context: { channel: 'dashboard' },
            },
          })
        : json({ allowed: false, reasons: [], defaultDeny: true, principalSummary: { type: 'user', id: 'u1', label: 'Ann', role: 'user', groups: [] } }),
    );
    const decision = await iamApi.getDecision('dec 1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/iam/decisions/dec%201');
    expect(decision.simulateInput?.action).toBe('agents.write');
    const result = await iamApi.simulate(decision.simulateInput!);
    expect(result).toMatchObject({ allowed: false, defaultDeny: true, projectId: null, ownerSafety: false, enforcedAtGate: true });
    // The retired comparisons are not part of the answer any more.
    expect(result).not.toHaveProperty('mode');
    expect(result).not.toHaveProperty('monitor');
    expect(result).not.toHaveProperty('legacy');
    expect(result.principalSummary.tokenScope).toBeNull();
  });

  it('reads the non-IAM lookups the pickers need', async () => {
    mockFetch((url) => {
      if (url.startsWith('/api/projects')) return json({ activeProjectId: 'p1', projects: [{ _id: 'p1', name: 'Alpha' }, { name: 'no id' }] });
      if (url.startsWith('/api/resources')) {
        return json({ items: [{ type: 'agent', id: 'a1', key: 'support', name: 'Support bot', projectName: 'Alpha' }], total: 1 });
      }
      return json({ userId: 'u1', role: 'admin', servicePermissions: { iam: 'admin', bogus: 3 } });
    });
    expect(await iamLookupApi.listProjects()).toEqual([{ id: 'p1', name: 'Alpha' }]);
    expect(await iamLookupApi.searchResources({ type: 'agent', q: 'sup' })).toEqual({
      items: [{ type: 'agent', id: 'a1', key: 'support', name: 'Support bot', projectName: 'Alpha' }],
      total: 1,
    });
    expect(await iamLookupApi.getSession()).toEqual({
      userId: 'u1',
      role: 'admin',
      servicePermissions: { iam: 'admin' },
      effectivePermissions: null,
      effectiveProjectId: null,
    });
  });

  it('reads what the engine allows per service in the active project from the session', async () => {
    mockFetch(() =>
      json({
        userId: 'u1',
        role: 'user',
        servicePermissions: {},
        effectivePermissions: { models: 'read', agents: 'none', iam: 'bogus', ignored: 7 },
        effectiveProjectId: 'p1',
      }),
    );
    expect(await iamLookupApi.getSession()).toMatchObject({
      effectivePermissions: { models: 'read', agents: 'none', iam: 'none' },
      effectiveProjectId: 'p1',
    });
    // null (the engine could not answer) is not the same as an empty map
    expect(normalizeLevels(null)).toBeNull();
    expect(normalizeLevels({})).toEqual({});
  });

  it('reads the engine health and this workspace\'s counters', async () => {
    const fetchMock = mockFetch(() =>
      json({
        statsScope: 'tenant',
        generatedAt: '2026-10-10T10:00:00.000Z',
        health: { status: 'degraded', message: 'one statement skipped' },
        policySet: { version: 4, custom: 3, skipped: ['custom:p1#0'] },
        undeclaredRoutes: { count: 2, sample: [{ method: 'GET', url: '/api/x' }, { nope: 1 }] },
        engine: { decisions: 9, p50Us: null, p99Us: null, principalCache: { hitRate: null } },
        enforce: { engineDecisions: 9, engineAllows: 7, engineDenies: 2, unavailable: 1, undeclaredDenies: 0, ownerSafety: 3, lastUnavailableAt: '2026-10-10T09:00:00.000Z', lastUnavailableReason: 'engine_unavailable' },
      }),
    );
    const stats = await iamApi.getEngineStats();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/iam/engine/stats');
    expect(stats).toMatchObject({
      statsScope: 'tenant',
      health: { status: 'degraded', message: 'one statement skipped' },
      policySet: { version: 4, custom: 3, skipped: ['custom:p1#0'] },
      decisions: 9,
      allows: 7,
      denies: 2,
      unavailable: 1,
      ownerSafety: 3,
      lastUnavailableReason: 'engine_unavailable',
      p50Us: null,
      cacheHitRate: null,
    });
    expect(stats.undeclaredRoutes).toEqual({ count: 2, sample: [{ method: 'GET', url: '/api/x' }, { method: '', url: '' }] });
  });

  it('on a single-organisation server the process figures and the workspace counters both come through', () => {
    const stats = normalizeEngineStats({
      statsScope: 'process',
      health: { status: 'ok' },
      policySet: null,
      engine: { decisions: 100, p50Us: 120, p99Us: 900, principalCache: { hitRate: 0.874 } },
      enforce: { engineDecisions: 100, engineAllows: 90, engineDenies: 10 },
      tenantEnforce: { engineDecisions: 40, engineAllows: 35, engineDenies: 5, unavailable: 0 },
    });
    // The workspace's own counters win over the server-wide ones.
    expect(stats).toMatchObject({ statsScope: 'process', decisions: 40, allows: 35, denies: 5, p50Us: 120, p99Us: 900, cacheHitRate: 0.874, policySet: null });
    expect(stats.health).toEqual({ status: 'ok', message: null });
    expect(normalizeEngineStats('garbage')).toMatchObject({ statsScope: 'process', decisions: 0, health: { status: 'ok' } });
  });

  it('recognises an aborted request', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

// ── normalizers ──────────────────────────────────────────────────────────

describe('normalizeCatalog', () => {
  it('fills defaults for missing parts', () => {
    const c = normalizeCatalog({
      services: [{ id: 'agents', labelKey: 'k', adminService: true }, { nope: 1 }],
      actions: [
        { id: 'agent.invoke', kind: 'resource', level: 'write', service: 'agents', resourceType: 'agent', verb: 'invoke', labelKey: 'k', labelParams: { type: 'agent', n: 5 } },
        { id: 'Read', kind: 'group', level: 'read' },
        { id: 'weird', kind: 'unheard-of', level: 'sideways' },
      ],
    });
    expect(c.services).toEqual([{ id: 'agents', labelKey: 'k', adminService: true }]);
    expect(c.actions[0].labelParams).toEqual({ type: 'agent' }); // non-string params dropped
    expect(c.actions[1]).toMatchObject({ kind: 'group', labelKey: '', labelParams: {} });
    expect(c.actions[2]).toMatchObject({ kind: 'service', level: 'read' });
    expect(c.channels).toEqual(['dashboard', 'api', 'portal']);
    expect(c.contextAttrs).toEqual([]);
  });

  it('reads where an action is checked, keeping only real channels', () => {
    const c = normalizeCatalog({
      actions: [
        { id: 'portal.use', kind: 'resource', level: 'read', enforcedIn: ['portal'] },
        { id: 'agents.write', kind: 'service', level: 'write', enforcedIn: ['dashboard', 'api', 'smoke-signal', 7] },
        { id: 'agent.delete', kind: 'resource', level: 'write', enforcedIn: [] },
        { id: 'Read', kind: 'group', level: 'read' },
      ],
    });
    expect(c.actions[0].enforcedIn).toEqual(['portal']);
    expect(c.actions[1].enforcedIn).toEqual(['dashboard', 'api']);
    expect(c.actions[2]).not.toHaveProperty('enforcedIn'); // nothing asks it: only the Access check evaluates it
    expect(c.actions[3]).not.toHaveProperty('enforcedIn');
  });
});

describe('normalizeSpec / normalizePolicyRow', () => {
  it('reads {any:true} principals and resources, and collapses empty restrictions to anywhere', () => {
    expect(normalizeSpec({ effect: 'permit', principals: { any: true }, actions: ['Read'], resources: { services: [] } })).toEqual({
      effect: 'permit',
      principals: { any: true },
      actions: ['Read'],
      resources: { any: true },
    });
  });

  it('keeps only valid resource refs, channels and strings', () => {
    const spec = normalizeSpec({
      effect: 'forbid',
      principals: { users: ['u1', 7], groups: ['g1'], anyToken: true },
      actions: ['Write', null],
      resources: { resources: [{ type: 'agent', id: 'a1' }, { type: 'agent' }], projects: ['p1'] },
      conditions: { channels: ['api', 'smoke-signal'], ipRanges: ['10.0.0.0/8'], validUntil: '2026-12-31T00:00:00Z' },
    });
    expect(spec).toEqual({
      effect: 'forbid',
      principals: { users: ['u1'], groups: ['g1'], anyToken: true },
      actions: ['Write'],
      resources: { projects: ['p1'], resources: [{ type: 'agent', id: 'a1' }] },
      conditions: { validUntil: '2026-12-31T00:00:00Z', ipRanges: ['10.0.0.0/8'], channels: ['api'] },
    });
    expect(normalizeSpec(null)).toBeNull();
    expect(normalizeSpec([])).toBeNull();
  });

  it('defaults a row the way the table needs it', () => {
    const row = normalizePolicyRow({ policyId: 'p1', effect: 'something-else' });
    expect(row).toMatchObject({ name: 'p1', effect: 'mixed', enabled: true, spec: null });
    expect(normalizePolicyRow({ policyId: 'p2', enabled: false })).toMatchObject({ enabled: false });
  });

  it('knows nothing of modes: a policy is enabled or disabled', () => {
    // A server that still sent the retired fields would change nothing about the row.
    const row = normalizePolicyRow({ policyId: 'p3', mode: 'monitor', enabled: false, monitorStats: { wouldAllow: 3, wouldDeny: 1 } });
    expect(row.enabled).toBe(false);
    expect(row).not.toHaveProperty('mode');
    expect(row).not.toHaveProperty('monitorStats');
  });
});

describe('normalizeSimulate', () => {
  it('reads reasons, the project and the principal summary', () => {
    const r = normalizeSimulate({
      allowed: true,
      reasons: [{ cedarId: 'managed:rbac:user-read', policyId: null, managed: true, name: 'User read', effect: 'permit' }, { cedarId: 'custom:p1', policyId: 'p1', name: 'Mine', effect: 'forbid' }],
      defaultDeny: false,
      principalSummary: { type: 'token', id: 't1', label: 'ci', role: 'admin', groups: [{ id: 'g1', name: 'Sales' }], tokenScope: { agents: 'read' } },
      projectId: 'p-alpha',
      ownerSafety: true,
    });
    expect(r.reasons[1]).toMatchObject({ managed: false, effect: 'forbid', policyId: 'p1' });
    expect(r.reasons[0].managed).toBe(true);
    expect(r.principalSummary).toMatchObject({ groups: [{ id: 'g1', name: 'Sales' }], tokenScope: { agents: 'read' } });
    expect(r).toMatchObject({ projectId: 'p-alpha', ownerSafety: true, enforcedAtGate: true, errors: [] });
  });

  it('infers managed from the Cedar id when the flag is missing', () => {
    expect(normalizeSimulate({ reasons: [{ cedarId: 'managed:boundary:x' }] }).reasons[0].managed).toBe(true);
    expect(normalizeSimulate({})).toMatchObject({ allowed: false, defaultDeny: false, projectId: null });
  });

  it('reads the portal a check was about, and nothing when there was none', () => {
    const r = normalizeSimulate({
      allowed: false,
      portal: { id: 'P1', key: 'branch', name: 'Branch assistant', status: 'disabled', mode: 'all', userCount: 3, groupCount: 'many' },
    });
    expect(r.portal).toEqual({ id: 'P1', key: 'branch', name: 'Branch assistant', status: 'disabled', mode: 'all', userCount: 3, groupCount: 0 });
    expect(normalizeSimulate({ portal: { id: 'P2' } }).portal).toMatchObject({ name: 'P2', status: 'enabled', mode: 'selected' });
    expect(normalizeSimulate({}).portal).toBeNull();
    expect(normalizeSimulate({ portal: { name: 'no id' } }).portal).toBeNull();
  });

  it('distinguishes an empty token scope from no scope', () => {
    expect(normalizeSimulate({ principalSummary: { tokenScope: {} } }).principalSummary.tokenScope).toEqual({});
    expect(normalizeSimulate({ principalSummary: { tokenScope: null } }).principalSummary.tokenScope).toBeNull();
  });
});

describe('normalizeSimulateInput / normalizeDecision', () => {
  it('accepts the three resource kinds and rejects incomplete input', () => {
    const base = { principal: { type: 'user', id: 'u1' }, action: 'a' };
    expect(normalizeSimulateInput({ ...base, resource: { kind: 'project', projectId: 'p1' } })?.resource).toEqual({ kind: 'project', projectId: 'p1' });
    expect(normalizeSimulateInput({ ...base, resource: { kind: 'resource', type: 'agent', id: 'a' } })?.resource).toEqual({ kind: 'resource', type: 'agent', id: 'a' });
    expect(normalizeSimulateInput({ ...base, resource: { kind: 'service' } })).toBeNull();
    expect(normalizeSimulateInput({ ...base, principal: { type: 'group', id: 'g' }, resource: { kind: 'service', service: 's' } })).toBeNull();
    expect(normalizeSimulateInput(undefined)).toBeNull();
  });

  it('keeps the portal an agent is run through, and the channel, resource and policies of a portal refusal', () => {
    const input = normalizeSimulateInput({
      principal: { type: 'user', id: 'u1' }, action: 'agent.invoke', resource: { kind: 'resource', type: 'agent', id: 'a1' },
      context: { channel: 'portal', portalId: 'P1', ip: '10.0.0.1', at: '2026-10-10T09:00:00.000Z' },
    });
    expect(input?.context).toEqual({ channel: 'portal', portalId: 'P1', ip: '10.0.0.1', at: '2026-10-10T09:00:00.000Z' });
    const d = normalizeDecision({
      decisionId: 'd1', code: 'forbidden', channel: 'portal', resource: { type: 'portal', id: 'P1', label: 'Branch assistant' },
      policyIds: ['p-1', 'p-2', 'p-3'],
      policies: [{ policyId: 'p-1', name: 'Freeze', status: 'disabled' }, { policyId: 'p-2', name: null, status: 'deleted' }, { policyId: 'p-3', status: 'who-knows' }, { name: 'no id' }],
    });
    expect(d).toMatchObject({ channel: 'portal', resource: { type: 'portal', id: 'P1', label: 'Branch assistant' } });
    expect(d.policies).toEqual([
      { policyId: 'p-1', name: 'Freeze', status: 'disabled' },
      { policyId: 'p-2', name: null, status: 'deleted' },
      { policyId: 'p-3', name: null, status: 'active' }, // a state it does not know is not claimed to be a change
    ]);
  });

  it('falls back to the bare ids from a server that does not describe the policies, and to no channel or resource', () => {
    const d = normalizeDecision({ decisionId: 'd2', policyIds: ['p-9'] });
    expect(d.policies).toEqual([{ policyId: 'p-9', name: null, status: 'active' }]);
    expect(d.channel).toBeNull();
    expect(d.resource).toBeNull();
  });

  it('keeps a decision usable when the server cannot reconstruct the request', () => {
    const d = normalizeDecision({ decisionId: 'd1', principal: { id: 'u1' }, simulateInput: { broken: true } });
    expect(d.decisionId).toBe('d1');
    expect(d.principal).toEqual({ type: 'user', id: 'u1', label: 'u1' });
    expect(d.simulateInput).toBeNull();
  });
});

describe('normalizePreview / normalizeCompile', () => {
  it('reads verdicts in the usual spellings', () => {
    expect(toAllowed(true)).toBe(true);
    expect(toAllowed('allow')).toBe(true);
    expect(toAllowed('Denied')).toBe(false);
    expect(toAllowed('maybe')).toBeNull();
    const p = normalizePreview({
      evaluated: 12,
      truncated: true,
      flips: { allowToDeny: 2, denyToAllow: 0 },
      samples: [{ principal: { type: 'user', id: 'u1', label: 'Ann' }, action: 'agents.write', resource: 'agents', before: 'allow', after: false }],
    });
    expect(p).toMatchObject({ evaluated: 12, truncated: true, flips: { allowToDeny: 2, denyToAllow: 0 } });
    expect(p.samples[0]).toMatchObject({ before: true, after: false });
    expect(normalizePreview({}).flips).toEqual({ allowToDeny: 0, denyToAllow: 0 });
  });

  it('derives ok from the errors when the server omits it', () => {
    expect(normalizeCompile({ cedar: 'x', errors: [] })).toMatchObject({ ok: true, cedar: 'x', warnings: [] });
    expect(normalizeCompile({ cedar: '', errors: [{ message: 'bad', line: 2 }] })).toMatchObject({ ok: false, errors: [{ message: 'bad', line: 2 }] });
    expect(normalizeCompile({ ok: false, errors: ['plain string'] }).errors).toEqual([{ message: 'plain string' }]);
  });
});

describe('principals / audit / settings', () => {
  it('reads a principal page with its optional fields', () => {
    const page = normalizePrincipalList({
      items: [
        { type: 'group', id: 'g1', label: 'Sales', sublabel: '12 members', memberCount: 12, policyCount: 2 },
        { type: 'user', id: 'u1', label: 'Ann', role: 'admin', status: 'active' },
      ],
      nextCursor: 'abc',
    });
    expect(page.nextCursor).toBe('abc');
    expect(page.items[0]).toMatchObject({ memberCount: 12, policyCount: 2 });
    expect(page.items[1]).toMatchObject({ role: 'admin', policyCount: 0, sublabel: '' });
    expect(normalizePrincipalList({}).nextCursor).toBeNull();
  });

  it('reads the effective permission table', () => {
    const d = normalizePrincipalDetail({
      principal: { type: 'user', id: 'u1', label: 'Ann', role: 'admin' },
      effective: [{ service: 'agents', level: 'write', sources: [{ kind: 'group', label: 'Sales', level: 'write' }, { kind: 'mystery', label: 'x', level: 'read' }] }, { service: 'iam', level: 'nonsense' }],
      groups: [{ id: 'g1', name: 'Sales' }],
      projects: [{ id: 'p1', name: 'Alpha', role: 'member' }],
      policies: [{ policyId: 'p1', name: 'P' }],
    });
    expect(d.principal).toMatchObject({ id: 'u1', label: 'Ann', role: 'admin' });
    expect(d.effective[0].sources.map((s) => s.kind)).toEqual(['group', 'role']);
    expect(d.effective[1].level).toBe('none');
    expect(d.policies[0].policyId).toBe('p1');
    expect(d.tokens).toBeNull();
  });

  it('reads audit rows and token settings', () => {
    const a = normalizeAudit({
      items: [{ id: '1', at: 'now', kind: 'changes', principal: { type: 'token', id: 't1', label: 'ci' }, service: 'agents', action: 'agents.write', decisionId: 'd1', summary: 's' }, { id: '2', kind: 'bogus' }, { id: '3', kind: 'monitor' }],
      nextCursor: null,
    });
    expect(a.items[0]).toMatchObject({ kind: 'changes', decisionId: 'd1', principal: { id: 't1' } });
    // The retired monitor rows read as ordinary denials.
    expect(a.items[2]).toMatchObject({ kind: 'denials' });
    expect(a.items[1]).toMatchObject({ kind: 'denials', principal: null, decisionId: null });
    expect(normalizeSettings({ tokens: { maxLifetimeDays: 90, requireExpiry: true } })).toEqual({ tokens: { maxLifetimeDays: 90, requireExpiry: true } });
    expect(normalizeSettings({ tokens: { maxLifetimeDays: 0 } })).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
    expect(normalizeSettings(undefined)).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
  });
});

describe('policies of the portal group', () => {
  it('maps a built-in portal rule to its own group, and keeps the scope a filtered list adds', async () => {
    mockFetch(() => json({
      managed: [
        { id: 'managed:rbac:user-read', group: 'rbac', effect: 'permit' },
        { id: 'managed:boundary:project-read', group: 'boundary', effect: 'forbid' },
        { id: 'managed:portal:use-boundary', group: 'portal', effect: 'forbid' },
        { id: 'managed:portal:agent', effect: 'permit' }, // an older server that sends no group: the id says it
      ],
      custom: [{ policyId: 'p1', scope: 'this' }, { policyId: 'p2', scope: 'all' }, { policyId: 'p3', scope: 'nonsense' }, { policyId: 'p4' }],
    }));
    const { managed, custom } = await iamApi.listPolicies();
    expect(managed.map((m) => m.group)).toEqual(['rbac', 'boundary', 'portal', 'portal']);
    expect(custom.map((p) => p.scope)).toEqual(['this', 'all', undefined, undefined]);
  });
});
