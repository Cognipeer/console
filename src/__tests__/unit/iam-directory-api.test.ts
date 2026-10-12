/**
 * The client of the people-and-access API: URLs and bodies it sends, how it reads
 * what comes back (tolerantly), and how a failure carries its decision id.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chunkIds,
  DirectoryApiError,
  directoryApi,
  mergeBulkResults,
  MAX_BULK_IDS,
  parseAccessPreview,
  parseBulkResult,
  parseCapabilities,
  parseGroupMembersPage,
  parseImportSummary,
  parseInviteResult,
  parseProjectMember,
  parseTokenRevokeResult,
  parseUserRecord,
} from '@/components/iam/principals/directoryApi';
import {
  parseAllowedActions,
  parseManaged,
  parsePrincipalDetail,
  parsePrincipalPage,
  parsePrincipalSummary,
  principalDetailUrl,
  principalsListUrl,
} from '@/components/iam/principals/client';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('the list request', () => {
  it('carries the filters, the exact-total request and the ids to hydrate', () => {
    expect(
      principalsListUrl({
        type: 'user',
        q: ' ann ',
        limit: 50,
        cursor: 'c1',
        filters: { role: 'admin,user', status: 'invited', sort: 'email', dir: 'desc', empty: '' },
        count: true,
        ids: ['a', 'b'],
      }),
    ).toBe('/api/iam/principals?type=user&q=ann&limit=50&cursor=c1&role=admin%2Cuser&status=invited&sort=email&dir=desc&count=1&ids=a%2Cb');
  });

  it('a filter can never override the type, the search, the limit or the cursor', () => {
    const url = principalsListUrl({ type: 'group', q: 'x', limit: 10, filters: { type: 'user', q: 'y', limit: '999', cursor: 'z', source: 'local' } });
    expect(url).toBe('/api/iam/principals?type=group&q=x&limit=10&source=local');
  });

  it('hydrates at most 100 ids', () => {
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const url = new URL(principalsListUrl({ type: 'user', ids }), 'http://x');
    expect(url.searchParams.get('ids')?.split(',')).toHaveLength(100);
  });

  it('keeps the old URL for a plain query', () => {
    expect(principalsListUrl({ type: 'user' })).toBe('/api/iam/principals?type=user&limit=25');
  });

  it('asks for the detail without the effective table on request', () => {
    expect(principalDetailUrl('user', 'u1', null, { effective: false })).toBe('/api/iam/principals/user/u1?effective=0');
    expect(principalDetailUrl('user', 'u1', 'p 1', { effective: false })).toBe('/api/iam/principals/user/u1?projectId=p%201&effective=0');
    expect(principalDetailUrl('user', 'u1', null, { effective: true })).toBe('/api/iam/principals/user/u1');
  });
});

describe('what the list answers', () => {
  it('reads the directory facts of a user, a group and a token, and leaves them undefined when missing', () => {
    const user = parsePrincipalSummary(
      { type: 'user', id: 'u1', label: 'Ann', email: 'ann@example.com', kind: 'service', authProvider: 'ldap', managed: true, createdAt: '2026-01-01T00:00:00.000Z', invitedAt: 'x' },
      'user',
    )!;
    expect(user).toMatchObject({ email: 'ann@example.com', kind: 'service', authProvider: 'ldap', managed: true });
    const bare = parsePrincipalSummary({ type: 'user', id: 'u2', label: 'Bob' }, 'user')!;
    expect(bare.email).toBeUndefined();
    expect(bare.kind).toBeUndefined();
    expect(bare.managed).toBeUndefined();

    const group = parsePrincipalSummary({ type: 'group', id: 'g', label: 'Eng', source: 'ldap', tenantRole: 'admin', memberCount: 3 }, 'group')!;
    expect(group).toMatchObject({ source: 'ldap', tenantRole: 'admin', memberCount: 3 });

    const token = parsePrincipalSummary(
      { type: 'token', id: 't', label: 'ci', prefix: 'cp_1', ownerId: 'u1', ownerLabel: 'Ann', ownerKind: 'service', ownerDisabled: true, ownerMissing: false, projectId: 'p', projectName: 'Prod', scoped: true, expiresAt: 'e', lastUsedAt: 'l', createdAt: 'c' },
      'token',
    )!;
    expect(token).toMatchObject({ prefix: 'cp_1', ownerKind: 'service', ownerDisabled: true, ownerMissing: false, projectName: 'Prod', scoped: true });
  });

  it('carries the exact total only when the server sent one', () => {
    expect(parsePrincipalPage({ items: [], nextCursor: null, total: 12430 }, 'user').total).toBe(12430);
    expect('total' in parsePrincipalPage({ items: [] }, 'user')).toBe(false);
    expect('total' in parsePrincipalPage({ items: [], total: 'many' }, 'user')).toBe(false);
  });
});

describe('what the detail adds', () => {
  const payload = {
    principal: {
      type: 'user',
      id: 'u1',
      label: 'Ann',
      role: 'user',
      status: 'active',
      email: 'ann@example.com',
      authProvider: 'oidc',
      canLogin: true,
      pendingInvite: false,
      disabledReason: null,
      servicePermissions: { models: 'read', nonsense: 'admin', agents: 'galaxy' },
      managed: { directory: true, provider: 'oidc', readOnly: ['name', 'email', 'password'] },
    },
    groups: [{ id: 'g1', name: 'Eng', source: 'ldap', tenantRole: 'admin', removable: false }],
    projects: [{ id: 'p1', name: 'Prod', role: 'member', via: 'direct', removable: true }],
    tokens: [{ id: 't1', label: 'ci', prefix: 'cp_1', projectId: 'p1', scoped: false, status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }],
    tokensHidden: false,
    tokensTruncated: true,
    tokensTotal: 140,
    allowedActions: {
      editProfile: { allowed: false, reason: 'directory_managed' },
      changeRole: { allowed: true },
      delete: false,
      weird: 'yes',
    },
    assignableRoles: ['admin', 'user', 3],
  };

  it('reads the viewer-specific parts next to the principal', () => {
    const detail = parsePrincipalDetail(payload, 'user', 'u1');
    expect(detail.extras).toMatchObject({
      email: 'ann@example.com',
      authProvider: 'oidc',
      pendingInvite: false,
      servicePermissions: { models: 'read' },
      managed: { directory: true, provider: 'oidc', readOnly: ['name', 'email', 'password'] },
    });
    expect(detail.groups[0]).toMatchObject({ source: 'ldap', tenantRole: 'admin', removable: false });
    expect(detail.projects[0]).toMatchObject({ via: 'direct', removable: true });
    expect(detail.tokens?.[0]).toMatchObject({ id: 't1', projectId: 'p1' });
    expect(detail.tokensTruncated).toBe(true);
    expect(detail.tokensTotal).toBe(140);
    expect(detail.allowedActions).toEqual({
      editProfile: { allowed: false, reason: 'directory_managed' },
      changeRole: { allowed: true },
      delete: { allowed: false },
    });
    expect(detail.assignableRoles).toEqual(['admin', 'user']);
  });

  it('falls back to the principal when an older shape nests the viewer parts inside it', () => {
    const detail = parsePrincipalDetail(
      { principal: { type: 'user', id: 'u', label: 'U', allowedActions: { delete: { allowed: true } }, assignableRoles: ['user'] } },
      'user',
      'u',
    );
    expect(detail.allowedActions).toEqual({ delete: { allowed: true } });
    expect(detail.assignableRoles).toEqual(['user']);
  });

  it('keeps "the server did not say" apart from "nothing allowed"', () => {
    const none = parsePrincipalDetail({ principal: { type: 'user', id: 'u', label: 'U' } }, 'user', 'u');
    expect(none.allowedActions).toBeNull();
    expect(none.assignableRoles).toBeNull();
    expect(none.tokensHidden).toBe(false);
    expect(parseAllowedActions({})).toEqual({});
    expect(parseManaged('x')).toBeNull();
  });

  it('reports a skipped effective table and a token row', () => {
    const detail = parsePrincipalDetail(
      { principal: { type: 'token', id: 't', label: 'ci', projectId: 'p1' }, effective: [], effectiveSkipped: true, tokenRow: { _id: 't', label: 'ci', createdAt: 'c', canEdit: true, allowedIpRanges: ['10.0.0.0/8'] } },
      'token',
      't',
    );
    expect(detail.effectiveSkipped).toBe(true);
    expect(detail.tokenRow).toMatchObject({ _id: 't', canEdit: true, allowedIpRanges: ['10.0.0.0/8'] });
    expect(detail.extras.projectId).toBe('p1');
    // only a token has a token row
    expect(parsePrincipalDetail({ tokenRow: { _id: 'x' } }, 'user', 'u').tokenRow).toBeNull();
  });
});

describe('parsers of the other answers', () => {
  it('capabilities default to nothing allowed', () => {
    expect(parseCapabilities({})).toEqual({
      me: null,
      policiesManage: false,
      peopleManage: false,
      grantAdmin: false,
      assignableRoles: [],
      tokensManageOthers: false,
    });
    expect(
      parseCapabilities({
        me: { userId: 'u1', role: 'admin' },
        policies: { manage: true },
        people: { manage: true, grantAdmin: true, assignableRoles: ['admin', 'user'] },
        tokens: { manageOthers: true },
      }),
    ).toMatchObject({ me: { userId: 'u1', role: 'admin' }, peopleManage: true, assignableRoles: ['admin', 'user'], tokensManageOthers: true });
  });

  it('a bulk result counts what the server did not count itself', () => {
    const result = parseBulkResult({
      action: 'disable',
      dryRun: true,
      results: [
        { id: 'a', outcome: 'ok' },
        { id: 'b', outcome: 'skipped', code: 'already_in_state' },
        { id: 'c', outcome: 'weird' },
        { nope: true },
      ],
      batchId: 'b1',
    });
    expect(result).toMatchObject({ requested: 3, ok: 1, skipped: 1, failed: 1, dryRun: true, batchId: 'b1' });
    expect(result.results[2]?.outcome).toBe('failed');
  });

  it('merges the answers of chunked requests', () => {
    const a = parseBulkResult({ action: 'enable', dryRun: false, requested: 2, ok: 2, skipped: 0, failed: 0, results: [{ id: 'a', outcome: 'ok' }, { id: 'b', outcome: 'ok' }] });
    const b = parseBulkResult({ action: 'enable', dryRun: false, requested: 1, ok: 0, skipped: 1, failed: 0, results: [{ id: 'c', outcome: 'skipped', code: 'self_not_allowed' }] });
    expect(mergeBulkResults([a, b])).toMatchObject({ requested: 3, ok: 2, skipped: 1, failed: 0 });
    expect(mergeBulkResults([a, b]).results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('splits ids into requests the server accepts', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    expect(chunkIds(ids).map((c) => c.length)).toEqual([MAX_BULK_IDS, MAX_BULK_IDS, 50]);
    expect(chunkIds([])).toEqual([]);
  });

  it('token revocation: revoked counts as done', () => {
    const r = parseTokenRevokeResult({ requested: 2, revoked: 1, skipped: 0, failed: 1, results: [{ id: 'a', outcome: 'revoked' }, { id: 'b', outcome: 'failed', code: 'higher_privileges' }] });
    expect(r).toMatchObject({ requested: 2, revoked: 1, failed: 1 });
    expect(r.results.map((x) => x.outcome)).toEqual(['ok', 'failed']);
  });

  it('invite results, import summaries, group members, previews and project members', () => {
    expect(parseInviteResult({ user: { id: 'u1', name: 'Ann', email: 'a@b.co', role: 'user', canLogin: true }, invitationUrl: 'https://x/i', invitationEmailSent: true })).toMatchObject({
      userId: 'u1',
      invitationUrl: 'https://x/i',
      invitationEmailSent: true,
      generatedPassword: null,
    });
    expect(parseInviteResult({ user: { _id: 'u2', canLogin: false }, generatedPassword: 'pw' })).toMatchObject({ userId: 'u2', canLogin: false, generatedPassword: 'pw' });

    expect(parseImportSummary({ createdCount: 3, skippedExisting: ['a'], invalid: ['bad'], invalidCount: 1, halted: { at: 5 } })).toEqual({
      createdCount: 3,
      skippedExisting: ['a'],
      invalid: ['bad'],
      invalidCount: 1,
      halted: true,
    });
    expect(parseImportSummary({ created: [1, 2] })).toMatchObject({ createdCount: 2, halted: false });

    const members = parseGroupMembersPage({
      items: [
        { userId: 'u1', label: 'Ann', email: 'a@b.co', role: 'user', status: 'active', kind: 'person', membershipSource: 'ldap' },
        { userId: 'u9', missing: true },
        { userId: 'u1' },
      ],
      nextCursor: 'n',
      total: 7,
    });
    expect(members.items.map((m) => [m.userId, m.missing, m.membershipSource])).toEqual([['u1', false, 'ldap'], ['u9', true, 'local']]);
    expect(members).toMatchObject({ nextCursor: 'n', total: 7 });

    expect(parseAccessPreview({ effective: [{ service: 'models', level: 'read', sources: [] }], changes: [{ service: 'models', from: 'write', to: 'read' }, { from: 'x' }], projects: { before: 3, after: 1 } })).toMatchObject({
      changes: [{ service: 'models', from: 'write', to: 'read' }],
      projects: { before: 3, after: 1 },
    });
    expect(parseAccessPreview({}).projects).toBeNull();

    expect(parseProjectMember({ userId: 'u1', name: 'Ann', servicePermissions: { models: 'none', zzz: 'admin' }, ignoredServices: ['models'] })).toMatchObject({
      servicePermissions: { models: 'none' },
      ignoredServices: ['models'],
    });
    expect(parseProjectMember({ name: 'no id' })).toBeNull();
    expect(parseUserRecord({ _id: 'u1', directoryManaged: true, authProvider: 'ldap', status: 'disabled' })).toMatchObject({ directoryManaged: true, status: 'disabled' });
  });
});

describe('requests and failures', () => {
  it('sends a JSON content type only with a body', async () => {
    const calls = stubFetch(() => json({ message: 'ok', cleanup: { revokedTokens: 2 } }));
    await directoryApi.deleteUser('u 1');
    expect(calls[0]?.url).toBe('/api/users/u%201');
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(calls[0]?.init?.body).toBeUndefined();

    await directoryApi.removeProjectMember('p1', 'u1');
    expect(calls[1]?.init?.method).toBe('DELETE');
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ userId: 'u1' }));
    expect(calls[1]?.init?.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('sends the draft of a preview and the filters of a list', async () => {
    const calls = stubFetch((url) => (url.includes('/preview') ? json({ effective: [], changes: [] }) : json({ items: [], nextCursor: null })));
    await directoryApi.previewAccess('u1', { role: 'admin' });
    expect(calls[0]?.url).toBe('/api/iam/principals/user/u1/preview');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ role: 'admin' });
    await directoryApi.list({ type: 'token', filters: { ownerId: 'u1', status: 'active' }, count: true });
    expect(calls[1]?.url).toBe('/api/iam/principals?type=token&limit=25&ownerId=u1&status=active&count=1');
  });

  it('carries the decision id, the service and the required level of a refusal', async () => {
    stubFetch(() =>
      json(
        { error: 'Forbidden: members requires admin permission', code: 'forbidden', message: 'x', service: 'members', required: 'admin', decisionId: 'd-1' },
        { status: 403 },
      ),
    );
    const err = (await directoryApi.patchUser('u1', { role: 'user' }).catch((e: unknown) => e)) as DirectoryApiError;
    expect(err).toBeInstanceOf(DirectoryApiError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden', decisionId: 'd-1', service: 'members', required: 'admin' });
  });

  it('takes the decision id from the header when the body has none, and reads an outage', async () => {
    stubFetch(() => json({ error: 'Authorization unavailable', code: 'authorization_unavailable' }, { status: 503, headers: { 'X-Decision-Id': 'd-2', 'Retry-After': '5' } }));
    const err = (await directoryApi.capabilities().catch((e: unknown) => e)) as DirectoryApiError;
    expect(err).toMatchObject({ status: 503, code: 'authorization_unavailable', decisionId: 'd-2' });
  });

  it('keeps the status line for an answer that is not JSON', async () => {
    stubFetch(() => new Response('<html>', { status: 502 }));
    await expect(directoryApi.disableUser('u1')).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });

  it('reads the invitation link and refuses an answer without one', async () => {
    stubFetch(() => json({ invitationUrl: 'https://x/accept?t=1' }));
    await expect(directoryApi.invitationLink('u1')).resolves.toBe('https://x/accept?t=1');
    stubFetch(() => json({}));
    await expect(directoryApi.invitationLink('u1')).rejects.toMatchObject({ code: 'no_pending_invite' });
  });

  it('adds a member to a group, one request each, and removes an orphan by id', async () => {
    const calls = stubFetch(() => json({ message: 'ok' }));
    await directoryApi.addGroupMember('g1', 'u1');
    await directoryApi.removeGroupMember('g1', 'gone');
    expect(calls[0]).toMatchObject({ url: '/api/groups/g1/members' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ userId: 'u1', role: 'member' });
    expect(calls[1]?.url).toBe('/api/groups/g1/members/gone');
  });
});
