import { describe, expect, it } from 'vitest';
import {
  buildRows,
  bulkRemoveBody,
  bulkRoleBody,
  filterCounts,
  filterRows,
  parseMembers,
  splitSelection,
} from '@/components/projects/detail/membersModel';
import {
  buildAddRequests,
  countByType,
  lockReason,
  setAllRoles,
  setPickRole,
  togglePick,
  type ExistingAccess,
} from '@/components/projects/detail/addPeopleModel';

const payload = {
  capabilities: { canAssignMembers: true, canRemoveMembers: true },
  members: [
    { userId: 'o1', name: 'Olga', email: 'o@x.io', role: 'owner', implicit: true, projectRole: null },
    { userId: 'u1', name: 'Ada', email: 'ada@x.io', role: 'user', projectRole: 'project_admin', implicit: false, source: 'manual' },
    { userId: 'u2', name: 'Bo', email: 'bo@x.io', role: 'user', projectRole: 'member', implicit: false, source: 'directory' },
  ],
  groups: [{ groupId: 'g1', name: 'Eng', role: 'member', memberCount: 4, directorySynced: true }],
  tenantAdmins: [{ userId: 'o1', name: 'Olga', email: 'o@x.io', role: 'owner' }],
};

describe('members model', () => {
  const data = parseMembers(payload);
  const rows = buildRows(data);

  it('parses capabilities, source defaults and tenant admins', () => {
    expect(data.capabilities.canAssignMembers).toBe(true);
    expect(data.capabilities.canInviteMembers).toBe(false);
    expect(data.members[2].source).toBe('directory');
    expect(data.tenantAdmins).toHaveLength(1);
  });

  it('keeps implicit admins out of the grid rows', () => {
    expect(rows.map((r) => r.key)).toEqual(['u:u1', 'u:u2', 'g:g1']);
  });

  it('filters by source, admins and search', () => {
    expect(filterRows(rows, 'direct', '').map((r) => r.key)).toEqual(['u:u1']);
    expect(filterRows(rows, 'directory', '').map((r) => r.key)).toEqual(['u:u2']);
    expect(filterRows(rows, 'group', '').map((r) => r.key)).toEqual(['g:g1']);
    expect(filterRows(rows, 'admins', '').map((r) => r.key)).toEqual(['u:u1']);
    expect(filterRows(rows, 'all', 'BO@').map((r) => r.key)).toEqual(['u:u2']);
    expect(filterCounts(rows)).toEqual({ all: 3, direct: 1, group: 1, directory: 1, admins: 1 });
  });

  it('splits a selection and builds bulk bodies', () => {
    const sel = splitSelection(rows, new Set(['u:u1', 'g:g1']));
    expect(sel).toEqual({ userIds: ['u1'], groupIds: ['g1'] });
    expect(bulkRoleBody(['u1'], 'member')).toEqual({ setRole: [{ userId: 'u1', role: 'member' }] });
    expect(bulkRemoveBody(['u1', 'u2'])).toEqual({ remove: ['u1', 'u2'] });
  });
});

describe('add people model', () => {
  const existing: ExistingAccess = {
    userIds: new Set(['u1']),
    groupIds: new Set(['g1']),
    adminIds: new Set(['o1']),
  };

  it('locks members, admins, external, disabled and granted groups', () => {
    expect(lockReason('user', { id: 'u1', kind: 'person', status: 'active' }, existing)).toBe('member');
    expect(lockReason('user', { id: 'o1', kind: 'person', status: 'active' }, existing)).toBe('admin');
    expect(lockReason('user', { id: 'x', kind: 'external', status: 'active' }, existing)).toBe('external');
    expect(lockReason('user', { id: 'd', kind: 'person', status: 'disabled' }, existing)).toBe('disabled');
    expect(lockReason('user', { id: 'ok', kind: 'person', status: 'active' }, existing)).toBeNull();
    expect(lockReason('group', { id: 'g1', kind: undefined, status: null }, existing)).toBe('group');
  });

  it('toggles, sets roles and builds the requests', () => {
    let picked = togglePick([], { type: 'user', id: 'a', label: 'A', sublabel: null });
    picked = togglePick(picked, { type: 'group', id: 'g', label: 'G', sublabel: null });
    picked = setPickRole(picked, 'group:g', 'project_admin');
    expect(buildAddRequests(picked)).toEqual({
      users: [{ userId: 'a', role: 'member' }],
      groups: [{ groupId: 'g', role: 'project_admin' }],
    });
    expect(countByType(picked)).toEqual({ users: 1, groups: 1 });
    expect(setAllRoles(picked, 'member').every((p) => p.role === 'member')).toBe(true);
    expect(togglePick(picked, { type: 'user', id: 'a', label: 'A', sublabel: null })).toHaveLength(1);
  });
});
