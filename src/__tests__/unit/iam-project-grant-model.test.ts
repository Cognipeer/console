import { describe, expect, it } from 'vitest';
import {
  buildAddRequest,
  buildOffers,
  membershipSource,
  pruneSelection,
  roleEditable,
  setAllRoles,
  skipReasonKey,
  summarizeAddResult,
  toggleProject,
} from '@/components/iam/principals/projectGrantModel';
import { activeSection, visibleSections } from '@/components/iam/principals/sectionNav';
import { buildExternalBody, checkExternal, conflictField } from '@/components/iam/principals/externalModel';
import { listStateToParams, parseListState, EMPTY_LIST_STATE } from '@/components/iam/principals/listState';
import { outcomeOfError } from '@/components/iam/principals/RequestAccess';
import { DirectoryApiError } from '@/components/iam/principals/directoryApi';

const ref = (over: Record<string, unknown>) => ({ id: 'p', name: 'P', role: 'member', via: 'direct', groupName: null, ...over }) as never;

describe('membershipSource', () => {
  it('tells direct, directory default, group, legacy and implicit apart', () => {
    expect(membershipSource(ref({}))).toEqual({ kind: 'direct' });
    expect(membershipSource(ref({ source: 'directory' }))).toEqual({ kind: 'directory' });
    expect(membershipSource(ref({ via: 'group', groupName: 'Eng', groupId: 'g1' }))).toEqual({ kind: 'group', groupName: 'Eng', groupId: 'g1' });
    expect(membershipSource(ref({ via: 'legacy' }))).toEqual({ kind: 'legacy' });
    expect(membershipSource(ref({ via: 'implicit' }))).toEqual({ kind: 'implicit' });
  });
  it('leaves group and implicit roles read-only', () => {
    expect(roleEditable({ kind: 'group' })).toBe(false);
    expect(roleEditable({ kind: 'implicit' })).toBe(false);
    expect(roleEditable({ kind: 'directory' })).toBe(true);
  });
});

describe('offers and selection', () => {
  const projects = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'c', name: 'Gamma' },
    { id: 'd', name: 'Delta' },
  ];
  const memberships = [ref({ id: 'a', name: 'Alpha' }), ref({ id: 'c', name: 'Gamma', via: 'group', groupName: 'Eng', groupId: 'g1' })];
  const offers = buildOffers(projects, memberships);

  it('orders free, inherited, locked and locks only direct memberships', () => {
    expect(offers.map((o) => [o.id, o.state])).toEqual([['b', 'free'], ['d', 'free'], ['c', 'inherited'], ['a', 'locked']]);
  });
  it('toggles, sets roles and prunes locked picks', () => {
    let sel = toggleProject([], 'b');
    sel = toggleProject(sel, 'a');
    expect(sel).toHaveLength(2);
    expect(pruneSelection(sel, offers).map((s) => s.projectId)).toEqual(['b']);
    expect(setAllRoles(sel, 'project_admin').every((s) => s.role === 'project_admin')).toBe(true);
    expect(toggleProject(sel, 'b').map((s) => s.projectId)).toEqual(['a']);
  });
  it('builds the request: project default is null, notify only when on', () => {
    const sel = toggleProject([], 'b');
    expect(buildAddRequest({ selection: sel, custom: null, notify: false })).toEqual({ projects: [{ projectId: 'b', role: 'member' }], servicePermissions: null });
    expect(buildAddRequest({ selection: sel, custom: { agents: 'read' } as never, notify: true })).toMatchObject({ servicePermissions: { agents: 'read' }, notify: true });
  });
  it('summarises the answer with project names and falls back on unknown reasons', () => {
    const out = summarizeAddResult({ added: ['b'], updated: [], skipped: [{ projectId: 'a', reason: 'already_member' }] }, (id) => `n-${id}`);
    expect(out).toEqual({ added: 1, updated: 0, skipped: [{ projectId: 'a', name: 'n-a', reason: 'already_member' }] });
    expect(skipReasonKey('weird')).toBe('unknown');
    expect(skipReasonKey('project_not_found')).toBe('project_not_found');
  });
});

describe('jump bar', () => {
  it('hides tokens when not visible', () => {
    expect(visibleSections({ hasGroups: true, hasTokens: false })).not.toContain('tokens');
    expect(visibleSections({ hasGroups: true, hasTokens: true })).toHaveLength(7);
  });
  it('picks the last section scrolled past the offset', () => {
    const tops = [{ id: 'a', top: -300 }, { id: 'b', top: 40 }, { id: 'c', top: 500 }];
    expect(activeSection(tops, 96)).toBe('b');
    expect(activeSection([{ id: 'a', top: 200 }], 96)).toBe('a');
    expect(activeSection([], 96)).toBeNull();
  });
});

describe('external form', () => {
  it('needs issuer and subject, tolerates an empty email', () => {
    expect(checkExternal({ issuer: null, subject: 'x', name: '', email: '', active: true }).ready).toBe(false);
    expect(checkExternal({ issuer: 'i', subject: ' ', name: '', email: '', active: true }).ready).toBe(false);
    expect(checkExternal({ issuer: 'i', subject: 'x', name: '', email: 'bad', active: true }).ready).toBe(false);
    expect(checkExternal({ issuer: 'i', subject: 'x', name: '', email: '', active: true }).ready).toBe(true);
  });
  it('leaves blank optionals out of the body and maps 409 codes to fields', () => {
    expect(buildExternalBody({ issuer: 'i', subject: ' s ', name: '', email: '', active: false }, [])).toEqual({ issuer: 'i', subject: 's', active: false });
    expect(buildExternalBody({ issuer: 'i', subject: 's', name: 'N', email: 'a@b.co', active: true }, ['g'])).toMatchObject({ name: 'N', email: 'a@b.co', groupIds: ['g'] });
    expect(conflictField('identity_taken')).toBe('subject');
    expect(conflictField('email_taken')).toBe('email');
    expect(conflictField('other')).toBeNull();
  });
});

describe('requested access filter and request outcome', () => {
  it('round-trips through the address bar for people only', () => {
    const state = parseListState('user', new URLSearchParams('access=requested'));
    expect(state.access).toBe('requested');
    expect(listStateToParams('user', state).access).toBe('requested');
    expect(listStateToParams('group', state).access).toBeNull();
    expect(parseListState('user', new URLSearchParams('access=bogus')).access).toBe(EMPTY_LIST_STATE.access);
  });
  it('words 429 and 409 apart from other failures', () => {
    expect(outcomeOfError(new DirectoryApiError('x', 429))).toBe('rate_limited');
    expect(outcomeOfError(new DirectoryApiError('x', 409))).toBe('has_access');
    expect(outcomeOfError(new Error('boom'))).toBe('failed');
  });
});
