import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IamApiError,
} from '@/components/iam/principals/client';
import {
  auditExportUrl,
  auditFiltersFromParams,
  auditFiltersKey,
  auditListUrl,
  auditPrincipalTypes,
  actionLabelKey,
  catalogActionOf,
  defaultExportFilename,
  downloadAuditCsv,
  emptyAuditFilters,
  endOfDay,
  fetchAudit,
  filenameFromDisposition,
  hasActiveFilters,
  isoToRange,
  lastDaysRange,
  normalizeFiltersForKind,
  parseAuditItem,
  parseAuditKind,
  parseAuditPage,
  rangeToIso,
  startOfDay,
  toYmd,
  type AuditFilters,
} from '@/components/iam/audit/client';

const filters = (patch: Partial<AuditFilters> = {}): AuditFilters => ({ ...emptyAuditFilters('denials'), ...patch });

describe('audit kinds and filters', () => {
  it('accepts the two kinds and their singular aliases', () => {
    expect(parseAuditKind('denials')).toBe('denials');
    expect(parseAuditKind('Denial')).toBe('denials');
    expect(parseAuditKind('change')).toBe('changes');
    // The monitor view no longer exists: an old link to it opens the default view instead.
    expect(parseAuditKind('monitor')).toBeNull();
    expect(auditFiltersFromParams(new URLSearchParams('tab=audit&kind=monitor&service=models'))).toMatchObject({
      kind: 'denials',
      service: 'models',
    });
    expect(parseAuditKind('nope')).toBeNull();
    expect(parseAuditKind(undefined)).toBeNull();
  });

  it('reads filters from the address bar', () => {
    const params = new URLSearchParams(
      'tab=audit&kind=changes&principalType=user&principalId=u1&service=models&from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z',
    );
    expect(auditFiltersFromParams(params)).toEqual({
      kind: 'changes',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      principalType: 'user',
      principalId: 'u1',
      service: 'models',
    });
  });

  it('defaults to denials and ignores what it cannot use', () => {
    expect(auditFiltersFromParams(new URLSearchParams('tab=audit'))).toEqual(emptyAuditFilters('denials'));
    // a principal is a (type, id) pair
    expect(auditFiltersFromParams(new URLSearchParams('principalId=u1')).principalId).toBeNull();
    expect(auditFiltersFromParams(new URLSearchParams('principalType=user')).principalType).toBeNull();
    expect(auditFiltersFromParams(new URLSearchParams('principalType=robot&principalId=x')).principalId).toBeNull();
    // an unparseable date is dropped
    expect(auditFiltersFromParams(new URLSearchParams('from=yesterday&to=')).from).toBeNull();
  });

  it('offers each view the principals it can be filtered by', () => {
    expect(auditPrincipalTypes('denials')).toEqual(['user', 'token', 'group']);
    expect(auditPrincipalTypes('changes')).toEqual(['user']);

    const group = (kind: string) =>
      auditFiltersFromParams(new URLSearchParams(`kind=${kind}&principalType=group&principalId=g1`));
    expect(group('denials')).toMatchObject({ principalType: 'group', principalId: 'g1' });
    expect(group('changes')).toMatchObject({ principalType: null, principalId: null });
    const token = auditFiltersFromParams(new URLSearchParams('kind=changes&principalType=token&principalId=t1'));
    expect(token).toMatchObject({ kind: 'changes', principalType: null, principalId: null });
  });

  it('keeps the other filters when a view cannot use the principal', () => {
    const f = filters({ kind: 'changes', service: 'iam', principalType: 'token', principalId: 't1' });
    expect(normalizeFiltersForKind(f)).toEqual({ ...f, principalType: null, principalId: null });
    const ok = filters({ kind: 'denials', principalType: 'group', principalId: 'g1' });
    expect(normalizeFiltersForKind(ok)).toBe(ok);
  });

  it('knows when a filter is active (the kind is not a filter)', () => {
    expect(hasActiveFilters(filters())).toBe(false);
    expect(hasActiveFilters(filters({ kind: 'changes' }))).toBe(false);
    expect(hasActiveFilters(filters({ service: 'models' }))).toBe(true);
    expect(hasActiveFilters(filters({ from: '2026-10-01T00:00:00.000Z' }))).toBe(true);
    expect(hasActiveFilters(filters({ principalType: 'token', principalId: 't' }))).toBe(true);
  });

  it('keys differ per filter value', () => {
    const keys = new Set([
      auditFiltersKey(filters()),
      auditFiltersKey(filters({ kind: 'changes' })),
      auditFiltersKey(filters({ service: 'models' })),
      auditFiltersKey(filters({ from: 'a' })),
      auditFiltersKey(filters({ principalType: 'user', principalId: 'u' })),
    ]);
    expect(keys.size).toBe(5);
    expect(auditFiltersKey(filters())).toBe(auditFiltersKey(filters()));
  });
});

describe('audit URLs', () => {
  it('builds the list URL', () => {
    expect(auditListUrl(filters())).toBe('/api/iam/audit?kind=denials&limit=25');
    expect(
      auditListUrl(
        filters({
          kind: 'changes',
          from: '2026-10-01T00:00:00.000Z',
          to: '2026-10-02T23:59:59.999Z',
          principalType: 'token',
          principalId: 't 1',
          service: 'models',
        }),
        { limit: 50, cursor: 'next/1' },
      ),
    ).toBe(
      '/api/iam/audit?kind=changes&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-02T23%3A59%3A59.999Z&principalType=token&principalId=t+1&service=models&limit=50&cursor=next%2F1',
    );
  });

  it('sends a principal only as a pair', () => {
    expect(auditListUrl(filters({ principalType: 'user', principalId: null }))).not.toContain('principal');
    expect(auditListUrl(filters({ principalType: null, principalId: 'u' }))).not.toContain('principal');
  });

  it('the export URL has the same filters and no paging', () => {
    const f = filters({ kind: 'changes', service: 'iam' });
    expect(auditExportUrl(f)).toBe('/api/iam/audit/export?kind=changes&service=iam');
  });
});

describe('date range', () => {
  it('covers whole local days', () => {
    const start = new Date(2026, 9, 5, 15, 30);
    const end = new Date(2026, 9, 7, 8, 0);
    const { from, to } = rangeToIso([start, end]);
    expect(new Date(from!).getTime()).toBe(new Date(2026, 9, 5, 0, 0, 0, 0).getTime());
    expect(new Date(to!).getTime()).toBe(new Date(2026, 9, 7, 23, 59, 59, 999).getTime());
    expect(rangeToIso([null, null])).toEqual({ from: null, to: null });
    expect(rangeToIso([start, null])).toMatchObject({ to: null });
  });

  it('does not mutate its input', () => {
    const d = new Date(2026, 9, 5, 15, 30);
    startOfDay(d);
    endOfDay(d);
    expect(d.getHours()).toBe(15);
  });

  it('round-trips into picker values', () => {
    expect(isoToRange(null, null)).toEqual([null, null]);
    const [a, b] = isoToRange('2026-10-01T00:00:00.000Z', 'garbage');
    expect(a).toBeInstanceOf(Date);
    expect(b).toBeNull();
  });

  it('formats local dates and "last N days" presets', () => {
    expect(toYmd(new Date(2026, 0, 5))).toBe('2026-01-05');
    const now = new Date(2026, 9, 9, 13, 0);
    expect(lastDaysRange(1, now)).toEqual(['2026-10-09', '2026-10-09']);
    expect(lastDaysRange(7, now)).toEqual(['2026-10-03', '2026-10-09']);
    expect(lastDaysRange(30, now)).toEqual(['2026-09-10', '2026-10-09']);
  });
});

describe('audit items', () => {
  it('parses a denial of the contract shape', () => {
    const item = parseAuditItem(
      {
        id: 'a1',
        at: '2026-10-09T10:00:00.000Z',
        kind: 'denials',
        principal: { type: 'user', id: 'u1', label: 'Ada' },
        service: 'models',
        action: 'write',
        route: '/api/models/:id',
        method: 'PUT',
        code: 'forbidden',
        decisionId: 'd-123',
        policyId: 'pol-1',
        summary: 'Denied by Deny exports',
      },
      0,
      'denials',
    );
    expect(item).toEqual({
      id: 'a1',
      at: '2026-10-09T10:00:00.000Z',
      kind: 'denials',
      principal: { type: 'user', id: 'u1', label: 'Ada' },
      actor: null,
      service: 'models',
      action: 'write',
      route: '/api/models/:id',
      method: 'PUT',
      code: 'forbidden',
      decisionId: 'd-123',
      policyId: 'pol-1',
      summary: 'Denied by Deny exports',
      text: null,
    });
  });

  it('keeps the sentence-as-data a server sends, and drops what is not a key or a plain value', () => {
    const withText = parseAuditItem({
      id: 'x', summary: 'Denied', text: { key: 'denied.policy', params: { route: 'GET /a', count: 3, nested: { no: 1 }, nan: Number.NaN, flag: true } },
    }, 0, 'denials');
    expect(withText.text).toEqual({ key: 'denied.policy', params: { route: 'GET /a', count: 3 } });
    for (const bad of [undefined, null, 'text', {}, { key: '' }, { params: {} }, { key: 5 }]) {
      expect(parseAuditItem({ id: 'x', text: bad }, 0, 'denials').text, JSON.stringify(bad)).toBeNull();
    }
  });

  it('accepts the actor as text or as an object, and defaults the rest', () => {
    expect(parseAuditItem({ id: 'x', actor: 'ada@example.com' }, 0, 'changes').actor).toBe('ada@example.com');
    expect(parseAuditItem({ id: 'x', actor: { id: 'u1', label: 'Ada' } }, 0, 'changes').actor).toBe('Ada');
    expect(parseAuditItem({ id: 'x', actor: { email: 'a@b.c' } }, 0, 'changes').actor).toBe('a@b.c');
    expect(parseAuditItem({ id: 'x', actor: 12 }, 0, 'changes').actor).toBeNull();
    const bare = parseAuditItem({}, 3, 'changes');
    expect(bare).toMatchObject({ kind: 'changes', principal: null, service: '', action: '', summary: '', decisionId: null });
    expect(bare.id).toBe('changes::3');
  });

  it('labels a principal with its id when the label is missing and keeps unknown types', () => {
    expect(parseAuditItem({ id: 'x', principal: { type: 'user', id: 'u9' } }, 0, 'denials').principal).toEqual({
      type: 'user',
      id: 'u9',
      label: 'u9',
    });
    expect(parseAuditItem({ id: 'x', principal: { type: 'system', id: 's', label: 'Cron' } }, 0, 'denials').principal?.type).toBe('system');
    expect(parseAuditItem({ id: 'x', principal: { label: 'no id' } }, 0, 'denials').principal).toBeNull();
  });

  it('normalises a singular kind and falls back to the requested one', () => {
    expect(parseAuditItem({ id: 'x', kind: 'denial' }, 0, 'changes').kind).toBe('denials');
    expect(parseAuditItem({ id: 'x', kind: 'whatever' }, 0, 'changes').kind).toBe('changes');
  });

  it('parses a page: repeated ids are dropped and the cursor is optional', () => {
    const page = parseAuditPage(
      { items: [{ id: 'a' }, { id: 'a' }, { id: 'b' }, 'junk', null, {}, { summary: 'no id' }], nextCursor: 'n' },
      'denials',
    );
    // junk and empty objects would render as blank rows: they are dropped; a row without an id gets a stable one
    expect(page.items.map((i) => i.id)).toEqual(['a', 'b', 'denials::6']);
    expect(page.nextCursor).toBe('n');
    expect(parseAuditPage(undefined, 'changes')).toEqual({ items: [], nextCursor: null, warnings: [] });
    // the reasons a page may be incomplete travel along; anything that is not text is dropped
    expect(parseAuditPage({ items: [], warnings: ['group_members_truncated', 5, '', 'paging_capped'] }, 'denials').warnings)
      .toEqual(['group_members_truncated', 'paging_capped']);
  });

  it('derives the catalog action of a denial', () => {
    // the server records the gate action
    expect(catalogActionOf({ service: 'models', action: 'models.write' })).toBe('models.write');
    // a bare required level next to the service is turned into one
    expect(catalogActionOf({ service: 'models', action: 'write' })).toBe('models.write');
    // a change event, a resource action of another service, an undeclared route: nothing to re-check
    expect(catalogActionOf({ service: 'iam', action: 'iam.policy.create' })).toBeNull();
    expect(catalogActionOf({ service: 'agents', action: 'agent.invoke' })).toBeNull();
    expect(catalogActionOf({ service: 'iam', action: 'security' })).toBeNull();
    expect(catalogActionOf({ service: '', action: 'read' })).toBeNull();
  });

  it('shows the part of an action that the service name does not already say', () => {
    expect(actionLabelKey({ service: 'models', action: 'models.write' })).toBe('write');
    expect(actionLabelKey({ service: 'models', action: 'write' })).toBe('write');
    expect(actionLabelKey({ service: 'agents', action: 'agent.invoke' })).toBe('agent.invoke');
    expect(actionLabelKey({ service: 'iam', action: 'iam.policy.create' })).toBe('policy.create');
  });
});

describe('audit requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches and parses a page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'a', summary: 'x' }], nextCursor: 'c' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await fetchAudit(filters({ kind: 'changes' }), { limit: 10, cursor: 'k' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/iam/audit?kind=changes&limit=10&cursor=k');
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('c');
  });

  it('reports a failed export as an IamApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'No', code: 'forbidden' }), { status: 403 })),
    );
    await expect(downloadAuditCsv(filters())).rejects.toBeInstanceOf(IamApiError);
  });

  it('names the exported file from the response or from the filters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('a,b\n1,2\n', { status: 200, headers: { 'content-disposition': 'attachment; filename="audit.csv"' } }),
      ),
    );
    const named = await downloadAuditCsv(filters());
    expect(named.filename).toBe('audit.csv');
    expect(await named.blob.text()).toBe('a,b\n1,2\n');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', { status: 200 })));
    const unnamed = await downloadAuditCsv(filters({ kind: 'changes' }));
    expect(unnamed.filename).toMatch(/^iam-audit-changes-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('reads Content-Disposition in its plain and extended forms', () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition('attachment')).toBeNull();
    expect(filenameFromDisposition('attachment; filename=plain.csv')).toBe('plain.csv');
    expect(filenameFromDisposition('attachment; filename="quoted name.csv"')).toBe('quoted name.csv');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.csv")).toBe('résumé.csv');
    expect(filenameFromDisposition('attachment; filename="fallback.csv"; filename*=UTF-8\'\'real.csv')).toBe('real.csv');
    expect(defaultExportFilename('denials', new Date(2026, 9, 9))).toBe('iam-audit-denials-2026-10-09.csv');
  });
});
