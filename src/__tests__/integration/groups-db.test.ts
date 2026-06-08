/**
 * Integration test for the user-group data layer against a real SQLite tenant DB.
 *
 * Exercises the group schema extensions (tenantRole, servicePermissions, source,
 * externalId), membership with provenance, project assignment, external-id lookup
 * used by LDAP sync, and the cascade-delete helpers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-groups-db-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'groups_db_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';

const TENANT_DB_NAME = 'groups_db_tenant';
const TENANT_ID = 'tenant-groups-db';

beforeAll(() => {
  reloadConfig();
});

afterAll(async () => {
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('groups data layer (sqlite)', () => {
  it('round-trips a group with tenant-level grants', async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    const created = await db.createGroup({
      tenantId: TENANT_ID,
      name: 'Platform Admins',
      description: 'Tenant admins via group',
      tenantRole: 'admin',
      servicePermissions: { audit: 'read', config: 'admin' },
      source: 'local',
      createdBy: 'owner-1',
    });

    const loaded = await db.findGroupById(String(created._id));
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Platform Admins');
    expect(loaded!.tenantRole).toBe('admin');
    expect(loaded!.servicePermissions).toEqual({ audit: 'read', config: 'admin' });
    expect(loaded!.source).toBe('local');
  });

  it('looks up a directory-sourced group by external id (LDAP sync path)', async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    const dn = 'cn=engineers,ou=groups,dc=example,dc=org';
    await db.createGroup({
      tenantId: TENANT_ID,
      name: 'Engineers',
      source: 'ldap',
      externalId: dn,
      createdBy: 'ldap-sync',
    });

    const found = await db.findGroupByExternalId(dn);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Engineers');
    expect(found!.source).toBe('ldap');
    expect(await db.findGroupByExternalId('cn=missing')).toBeNull();
  });

  it('tracks membership provenance and lists by user', async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    const group = await db.createGroup({
      tenantId: TENANT_ID, name: 'Squad A', source: 'local', createdBy: 'owner-1',
    });
    const groupId = String(group._id);

    await db.addGroupMember({ tenantId: TENANT_ID, groupId, userId: 'u-local', role: 'member', source: 'local' });
    await db.addGroupMember({ tenantId: TENANT_ID, groupId, userId: 'u-ldap', role: 'member', source: 'ldap' });

    const members = await db.listGroupMembers(groupId);
    expect(members).toHaveLength(2);
    const bySource = Object.fromEntries(members.map((m) => [m.userId, m.source]));
    expect(bySource['u-local']).toBe('local');
    expect(bySource['u-ldap']).toBe('ldap');

    const byUser = await db.listGroupMembersByUser('u-ldap');
    expect(byUser).toHaveLength(1);
    expect(byUser[0].groupId).toBe(groupId);
  });

  it('assigns projects to a group and lists them by group', async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    const group = await db.createGroup({
      tenantId: TENANT_ID, name: 'Squad B', source: 'local', createdBy: 'owner-1',
    });
    const groupId = String(group._id);

    await db.upsertGroupProject({
      tenantId: TENANT_ID, groupId, projectId: 'proj-1', role: 'project_admin', servicePermissions: { models: 'write' },
    });

    const byGroup = await db.listGroupProjectsByGroup(groupId);
    expect(byGroup).toHaveLength(1);
    expect(byGroup[0].role).toBe('project_admin');
    expect(byGroup[0].servicePermissions).toEqual({ models: 'write' });

    const byProject = await db.listGroupProjectsByProject('proj-1');
    expect(byProject.some((gp) => String(gp.groupId) === groupId)).toBe(true);
  });

  it('cascade helpers remove members and project assignments', async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    const group = await db.createGroup({
      tenantId: TENANT_ID, name: 'Squad C', source: 'local', createdBy: 'owner-1',
    });
    const groupId = String(group._id);
    await db.addGroupMember({ tenantId: TENANT_ID, groupId, userId: 'm1', role: 'member' });
    await db.upsertGroupProject({ tenantId: TENANT_ID, groupId, projectId: 'proj-c', role: 'member' });

    await db.deleteGroupMembersByGroup(groupId);
    await db.deleteGroupProjectsByGroup(groupId);
    await db.deleteGroup(groupId);

    expect(await db.listGroupMembers(groupId)).toHaveLength(0);
    expect(await db.listGroupProjectsByGroup(groupId)).toHaveLength(0);
    expect(await db.findGroupById(groupId)).toBeNull();
  });
});

describe('user identity provenance (sqlite)', () => {
  it('persists authProvider + externalId for directory-provisioned users', async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);

    const created = await db.createUser({
      email: 'ldapuser@example.org',
      name: 'LDAP User',
      password: 'ldap:placeholder',
      role: 'admin',
      tenantId: TENANT_ID,
      licenseId: 'lic_ent',
      features: [],
      authProvider: 'ldap',
      externalId: 'uid=ldapuser,ou=people,dc=example,dc=org',
    });

    const byId = await db.findUserById(String(created._id));
    expect(byId!.authProvider).toBe('ldap');
    expect(byId!.externalId).toBe('uid=ldapuser,ou=people,dc=example,dc=org');

    const byEmail = await db.findUserByEmail('ldapuser@example.org');
    expect(byEmail!.authProvider).toBe('ldap');

    // Local users default to 'local'.
    const local = await db.createUser({
      email: 'localuser@example.org', name: 'Local', password: 'x', role: 'user',
      tenantId: TENANT_ID, licenseId: 'FREE', features: [],
    });
    expect((await db.findUserById(String(local._id)))!.authProvider).toBe('local');
  });
});
