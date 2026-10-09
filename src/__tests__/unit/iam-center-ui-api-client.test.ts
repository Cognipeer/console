/**
 * The IAM center's API client: request shaping, error mapping and the tolerant
 * response normalizers (a missing optional field must become a safe default,
 * never a crash in a table or card).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/components/settings/authorizationEngineData';
import {
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
        custom: [{ policyId: 'p1', name: 'Block', effect: 'forbid', mode: 'monitor', enabled: true, cedar: 'forbid(...);' }],
      }),
    );
    const res = await iamApi.listPolicies();
    expect(fetchMock).toHaveBeenCalledWith('/api/iam/policies', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    expect(res.managed).toHaveLength(1);
    expect(res.custom[0]).toMatchObject({ policyId: 'p1', spec: null, monitorStats: null, description: '', statementCount: 1 });
  });

  it('sends JSON for writes and returns the created row', async () => {
    const fetchMock = mockFetch(() => json({ policyId: 'p9', name: 'n', effect: 'permit', mode: 'monitor', enabled: true, cedar: 'c' }, 201));
    const row = await iamApi.createPolicy({
      name: 'n',
      mode: 'monitor',
      enabled: true,
      spec: { effect: 'permit', principals: { any: true }, actions: ['Read'], resources: { any: true } },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/iam/policies');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toMatchObject({ name: 'n', spec: { actions: ['Read'] } });
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
      .updatePolicy('p1', { name: 'n', mode: 'enforce', enabled: true, cedar: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IamApiError);
    expect(error).toBeInstanceOf(ApiError); // keeps the engine page's error handling working
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
        : json({ allowed: false, reasons: [], defaultDeny: true, mode: 'enforce', principalSummary: { type: 'user', id: 'u1', label: 'Ann', role: 'user', groups: [] } }),
    );
    const decision = await iamApi.getDecision('dec 1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/iam/decisions/dec%201');
    expect(decision.simulateInput?.action).toBe('agents.write');
    const result = await iamApi.simulate(decision.simulateInput!);
    expect(result).toMatchObject({ allowed: false, defaultDeny: true, mode: 'enforce', monitor: null, legacy: null });
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
    expect(await iamLookupApi.getSession()).toEqual({ userId: 'u1', role: 'admin', servicePermissions: { iam: 'admin' } });
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
    const row = normalizePolicyRow({
      policyId: 'p1',
      effect: 'something-else',
      monitorStats: { wouldAllow: 3, wouldDeny: 1, since: '2026-10-01T00:00:00Z' },
    });
    expect(row).toMatchObject({
      name: 'p1',
      effect: 'mixed',
      mode: 'enforce',
      enabled: true,
      spec: null,
      monitorStats: { wouldAllow: 3, wouldDeny: 1, since: '2026-10-01T00:00:00Z' },
    });
    expect(normalizePolicyRow({ policyId: 'p2', mode: 'monitor', enabled: false, monitorStats: null })).toMatchObject({
      mode: 'monitor',
      enabled: false,
      monitorStats: null,
    });
  });
});

describe('normalizeSimulate', () => {
  it('reads reasons, monitor, legacy and the principal summary', () => {
    const r = normalizeSimulate({
      allowed: true,
      reasons: [{ cedarId: 'managed:rbac:user-read', policyId: null, managed: true, name: 'User read', effect: 'permit' }, { cedarId: 'custom:p1', policyId: 'p1', name: 'Mine', effect: 'forbid' }],
      defaultDeny: false,
      monitor: { allowed: false, differs: true, reasons: [{ cedarId: 'custom:m', policyId: 'm', managed: false, name: 'M', effect: 'forbid' }] },
      legacy: { allowed: true, service: 'agents', required: 'read' },
      principalSummary: { type: 'token', id: 't1', label: 'ci', role: 'admin', groups: [{ id: 'g1', name: 'Sales' }], tokenScope: { agents: 'read' } },
      mode: 'shadow',
    });
    expect(r.reasons[1]).toMatchObject({ managed: false, effect: 'forbid', policyId: 'p1' });
    expect(r.reasons[0].managed).toBe(true);
    expect(r.monitor).toMatchObject({ allowed: false, differs: true });
    expect(r.legacy).toEqual({ allowed: true, service: 'agents', required: 'read' });
    expect(r.principalSummary).toMatchObject({ groups: [{ id: 'g1', name: 'Sales' }], tokenScope: { agents: 'read' } });
    expect(r.mode).toBe('shadow');
  });

  it('infers managed from the Cedar id when the flag is missing', () => {
    expect(normalizeSimulate({ reasons: [{ cedarId: 'managed:boundary:x' }] }).reasons[0].managed).toBe(true);
    expect(normalizeSimulate({}).mode).toBe('legacy');
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
      items: [{ id: '1', at: 'now', kind: 'monitor', principal: { type: 'token', id: 't1', label: 'ci' }, service: 'agents', action: 'agents.write', decisionId: 'd1', summary: 's' }, { id: '2', kind: 'bogus' }],
      nextCursor: null,
    });
    expect(a.items[0]).toMatchObject({ kind: 'monitor', decisionId: 'd1', principal: { id: 't1' } });
    expect(a.items[1]).toMatchObject({ kind: 'denials', principal: null, decisionId: null });
    expect(normalizeSettings({ tokens: { maxLifetimeDays: 90, requireExpiry: true } })).toEqual({ tokens: { maxLifetimeDays: 90, requireExpiry: true } });
    expect(normalizeSettings({ tokens: { maxLifetimeDays: 0 } })).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
    expect(normalizeSettings(undefined)).toEqual({ tokens: { maxLifetimeDays: null, requireExpiry: false } });
  });
});
