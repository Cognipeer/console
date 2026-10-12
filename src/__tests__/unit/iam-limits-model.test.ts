/**
 * The Limits tab's pure model (parsing the API answer, filtering, the amounts a
 * limit states) and the quota editor's picker sources.
 */
import { describe, expect, it } from 'vitest';
import {
  duplicateSeed,
  filterLimitRows,
  formatAmountValue,
  humanizeKey,
  isInertLimit,
  limitAmounts,
  limitStats,
  parseLimitRow,
  parseLimitRows,
  sortLimitRows,
  type LimitRow,
} from '@/components/iam/limits/limitsModel';
import { PICKER_LIMIT, searchPickerOptions } from '@/components/quota/pickerSources';
import { newLimitHref, parseLimitLink } from '@/components/iam/limits/links';

const row = (over: Record<string, unknown> = {}): LimitRow => {
  const parsed = parseLimitRow({
    _id: 'p1', scope: 'tenant', domain: 'llm', priority: 10, enabled: true, limits: {}, projectId: 'proj-1',
    target: { type: 'tenant' }, ...over,
  });
  if (!parsed) throw new Error('fixture did not parse');
  return parsed;
};

describe('parseLimitRow', () => {
  it('accepts a policy with its resolved target and project name', () => {
    const parsed = parseLimitRow({
      _id: 'p1', scope: 'group', scopeId: 'g1', groupMode: 'shared', domain: 'agent', priority: 5, enabled: true,
      limits: { rateLimit: { requests: { perDay: 200 } } },
      target: { type: 'group', id: 'g1', label: 'Branch staff', sublabel: 'Retail' },
      projectName: 'Retail', projectKey: 'retail', projectId: 'proj-1',
    });
    expect(parsed).toMatchObject({
      _id: 'p1', scope: 'group', groupMode: 'shared', domain: 'agent', projectId: 'proj-1', projectName: 'Retail',
      target: { type: 'group', id: 'g1', label: 'Branch staff', sublabel: 'Retail' },
    });
  });

  it('defaults a group policy to per-member and gives other scopes no mode', () => {
    expect(row({ scope: 'group', scopeId: 'g', groupMode: undefined }).groupMode).toBe('perMember');
    expect(row({ scope: 'group', scopeId: 'g', groupMode: 'weird' }).groupMode).toBe('perMember');
    expect(row({ scope: 'user', scopeId: 'u', groupMode: 'shared' }).groupMode).toBeUndefined();
  });

  it('survives an answer without target info (the plain list)', () => {
    const parsed = parseLimitRow({ _id: 'p1', scope: 'user', scopeId: 'u1', domain: 'llm', limits: {} });
    expect(parsed?.target).toEqual({ type: 'user', id: 'u1' });
    expect(parsed?.enabled).toBe(true);
  });

  it('rejects rows that cannot be shown', () => {
    expect(parseLimitRow(null)).toBeUndefined();
    expect(parseLimitRow({ scope: 'user', domain: 'llm' })).toBeUndefined(); // no id
    expect(parseLimitRow({ _id: 'x', domain: 'llm' })).toBeUndefined(); // no scope
    expect(parseLimitRows({ policies: [{ _id: 'x' }, { _id: 'y', scope: 'tenant', domain: 'llm' }] })).toHaveLength(1);
    expect(parseLimitRows(null)).toEqual([]);
  });
});

describe('inert limits', () => {
  it('flags a project-less limit of an older kind, and only that', () => {
    expect(isInertLimit({ scope: 'user', domain: 'llm', projectId: undefined })).toBe(true);
    expect(isInertLimit({ scope: 'tenant', domain: 'global', projectId: undefined })).toBe(true);
    expect(isInertLimit({ scope: 'user', domain: 'llm', projectId: 'p' })).toBe(false);
    expect(isInertLimit({ scope: 'group', domain: 'llm', projectId: undefined })).toBe(false);
    expect(isInertLimit({ scope: 'tenant', domain: 'agent', projectId: undefined })).toBe(false);
  });

  it('counts them in the stats', () => {
    const rows = [
      row({ _id: 'a', projectId: undefined }),
      row({ _id: 'b', scope: 'group', scopeId: 'g', projectId: undefined }),
      row({ _id: 'c', domain: 'agent' }),
    ];
    expect(limitStats(rows)).toEqual({ total: 3, groupLimits: 1, agentLimits: 1, inert: 1 });
  });
});

describe('filtering and ordering', () => {
  const rows = [
    row({ _id: '1', scope: 'user', scopeId: 'u1', label: 'Alice cap', target: { type: 'user', id: 'u1', label: 'Alice', sublabel: 'alice@acme.test' } }),
    row({ _id: '2', scope: 'group', scopeId: 'g1', domain: 'agent', label: 'Branch runs', target: { type: 'group', id: 'g1', label: 'Branch staff' }, projectName: 'Retail' }),
    row({ _id: '3', scope: 'tenant', domain: 'llm', label: 'Project quota', projectName: 'Retail' }),
  ];

  it('filters by scope, by domain and by a text that matches the policy, its target or its project', () => {
    const ids = (f: Partial<Parameters<typeof filterLimitRows>[1]>) =>
      filterLimitRows(rows, { scope: 'all', domain: 'all', query: '', ...f }).map((r) => r._id);
    expect(ids({})).toEqual(['1', '2', '3']);
    expect(ids({ scope: 'group' })).toEqual(['2']);
    expect(ids({ domain: 'agent' })).toEqual(['2']);
    expect(ids({ query: 'alice@' })).toEqual(['1']);   // the target's e-mail
    expect(ids({ query: 'BRANCH' })).toEqual(['2']);   // case-insensitive, policy name and target name
    expect(ids({ query: 'retail' })).toEqual(['2', '3']); // project
    expect(ids({ query: 'u1' })).toEqual(['1']);       // the target id
    expect(ids({ scope: 'user', domain: 'agent' })).toEqual([]);
  });

  it('orders broad to narrow, then newest first', () => {
    const sorted = sortLimitRows([
      row({ _id: 'user-old', scope: 'user', scopeId: 'u', updatedAt: '2026-01-01T00:00:00Z' }),
      row({ _id: 'user-new', scope: 'user', scopeId: 'u', updatedAt: '2026-06-01T00:00:00Z' }),
      row({ _id: 'group', scope: 'group', scopeId: 'g', updatedAt: '2026-03-01T00:00:00Z' }),
      row({ _id: 'tenant', scope: 'tenant', updatedAt: '2025-01-01T00:00:00Z' }),
    ]);
    expect(sorted.map((r) => r._id)).toEqual(['tenant', 'group', 'user-new', 'user-old']);
  });
});

describe('amounts', () => {
  it('lists every number a limit sets, rate limits first', () => {
    const amounts = limitAmounts({
      quotas: { maxAgents: 5 },
      budget: { dailySpendLimit: 10, alertThresholds: [0.8] },
      perRequest: { maxInputTokens: 4000 },
      rateLimit: { tokens: { perDay: 100000 }, requests: { perMinute: 60, perHour: 1000 } },
    });
    expect(amounts.map((a) => a.path)).toEqual([
      'rateLimit.requests.perMinute',
      'rateLimit.requests.perHour',
      'rateLimit.tokens.perDay',
      'budget.dailySpendLimit',
      'perRequest.maxInputTokens',
      'quotas.maxAgents',
    ]);
    expect(limitAmounts(undefined)).toEqual([]);
    expect(limitAmounts({ rateLimit: { requests: {} } })).toEqual([]);
  });

  it('formats a number as a person reads it', () => {
    const fmt = (path: string, group: 'rate' | 'budget' | 'perRequest' | 'quotas', value: number) =>
      formatAmountValue({ path, group, value }, 'en-US');
    expect(fmt('rateLimit.requests.perDay', 'rate', 200)).toBe('200');
    expect(fmt('rateLimit.tokens.perMonth', 'rate', 1_500_000)).toBe('1,500,000');
    expect(fmt('rateLimit.requests.perDay', 'rate', -1)).toBe('∞');
    expect(fmt('budget.monthlySpendLimit', 'budget', 5000)).toBe('$5,000');
    expect(fmt('perRequest.maxFileSize', 'perRequest', 10 * 1024 * 1024)).toBe('10 MB');
    expect(fmt('perRequest.maxSessionDurationMs', 'perRequest', 90_000)).toBe('90 s');
    expect(fmt('quotas.maxStorageBytes', 'quotas', 2 * 1024 * 1024 * 1024)).toBe('2,048 MB');
  });

  it('makes a readable label out of a camelCase key', () => {
    expect(humanizeKey('maxInputTokens')).toBe('Max input tokens');
    expect(humanizeKey('maxVectorsPerUpsert')).toBe('Max vectors per upsert');
  });
});

describe('duplicateSeed', () => {
  it('copies amounts and target, not identity, and does not share the limits object', () => {
    const original = row({ scope: 'group', scopeId: 'g1', groupMode: 'shared', label: 'Branch runs', limits: { rateLimit: { requests: { perDay: 5 } } } });
    const seed = duplicateSeed(original, (label) => `Copy of ${label}`);
    expect(seed).toMatchObject({ scope: 'group', scopeId: 'g1', groupMode: 'shared', label: 'Copy of Branch runs', projectId: 'proj-1' });
    expect(seed).not.toHaveProperty('_id');
    (seed.limits as { rateLimit: { requests: { perDay: number } } }).rateLimit.requests.perDay = 99;
    expect(original.limits.rateLimit?.requests?.perDay).toBe(5);
  });
});

describe('picker sources', () => {
  const answer = (body: unknown, ok = true) => async () => ({ ok, status: ok ? 200 : 404, json: async () => body });

  it('asks the server to search, with a bounded page', async () => {
    const urls: string[] = [];
    const options = await searchPickerOptions('user', ' ali ', async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ items: [{ type: 'user', id: 'u1', label: 'Alice', sublabel: 'alice@acme.test' }] }) };
    });
    expect(urls).toEqual([`/api/iam/principals?type=user&limit=${PICKER_LIMIT}&q=ali`]);
    expect(options).toEqual([{ value: 'u1', label: 'Alice', description: 'alice@acme.test' }]);
  });

  it('falls back to the plain list, filtered here, when the principal search is not available', async () => {
    const users = { users: [
      { _id: 'u1', name: 'Alice', email: 'alice@acme.test' },
      { _id: 'u2', name: 'Bob', email: 'bob@acme.test' },
    ] };
    const fetcher = async (url: string) =>
      url.startsWith('/api/iam/principals') ? { ok: false, status: 403, json: async () => ({}) } : { ok: true, status: 200, json: async () => users };
    expect((await searchPickerOptions('user', 'bob', fetcher)).map((o) => o.value)).toEqual(['u2']);
    expect((await searchPickerOptions('user', '', fetcher)).map((o) => o.value)).toEqual(['u1', 'u2']);

    const groups = async (url: string) =>
      url.startsWith('/api/iam/principals')
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ groups: [{ _id: 'g1', name: 'Branch staff', description: null }] }) };
    expect(await searchPickerOptions('group', 'branch', groups)).toEqual([{ value: 'g1', label: 'Branch staff', description: undefined }]);
  });

  it('finds agents in the resource registry and carries their project', async () => {
    const options = await searchPickerOptions('agent', 'credit', answer({
      items: [{ type: 'agent', id: 'a1', key: 'credit-bot', name: 'Credit assistant', projectId: 'proj-1' }, { id: 'no-key' }],
      projects: [{ id: 'proj-1', name: 'Retail' }],
    }));
    expect(options).toEqual([
      { value: 'credit-bot', label: 'Credit assistant', description: 'credit-bot · Retail', projectId: 'proj-1' },
    ]);
  });

  it('returns nothing, not an error, when every source fails', async () => {
    const down = async () => { throw new Error('offline'); };
    expect(await searchPickerOptions('token', '', down)).toEqual([]);
    expect(await searchPickerOptions('agent', '', down)).toEqual([]);
  });
});

describe('deep links into the Limits tab', () => {
  const parse = (href: string) => parseLimitLink(new URL(href, 'https://console.test').searchParams);

  it('round-trips a link for a new group limit', () => {
    const href = newLimitHref({ principalType: 'group', principalId: 'g1', domain: 'agent', groupMode: 'shared', projectId: 'p1' });
    expect(href).toBe('/dashboard/iam?tab=limits&new=1&principalType=group&principalId=g1&domain=agent&groupMode=shared&projectId=p1');
    expect(parse(href)).toEqual({
      isNew: true,
      seed: { scope: 'group', scopeId: 'g1', domain: 'agent', groupMode: 'shared', projectId: 'p1' },
    });
  });

  it('links to a person or an API token the same way', () => {
    expect(parse(newLimitHref({ principalType: 'user', principalId: 'u1' })).seed).toEqual({ scope: 'user', scopeId: 'u1' });
    expect(parse(newLimitHref({ principalType: 'token', principalId: 't1' })).seed).toEqual({ scope: 'token', scopeId: 't1' });
  });

  it('opens an empty editor for a bare new=1, and nothing for a link without it', () => {
    expect(parse(newLimitHref())).toEqual({ isNew: true, seed: {} });
    expect(parse('/dashboard/iam?tab=limits').isNew).toBe(false);
  });

  it('accepts the quota API\'s own words and ignores anything it does not know', () => {
    expect(parse('/dashboard/iam?tab=limits&new=1&scope=resource&scopeId=credit-bot&domain=agent').seed)
      .toEqual({ scope: 'resource', scopeId: 'credit-bot', domain: 'agent' });
    expect(parse('/dashboard/iam?tab=limits&new=1&scope=planet&domain=telepathy&groupMode=weekly&principalType=group').seed)
      .toEqual({ scope: 'group' }); // no id given: only the kind of target is taken
    // A mode only means something for a group; a tenant-wide limit has no target id.
    expect(parse('/dashboard/iam?tab=limits&new=1&scope=user&scopeId=u&groupMode=shared').seed).toEqual({ scope: 'user', scopeId: 'u' });
    expect(parse('/dashboard/iam?tab=limits&new=1&scope=tenant&scopeId=x').seed).toEqual({ scope: 'tenant' });
  });
});
