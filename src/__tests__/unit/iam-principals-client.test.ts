import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IamApiError,
  clampLimit,
  countByLevel,
  filterEffective,
  iamLinks,
  initialPager,
  iamRequest,
  isSimulatable,
  newPager,
  pagerCursor,
  pagerNext,
  pagerPage,
  pagerPrev,
  ownedTokenSummary,
  parseAttachedPolicy,
  parseOwnedToken,
  parseEffective,
  parsePrincipalDetail,
  parsePrincipalPage,
  parsePrincipalSummary,
  policyReach,
  principalDetailUrl,
  principalsListUrl,
  sortEffective,
  type AttachedPolicy,
  type EffectiveLevelFilter,
  type EffectiveRow,
} from '@/components/iam/principals/client';
import {
  formatRelativeTime,
  initialsOf,
  localeTag,
  shortId,
  translateOr,
} from '@/components/iam/principals/format';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('principals list', () => {
  it('builds the list URL with trimmed search, clamped limit and cursor', () => {
    expect(principalsListUrl({ type: 'user' })).toBe('/api/iam/principals?type=user&limit=25');
    expect(principalsListUrl({ type: 'group', q: '  ada  ', limit: 500, cursor: 'c 1' })).toBe(
      '/api/iam/principals?type=group&q=ada&limit=100&cursor=c+1',
    );
    expect(principalsListUrl({ type: 'token', q: '   ', limit: 0 })).toBe('/api/iam/principals?type=token&limit=1');
  });

  it('clamps the page size', () => {
    expect(clampLimit(undefined)).toBe(25);
    expect(clampLimit(Number.NaN)).toBe(25);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(-3)).toBe(1);
    expect(clampLimit(1000)).toBe(100);
  });

  it('parses a page of the contract shape', () => {
    const page = parsePrincipalPage(
      {
        items: [
          {
            type: 'user',
            id: 'u1',
            label: 'Ada Lovelace',
            sublabel: 'ada@example.com',
            role: 'admin',
            status: 'active',
            policyCount: 2,
          },
          { type: 'group', id: 'g1', label: 'Engineering', sublabel: '', memberCount: 12, policyCount: 0 },
        ],
        nextCursor: 'abc',
      },
      'user',
    );
    expect(page.nextCursor).toBe('abc');
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toEqual({
      type: 'user',
      id: 'u1',
      label: 'Ada Lovelace',
      sublabel: 'ada@example.com',
      role: 'admin',
      status: 'active',
      memberCount: null,
      policyCount: 2,
    });
    expect(page.items[1]).toMatchObject({ type: 'group', sublabel: null, memberCount: 12, role: null });
  });

  it('is tolerant: drops rows without an id, de-duplicates, defaults missing fields', () => {
    const page = parsePrincipalPage(
      {
        items: [
          null,
          'nope',
          { label: 'no id' },
          { id: 7, name: 'Numeric id' },
          { id: 7, label: 'duplicate' },
          { id: 'x', type: 'bogus', label: 'X' },
        ],
        nextCursor: '',
      },
      'token',
    );
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => [i.type, i.id, i.label])).toEqual([
      ['token', '7', 'Numeric id'],
      ['token', 'x', 'X'],
    ]);
    expect(page.items[0]?.policyCount).toBe(0);
  });

  it('survives a non-object payload', () => {
    expect(parsePrincipalPage(null, 'user')).toEqual({ items: [], nextCursor: null });
    expect(parsePrincipalPage({ items: 'x' }, 'user')).toEqual({ items: [], nextCursor: null });
  });

  it('parsePrincipalSummary needs a type and an id', () => {
    expect(parsePrincipalSummary({ id: 'a' })).toBeNull();
    expect(parsePrincipalSummary({ id: 'a' }, 'group')?.type).toBe('group');
    expect(parsePrincipalSummary({ type: 'user' }, 'user')).toBeNull();
  });
});

describe('principal detail', () => {
  const payload = {
    principal: { type: 'user', id: 'u1', label: 'Ada', sublabel: 'ada@example.com', role: 'user', status: 'active', policyCount: 1 },
    effective: [
      {
        service: 'models',
        level: 'write',
        sources: [
          { kind: 'role', label: 'user', level: 'read' },
          { kind: 'group', label: 'Engineering', level: 'write' },
        ],
      },
      { service: 'members', level: 'none', sources: [] },
      { service: 'models', level: 'admin', sources: [] },
      { level: 'read' },
      { service: 'weird', level: 'superuser', sources: [{ label: 'no kind' }, { kind: 'newkind', label: 'x', level: 'huge' }] },
    ],
    groups: [{ id: 'g1', name: 'Engineering' }, { groupId: 'g2', label: 'Data' }, { id: 'g1', name: 'dup' }, {}],
    projects: [{ id: 'p1', name: 'Prod', role: 'project_admin', via: 'group', groupName: 'Engineering' }, { projectId: 'p2' }],
    policies: [
      {
        policyId: 'pol1',
        name: 'Deny exports',
        description: 'No exports',
        effect: 'forbid',
        enabled: true,
        spec: { principals: { groups: ['g1'] } },
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
      { name: 'no id' },
    ],
    tokens: [{ id: 't1', label: 'ci', prefix: 'cp_abc', scoped: true, status: 'active', expiresAt: '2026-12-01T00:00:00.000Z', lastUsedAt: null }, { label: 'no id' }],
  };

  it('builds the detail URL with encoded segments and an optional project', () => {
    expect(principalDetailUrl('user', 'u1')).toBe('/api/iam/principals/user/u1');
    expect(principalDetailUrl('group', 'a/b c', 'p 1')).toBe('/api/iam/principals/group/a%2Fb%20c?projectId=p%201');
    expect(principalDetailUrl('token', 't1', null)).toBe('/api/iam/principals/token/t1');
  });

  it('parses the contract payload', () => {
    const detail = parsePrincipalDetail(payload, 'user', 'u1');
    expect(detail.principal).toMatchObject({ type: 'user', id: 'u1', label: 'Ada', policyCount: 1 });
    expect(detail.groups).toEqual([
      { id: 'g1', name: 'Engineering' },
      { id: 'g2', name: 'Data' },
    ]);
    expect(detail.projects).toEqual([
      { id: 'p1', name: 'Prod', role: 'project_admin', via: 'group', groupName: 'Engineering' },
      { id: 'p2', name: 'p2', role: null, via: null, groupName: null },
    ]);
    expect(detail.policies).toHaveLength(1);
    expect(detail.policies[0]).toMatchObject({
      policyId: 'pol1',
      effect: 'forbid',
      enabled: true,
      principals: { groups: ['g1'], users: [], any: false },
    });
    // A policy is enabled or disabled: nothing else about how it is applied is carried.
    expect(detail.policies[0]).not.toHaveProperty('mode');
    expect(detail.policies[0]).not.toHaveProperty('monitorStats');
    expect(detail.tokens).toEqual([
      {
        id: 't1',
        label: 'ci',
        prefix: 'cp_abc',
        scoped: true,
        status: 'active',
        expiresAt: '2026-12-01T00:00:00.000Z',
        lastUsedAt: null,
        projectId: null,
        createdAt: null,
      },
    ]);
  });

  it('parses effective rows: unknown levels become none, rows without a service are dropped, the first service wins', () => {
    const rows = parseEffective(payload.effective);
    expect(rows.map((r) => [r.service, r.level])).toEqual([
      ['models', 'write'],
      ['members', 'none'],
      ['weird', 'none'],
    ]);
    expect(rows[0]?.sources).toEqual([
      { kind: 'role', label: 'user', level: 'read' },
      { kind: 'group', label: 'Engineering', level: 'write' },
    ]);
    // a source without a kind is dropped, an unknown kind and level are kept as unknown
    expect(rows[2]?.sources).toEqual([{ kind: 'newkind', label: 'x', level: null }]);
  });

  it('falls back to the requested principal when the payload has none, and counts attached policies', () => {
    const detail = parsePrincipalDetail({ policies: [{ policyId: 'p' }] }, 'group', 'g9');
    expect(detail.principal).toMatchObject({ type: 'group', id: 'g9', label: 'g9', policyCount: 1 });
    expect(detail.tokens).toBeNull();
    expect(detail.effective).toEqual([]);
  });

  it('survives garbage', () => {
    const detail = parsePrincipalDetail('nope', 'token', 't');
    expect(detail.principal.id).toBe('t');
    expect(detail.groups).toEqual([]);
    expect(detail.projects).toEqual([]);
    expect(detail.policies).toEqual([]);
  });

  it('keeps unknown policy effects as null and defaults enabled to true', () => {
    const p = parseAttachedPolicy({ policyId: 'x', effect: 'maybe', mode: 'dry', spec: null });
    expect(p).toMatchObject({ effect: null, enabled: true, principals: null });
    expect(parseAttachedPolicy({ policyId: 'x', enabled: false })?.enabled).toBe(false);
  });
});

describe('principal extras (what the server adds to the principal)', () => {
  it('reads a token: its owner, expiry, last use and whether it is scoped; the role is the owner\'s, not the token\'s', () => {
    const detail = parsePrincipalDetail(
      {
        principal: {
          type: 'token',
          id: 't1',
          label: 'CI pipeline',
          sublabel: 'cp_8f2a…',
          role: 'admin',
          status: 'active',
          ownerId: 'u1',
          ownerLabel: 'Ada Lovelace',
          projectId: 'p1',
          scope: { models: 'read' },
          expiresAt: '2026-12-01T00:00:00.000Z',
          lastUsedAt: '2026-10-09T08:00:00.000Z',
        },
        tokens: null,
      },
      'token',
      't1',
    );
    expect(detail.principal.role).toBeNull();
    expect(detail.principal.status).toBe('active');
    expect(detail.extras).toMatchObject({
      ownerId: 'u1',
      ownerLabel: 'Ada Lovelace',
      scoped: true,
      expiresAt: '2026-12-01T00:00:00.000Z',
      lastUsedAt: '2026-10-09T08:00:00.000Z',
    });
    expect(detail.tokens).toBeNull();
  });

  it('tells an unscoped token (scope null) from a server that does not say', () => {
    const scoped = (principal: Record<string, unknown>) =>
      parsePrincipalDetail({ principal: { type: 'token', id: 't', ...principal } }, 'token', 't').extras.scoped;
    expect(scoped({ scope: null })).toBe(false);
    expect(scoped({ scope: {} })).toBe(true);
    expect(scoped({})).toBeNull();
  });

  it('reads the account facts of a user and the directory facts of a group', () => {
    const user = parsePrincipalDetail(
      { principal: { type: 'user', id: 'u', label: 'Ada', role: 'user', authProvider: 'ldap', canLogin: false } },
      'user',
      'u',
    );
    expect(user.principal.role).toBe('user');
    expect(user.extras).toMatchObject({ authProvider: 'ldap', canLogin: false });

    const group = parsePrincipalDetail(
      { principal: { type: 'group', id: 'g', label: 'Eng', memberCount: 4, source: 'ldap', tenantRole: 'admin' } },
      'group',
      'g',
    );
    expect(group.principal.memberCount).toBe(4);
    expect(group.extras).toMatchObject({ source: 'ldap', tenantRole: 'admin' });

    // nothing to read: every extra is simply absent
    expect(Object.values(parsePrincipalDetail({}, 'user', 'u').extras).every((v) => v === null)).toBe(true);
  });

  it('parses an owned token and turns it into a list row', () => {
    expect(parseOwnedToken({ id: 't', label: 'ci', prefix: 'cp_1', scoped: false, status: 'expired', lastUsed: '2026-01-01T00:00:00.000Z' })).toEqual({
      id: 't',
      label: 'ci',
      prefix: 'cp_1',
      scoped: false,
      status: 'expired',
      expiresAt: null,
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      projectId: null,
      createdAt: null,
    });
    expect(parseOwnedToken({ label: 'no id' })).toBeNull();
    const token = parseOwnedToken({ id: 't', label: 'ci', prefix: 'cp_1', status: 'active' })!;
    expect(ownedTokenSummary(token)).toEqual({
      type: 'token',
      id: 't',
      label: 'ci',
      sublabel: 'cp_1…',
      role: null,
      status: 'active',
      memberCount: null,
      policyCount: 0,
    });
    expect(ownedTokenSummary({ ...token, prefix: null }).sublabel).toBeNull();
  });
});

describe('effective permissions helpers', () => {
  const rows: EffectiveRow[] = [
    { service: 'tokens', level: 'read', sources: [] },
    { service: 'models', level: 'admin', sources: [] },
    { service: 'agents', level: 'none', sources: [] },
    { service: 'prompts', level: 'read', sources: [] },
  ];
  const labelOf = (s: string) => ({ tokens: 'API Tokens', models: 'Model Hub', agents: 'Agents', prompts: 'Prompt Studio' })[s] ?? s;

  it('sorts by level (highest first) then by label', () => {
    expect(sortEffective(rows, labelOf).map((r) => r.service)).toEqual(['models', 'tokens', 'prompts', 'agents']);
    // the input is not mutated
    expect(rows[0]?.service).toBe('tokens');
  });

  it('shows what the principal can use by default, one level on request, and matches the id or the label', () => {
    const ids = (level: EffectiveLevelFilter, query = '') =>
      filterEffective(rows, { query, level, labelOf }).map((r) => r.service);
    expect(ids('access')).toEqual(['tokens', 'models', 'prompts']);
    expect(ids('all')).toHaveLength(4);
    expect(ids('admin')).toEqual(['models']);
    expect(ids('read')).toEqual(['tokens', 'prompts']);
    expect(ids('none')).toEqual(['agents']);
    expect(ids('write')).toEqual([]);
    expect(ids('access', 'hub')).toEqual(['models']);
    expect(ids('access', ' PROMPTS ')).toEqual(['prompts']);
    expect(ids('access', 'agents')).toEqual([]);
    expect(ids('all', 'agents')).toEqual(['agents']);
  });

  it('counts the services at each level', () => {
    expect(countByLevel(rows)).toEqual({ none: 1, read: 2, write: 0, admin: 1 });
    expect(countByLevel([])).toEqual({ none: 0, read: 0, write: 0, admin: 0 });
  });
});

describe('policyReach', () => {
  const base: AttachedPolicy = {
    policyId: 'p',
    name: 'p',
    description: '',
    effect: 'permit',
    enabled: true,
    principals: { any: false, anyUser: false, anyToken: false, users: [], groups: [], tokens: [] },
    updatedAt: null,
  };
  const withSpec = (spec: Partial<NonNullable<AttachedPolicy['principals']>>): AttachedPolicy => ({
    ...base,
    principals: { ...base.principals!, ...spec },
  });

  it('a raw Cedar policy has no spec to read', () => {
    expect(policyReach({ ...base, principals: null }, { type: 'user', id: 'u' }, [])).toEqual([{ kind: 'raw' }]);
  });

  it('"any" reaches everyone', () => {
    expect(policyReach(withSpec({ any: true }), { type: 'token', id: 't' }, [])).toEqual([{ kind: 'everyone' }]);
  });

  it('a user is reached directly, by "any user" and through groups, all at once', () => {
    const reach = policyReach(
      withSpec({ users: ['u1'], anyUser: true, groups: ['g1', 'g9'] }),
      { type: 'user', id: 'u1' },
      ['g1', 'g2'],
    );
    expect(reach).toEqual([{ kind: 'direct' }, { kind: 'anyUser' }, { kind: 'group', groupIds: ['g1'] }]);
  });

  it('a user policy for somebody else does not reach this user', () => {
    expect(policyReach(withSpec({ users: ['other'] }), { type: 'user', id: 'u1' }, [])).toEqual([]);
  });

  it('a token is reached by name, by "any token", through the owner groups, or via its owner', () => {
    expect(policyReach(withSpec({ tokens: ['t1'] }), { type: 'token', id: 't1' }, [])).toEqual([{ kind: 'direct' }]);
    expect(policyReach(withSpec({ anyToken: true }), { type: 'token', id: 't1' }, [])).toEqual([{ kind: 'anyToken' }]);
    expect(policyReach(withSpec({ groups: ['g1'] }), { type: 'token', id: 't1' }, ['g1'])).toEqual([
      { kind: 'group', groupIds: ['g1'] },
    ]);
    // a user policy matches the tokens that user owns (the owner is known: only a policy naming him reaches the token)
    expect(policyReach(withSpec({ users: ['owner'] }), { type: 'token', id: 't1' }, [], 'owner')).toEqual([{ kind: 'viaOwner' }]);
    expect(policyReach(withSpec({ users: ['somebody'] }), { type: 'token', id: 't1' }, [], 'owner')).toEqual([]);
    // without the owner the best guess is "some user it names"
    expect(policyReach(withSpec({ users: ['owner'] }), { type: 'token', id: 't1' }, [])).toEqual([{ kind: 'viaOwner' }]);
    expect(policyReach(withSpec({ tokens: ['other'] }), { type: 'token', id: 't1' }, [])).toEqual([]);
  });

  it('a group is reached when the policy names it', () => {
    expect(policyReach(withSpec({ groups: ['g1'] }), { type: 'group', id: 'g1' }, [])).toEqual([{ kind: 'direct' }]);
    expect(policyReach(withSpec({ groups: ['g2'] }), { type: 'group', id: 'g1' }, [])).toEqual([]);
    expect(policyReach(withSpec({ anyUser: true }), { type: 'group', id: 'g1' }, [])).toEqual([]);
  });
});

describe('iamRequest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps an error body to IamApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'Forbidden', code: 'forbidden', details: [{ message: 'x' }] }, { status: 403 })),
    );
    const err = await iamRequest('/api/iam/principals').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IamApiError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', message: 'Forbidden', details: [{ message: 'x' }] });
  });

  it('falls back to the status line for a non-JSON error and resolves null for a 204', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 502 })));
    await expect(iamRequest('/x')).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(iamRequest('/x')).resolves.toBeNull();
  });

  it('never caches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(iamRequest('/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/x', expect.objectContaining({ cache: 'no-store' }));
  });
});

describe('deep links', () => {
  it('matches the deep links of the other tabs', () => {
    expect(iamLinks.simulate('user', 'u1')).toBe('/dashboard/iam?tab=check&principalType=user&principalId=u1');
    expect(iamLinks.simulate('token', 't1', 'models.write')).toBe(
      '/dashboard/iam?tab=check&principalType=token&principalId=t1&action=models.write',
    );
    expect(iamLinks.decision('d-1')).toBe('/dashboard/iam?tab=check&decisionId=d-1');
    expect(iamLinks.createPolicy('group', 'g1')).toBe('/dashboard/iam?tab=policies&new=1&principalType=group&principalId=g1');
    expect(iamLinks.policy('pol 1')).toBe('/dashboard/iam?tab=policies&policyId=pol+1');
    expect(iamLinks.audit('user', 'u1')).toBe('/dashboard/iam?tab=audit&principalType=user&principalId=u1');
    expect(iamLinks.principal('group', 'g1')).toBe('/dashboard/iam/principals/group/g1');
    // People are managed in the center itself: there is no member page to link to any more.
    expect('member' in iamLinks).toBe(false);
    expect(iamLinks.tokensOf('u 1')).toBe('/dashboard/iam?tab=principals&principalType=token&ownerId=u+1');
    expect(iamLinks.editPerson('u1', 'role')).toBe('/dashboard/iam?tab=principals&principalType=user&principalId=u1&edit=role');
  });

  it('only users and tokens can be simulated', () => {
    expect(isSimulatable('user')).toBe(true);
    expect(isSimulatable('token')).toBe(true);
    expect(isSimulatable('group')).toBe(false);
    expect(isSimulatable('x')).toBe(false);
  });
});

describe('cursor pager', () => {
  it('starts on page 1 and walks forward and back', () => {
    let s = initialPager;
    expect(pagerPage(s, 'k')).toBe(1);
    expect(pagerCursor(s, 'k')).toBeNull();
    s = pagerNext(s, 'k', 'c2');
    s = pagerNext(s, 'k', 'c3');
    expect(pagerPage(s, 'k')).toBe(3);
    expect(pagerCursor(s, 'k')).toBe('c3');
    s = pagerPrev(s, 'k');
    expect(pagerPage(s, 'k')).toBe(2);
    expect(pagerCursor(s, 'k')).toBe('c2');
    s = pagerPrev(pagerPrev(pagerPrev(s, 'k'), 'k'), 'k');
    expect(pagerPage(s, 'k')).toBe(1);
    expect(pagerCursor(s, 'k')).toBeNull();
  });

  it('starts a fresh pager for a key', () => {
    const s = newPager('k');
    expect(pagerPage(s, 'k')).toBe(1);
    expect(pagerCursor(s, 'k')).toBeNull();
    expect(pagerPage(pagerNext(s, 'k', 'c2'), 'k')).toBe(2);
  });

  it('a new filter key starts over without a stale cursor', () => {
    const s = pagerNext(pagerNext(initialPager, 'a', 'c2'), 'a', 'c3');
    expect(pagerPage(s, 'b')).toBe(1);
    expect(pagerCursor(s, 'b')).toBeNull();
    // moving forward under the new key does not inherit the old cursors
    expect(pagerPage(pagerNext(s, 'b', 'x'), 'b')).toBe(2);
    expect(pagerPage(pagerPrev(s, 'b'), 'b')).toBe(1);
  });
});

describe('format helpers', () => {
  it('maps the app locale to a BCP 47 tag', () => {
    expect(localeTag('tr')).toBe('tr-TR');
    expect(localeTag('en')).toBe('en-US');
    expect(localeTag('de')).toBe('de');
  });

  it('formats relative times against a fixed clock', () => {
    const now = Date.parse('2026-10-09T12:00:00.000Z');
    expect(formatRelativeTime('2026-10-09T09:00:00.000Z', { now, locale: 'en' })).toBe('3 hours ago');
    expect(formatRelativeTime('2026-10-11T12:00:00.000Z', { now, locale: 'en' })).toBe('in 2 days');
    expect(formatRelativeTime('2026-10-09T11:59:40.000Z', { now, locale: 'en' })).toBe('now');
    expect(formatRelativeTime('not a date', { now })).toBe('—');
    expect(formatRelativeTime(null)).toBe('—');
  });

  it('shortens ids and builds labels', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567');
    expect(shortId('abc')).toBe('abc');
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ci-bot')).toBe('CB');
    expect(initialsOf('ada@example.com')).toBe('AE');
    expect(initialsOf('x')).toBe('X');
    expect(initialsOf('  ')).toBe('?');
  });

  it('translateOr falls back when a message is missing', () => {
    const t = (key: string) => (key === 'roles.admin' ? 'Admin' : `ns.${key}`);
    expect(translateOr(t, 'ns', 'roles.admin', 'x')).toBe('Admin');
    expect(translateOr(t, 'ns', 'roles.custom', 'custom')).toBe('custom');
    expect(translateOr((k) => k, 'ns', 'roles.custom', 'custom')).toBe('custom');
  });
});
