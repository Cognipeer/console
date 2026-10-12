/**
 * The view state of the Principals list: what round-trips through the address
 * bar, what is ignored, and what the request carries.
 */
import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  EMPTY_LIST_STATE,
  isNarrowed,
  LIST_PARAM_KEYS,
  listKey,
  listStateToParams,
  listStateToQuery,
  normalizePageSize,
  overlayToParams,
  parseListState,
  parseOverlay,
  resetListState,
  sameListState,
  type ListState,
} from '@/components/iam/principals/listState';

const read = (qs: string) => new URLSearchParams(qs);

describe('parseListState', () => {
  it('reads every people filter, the sort and the direction', () => {
    const state = parseListState(
      'user',
      read('q=%20ann%20&role=admin,user&status=invited&kind=service&source=ldap&sort=createdAt&dir=desc'),
    );
    expect(state).toEqual({
      ...EMPTY_LIST_STATE,
      q: 'ann',
      roles: ['admin', 'user'],
      status: 'invited',
      kind: 'service',
      source: 'ldap',
      sort: 'createdAt',
      dir: 'desc',
    });
  });

  it('drops unknown values instead of failing (a stale link is an unfiltered list)', () => {
    const state = parseListState('user', read('role=boss,admin,admin&status=gone&kind=robot&source=ftp&sort=age&dir=sideways'));
    expect(state.roles).toEqual(['admin']);
    expect(state.status).toBe('');
    expect(state.kind).toBe('');
    expect(state.source).toBe('');
    expect(state.sort).toBe('name');
    expect(state.dir).toBe('asc');
  });

  it('caps the search text at 100 characters', () => {
    expect(parseListState('user', read(`q=${'a'.repeat(300)}`)).q).toHaveLength(100);
  });

  it('reads only what applies to the segment', () => {
    const qs = 'q=x&role=admin&status=active&kind=person&source=local&group=g1&ownerId=u1&project=p1&scoped=true&sort=email';
    // a group is filtered by where it comes from and by the project it is assigned to - not by role, owner or scope
    expect(parseListState('group', read(qs))).toEqual({ ...EMPTY_LIST_STATE, q: 'x', source: 'local', projectId: 'p1' });
    expect(parseListState('token', read(qs))).toEqual({
      ...EMPTY_LIST_STATE,
      q: 'x',
      status: 'active',
      ownerId: 'u1',
      projectId: 'p1',
      scoped: 'true',
    });
    // a person is filtered by their group and their project
    expect(parseListState('user', read(qs))).toMatchObject({ groupId: 'g1', projectId: 'p1', roles: ['admin'], ownerId: '' });
  });

  it('still reads the older name of the project filter, and writes the new one', () => {
    expect(parseListState('token', read('projectId=p9')).projectId).toBe('p9');
    expect(parseListState('user', read('projectId=p9&group=g1')).projectId).toBe('p9');
    const written = listStateToParams('user', { ...EMPTY_LIST_STATE, projectId: 'p9', groupId: 'g1' });
    expect(written).toMatchObject({ project: 'p9', group: 'g1', projectId: null });
  });

  it('token statuses are active|expired (invited and disabled are people statuses)', () => {
    expect(parseListState('token', read('status=invited')).status).toBe('');
    expect(parseListState('user', read('status=expired')).status).toBe('');
    // a group comes from this workspace, LDAP or single sign-on; "saml" names an account source, not a group's
    expect(parseListState('group', read('source=saml')).source).toBe('');
    expect(parseListState('group', read('source=oidc')).source).toBe('oidc');
    expect(parseListState('group', read('source=directory')).source).toBe('directory');
  });
});

describe('listStateToParams / listStateToQuery', () => {
  it('writes null for defaults and for what does not apply, so a segment switch clears the URL', () => {
    const params = listStateToParams('user', EMPTY_LIST_STATE);
    expect(Object.keys(params).sort()).toEqual([...LIST_PARAM_KEYS].sort());
    expect(Object.values(params).every((v) => v === null)).toBe(true);

    const tokenState: ListState = { ...EMPTY_LIST_STATE, status: 'expired', ownerId: 'u1', groupId: 'g1' };
    // the same state read as people: the token-only filters are not written
    expect(listStateToParams('user', tokenState)).toMatchObject({ status: 'expired', ownerId: null, group: 'g1' });
    expect(listStateToParams('token', tokenState)).toMatchObject({ status: 'expired', ownerId: 'u1', group: null });
    expect(listStateToParams('group', tokenState)).toMatchObject({ status: null, ownerId: null, group: null });
  });

  it('round-trips every segment through the address bar', () => {
    const people: ListState = {
      ...EMPTY_LIST_STATE,
      q: 'lee',
      roles: ['owner', 'project_admin'],
      status: 'disabled',
      kind: 'person',
      source: 'saml',
      groupId: 'g7',
      projectId: 'p3',
      sort: 'email',
      dir: 'desc',
    };
    const tokens: ListState = { ...EMPTY_LIST_STATE, q: 'ci', status: 'active', ownerId: 'u9', projectId: 'p2', scoped: 'false' };
    const groups: ListState = { ...EMPTY_LIST_STATE, q: 'eng', source: 'ldap', projectId: 'p4' };
    for (const [type, state] of [['user', people], ['token', tokens], ['group', groups]] as const) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(listStateToParams(type, state))) if (value !== null) params.set(key, value);
      expect(parseListState(type, params)).toEqual(state);
    }
  });

  it('sends only the set filters to the server, and the default sort is left to the server', () => {
    expect(listStateToQuery('user', EMPTY_LIST_STATE)).toEqual({});
    expect(listStateToQuery('user', { ...EMPTY_LIST_STATE, roles: ['admin', 'user'], dir: 'desc' })).toEqual({
      role: 'admin,user',
      dir: 'desc',
    });
    expect(listStateToQuery('token', { ...EMPTY_LIST_STATE, scoped: 'true' })).toEqual({ scoped: 'true' });
    // the server names the filters `group` and `project`
    expect(listStateToQuery('user', { ...EMPTY_LIST_STATE, groupId: 'g1', projectId: 'p1' })).toEqual({ group: 'g1', project: 'p1' });
  });
});

describe('narrowing and identity of a view', () => {
  it('counts filters but not the search text or the sort', () => {
    expect(activeFilterCount('user', { ...EMPTY_LIST_STATE, q: 'a', sort: 'email' })).toBe(0);
    expect(activeFilterCount('user', { ...EMPTY_LIST_STATE, roles: ['admin'], status: 'active' })).toBe(2);
    expect(activeFilterCount('user', { ...EMPTY_LIST_STATE, groupId: 'g', projectId: 'p' })).toBe(2);
    expect(activeFilterCount('group', { ...EMPTY_LIST_STATE, source: 'local', projectId: 'p' })).toBe(2);
    expect(activeFilterCount('token', { ...EMPTY_LIST_STATE, ownerId: 'u', projectId: 'p', scoped: 'true', status: 'active' })).toBe(4);
  });

  it('is narrowed by a filter or by the search text', () => {
    expect(isNarrowed('user', EMPTY_LIST_STATE)).toBe(false);
    expect(isNarrowed('user', { ...EMPTY_LIST_STATE, q: '  ' })).toBe(false);
    expect(isNarrowed('user', { ...EMPTY_LIST_STATE, q: 'a' })).toBe(true);
    expect(isNarrowed('user', { ...EMPTY_LIST_STATE, kind: 'service' })).toBe(true);
  });

  it('reset clears everything, the search text and the sort included', () => {
    expect(resetListState()).toEqual(EMPTY_LIST_STATE);
    expect(resetListState().roles).not.toBe(EMPTY_LIST_STATE.roles);
  });

  it('changes the view key (paging, selection and totals start over) with any filter, search or page size', () => {
    const base = listKey('user', EMPTY_LIST_STATE, 25);
    expect(listKey('user', { ...EMPTY_LIST_STATE, q: 'a' }, 25)).not.toBe(base);
    expect(listKey('user', { ...EMPTY_LIST_STATE, roles: ['admin'] }, 25)).not.toBe(base);
    expect(listKey('user', { ...EMPTY_LIST_STATE, sort: 'email' }, 25)).not.toBe(base);
    expect(listKey('user', EMPTY_LIST_STATE, 50)).not.toBe(base);
    expect(listKey('group', EMPTY_LIST_STATE, 25)).not.toBe(base);
    // what does not apply to the segment does not change the view
    expect(listKey('group', { ...EMPTY_LIST_STATE, ownerId: 'u1' }, 25)).toBe(listKey('group', EMPTY_LIST_STATE, 25));
    expect(sameListState('user', EMPTY_LIST_STATE, { ...EMPTY_LIST_STATE })).toBe(true);
  });

  it('snaps the page size to the allowed sizes', () => {
    expect(normalizePageSize(50)).toBe(50);
    expect(normalizePageSize('100')).toBe(100);
    expect(normalizePageSize(33)).toBe(25);
    expect(normalizePageSize('x')).toBe(25);
  });
});

describe('overlays (full-screen forms)', () => {
  it('reads new= and edit= and ignores anything else', () => {
    expect(parseOverlay(read('new=service'))).toEqual({ new: 'service', edit: null });
    expect(parseOverlay(read('edit=role&principalId=u1'))).toEqual({ new: null, edit: 'role' });
    expect(parseOverlay(read('new=1&edit=nothing'))).toEqual({ new: null, edit: null });
  });

  it('writes one overlay at a time: creating wins over editing', () => {
    expect(overlayToParams({ new: 'group', edit: 'role' })).toEqual({ new: 'group', edit: null });
    expect(overlayToParams({ new: null, edit: 'access' })).toEqual({ new: null, edit: 'access' });
    expect(overlayToParams({ new: null, edit: null })).toEqual({ new: null, edit: null });
  });
});
