/**
 * What the directory accepts in a request: the filters of each kind of principal,
 * their aliases, which ones are ignored for a type they do not apply to, and how a
 * request's filters become the provider's query.
 */
import { describe, expect, it } from 'vitest';
import { MAX_DIRECTORY_IDS, parseDirectoryFilters, userFilterOf } from '@/lib/iam/directory';

const ok = (type: 'user' | 'group' | 'token', raw: Record<string, unknown>) => {
  const parsed = parseDirectoryFilters(type, raw);
  if (!parsed.ok) throw new Error(`expected ok, got ${JSON.stringify(parsed.details)}`);
  return parsed;
};
const issues = (type: 'user' | 'group' | 'token', raw: Record<string, unknown>) => {
  const parsed = parseDirectoryFilters(type, raw);
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed.details.map((d) => d.field);
};

describe('people filters', () => {
  it('accepts none, and drops empty values', () => {
    expect(ok('user', {})).toEqual({ ok: true, filters: {} });
    expect(ok('user', { role: '', status: '', kind: '', source: '', sort: '', dir: '', group: '', project: '' }).filters).toEqual({});
  });

  it('reads roles as a list, once each', () => {
    expect(ok('user', { role: 'admin, owner,admin' }).filters.roles).toEqual(['admin', 'owner']);
    expect(issues('user', { role: 'admin,boss' })).toEqual(['role']);
    expect(issues('user', { role: ',' })).toEqual(['role']);
  });

  it('reads the status, kind, sort and direction from their words', () => {
    expect(ok('user', { status: 'invited', kind: 'service', sort: 'createdAt', dir: 'desc' }).filters).toEqual({
      status: 'invited', kind: 'service', sort: 'createdAt', dir: 'desc',
    });
    expect(issues('user', { status: 'sleeping', kind: 'robot', sort: 'popularity', dir: 'sideways' }).sort()).toEqual(['dir', 'kind', 'sort', 'status']);
  });

  it('maps a source onto the providers it stands for', () => {
    expect(ok('user', { source: 'local' }).filters.providers).toEqual(['local']);
    expect(ok('user', { source: 'ldap' }).filters.providers).toEqual(['ldap']);
    expect(ok('user', { source: 'sso' }).filters.providers).toEqual(['oidc', 'saml']);
    expect(ok('user', { source: 'directory' }).filters.providers).toEqual(['ldap', 'oidc', 'saml']);
    expect(ok('user', { source: 'local,sso,oidc' }).filters.providers).toEqual(['local', 'oidc', 'saml']);
    expect(issues('user', { source: 'github' })).toEqual(['source']);
    expect(issues('user', { source: 'ldap,github' })).toEqual(['source']);
  });

  it('takes the group and project under either spelling, and only valid ids', () => {
    expect(ok('user', { group: 'g1', project: 'p1' }).filters).toEqual({ groupId: 'g1', projectId: 'p1' });
    expect(ok('user', { groupId: 'g1', projectId: 'p1' }).filters).toEqual({ groupId: 'g1', projectId: 'p1' });
    expect(issues('user', { group: 'a b', project: 'x/y' }).sort()).toEqual(['group', 'project']);
  });

  it('refuses a value given twice (the query is ambiguous)', () => {
    expect(issues('user', { role: ['admin', 'user'] })).toEqual(['role']);
    expect(issues('user', { status: ['active', 'disabled'] })).toEqual(['status']);
  });
});

describe('group filters', () => {
  it('reads the source and the project', () => {
    expect(ok('group', { source: 'local' }).filters).toEqual({ groupSources: ['local'] });
    expect(ok('group', { source: 'directory' }).filters).toEqual({ groupSources: ['ldap', 'oidc'] });
    expect(ok('group', { source: 'oidc' }).filters).toEqual({ groupSources: ['oidc'] });
    expect(ok('group', { source: 'sso' }).filters).toEqual({ groupSources: ['oidc'] });
    expect(ok('group', { source: 'local,ldap', project: 'p1' }).filters).toEqual({ groupSources: ['local', 'ldap'], projectId: 'p1' });
    expect(issues('group', { source: 'saml' })).toEqual(['source']);
  });
});

describe('token filters', () => {
  it('reads the status, owner, project and scope', () => {
    expect(ok('token', { status: 'expired', ownerId: 'u1', project: 'p1', scoped: 'true' }).filters).toEqual({
      tokenStatus: 'expired', ownerId: 'u1', projectId: 'p1', scoped: true,
    });
    expect(ok('token', { owner: 'u1', scoped: 'false' }).filters).toEqual({ ownerId: 'u1', scoped: false });
    expect(issues('token', { status: 'revoked', scoped: 'maybe', ownerId: 'a b' }).sort()).toEqual(['ownerId', 'scoped', 'status']);
  });
});

describe('what does not apply is ignored, what does must be right', () => {
  it('ignores the filters of other types', () => {
    expect(ok('group', { role: 'boss', kind: 'robot', sort: 'nope', status: 'x', scoped: 'maybe' }).filters).toEqual({});
    expect(ok('token', { role: 'boss', source: 'nope', group: 'a b', sort: 'nope' }).filters).toEqual({});
    expect(ok('user', { scoped: 'maybe', ownerId: 'a b' }).filters).toEqual({});
  });

  it('reads ids for every type: a bounded list of valid ids', () => {
    expect(ok('user', { ids: 'a,b, c ,a' }).ids).toEqual(['a', 'b', 'c']);
    expect(ok('token', { ids: 'x' }).ids).toEqual(['x']);
    expect(issues('user', { ids: 'a,b c' })).toEqual(['ids']);
    expect(issues('user', { ids: ',' })).toEqual(['ids']);
    expect(issues('user', { ids: Array.from({ length: MAX_DIRECTORY_IDS + 1 }, (_, i) => `id${i}`).join(',') })).toEqual(['ids']);
    expect(ok('user', { ids: Array.from({ length: MAX_DIRECTORY_IDS }, (_, i) => `id${i}`).join(',') }).ids).toHaveLength(MAX_DIRECTORY_IDS);
  });

  it('reports every bad field at once', () => {
    expect(issues('user', { role: 'boss', status: 'x', ids: 'a b' }).sort()).toEqual(['ids', 'role', 'status']);
  });
});

describe('the provider query a request becomes', () => {
  const filter = (over: Parameters<typeof userFilterOf>[1] = {}) => userFilterOf('t1', over);

  it('is the whole workspace without filters', () => {
    expect(filter()).toEqual({ tenantId: 't1' });
  });

  it('turns the three statuses into a partition: active is neither disabled nor waiting for an answer', () => {
    expect(filter({ status: 'active' })).toEqual({ tenantId: 't1', status: 'active', invited: false });
    expect(filter({ status: 'disabled' })).toEqual({ tenantId: 't1', status: 'disabled' });
    expect(filter({ status: 'invited' })).toEqual({ tenantId: 't1', invited: true });
  });

  it('turns a kind into whether the account can sign in', () => {
    // an external account (a host application's person) cannot sign in either, but is neither of these
    expect(filter({ kind: 'person' })).toEqual({ tenantId: 't1', canLogin: true, external: false });
    expect(filter({ kind: 'service' })).toEqual({ tenantId: 't1', canLogin: false, external: false });
    expect(filter({ kind: 'external' })).toEqual({ tenantId: 't1', external: true });
  });

  it('carries the rest across', () => {
    expect(filter({ q: 'ada', ids: ['a'], roles: ['admin'], providers: ['ldap'], groupId: 'g', projectId: 'p' })).toEqual({
      tenantId: 't1', q: 'ada', ids: ['a'], roles: ['admin'], authProviders: ['ldap'], groupId: 'g', projectId: 'p',
    });
  });
});
