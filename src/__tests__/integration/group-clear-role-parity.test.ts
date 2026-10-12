/**
 * Clearing the tenant role of a group on BOTH providers: a role that is written as
 * null is gone, and the grants next to it are untouched. (A provider that leaves
 * an `undefined` field alone is why the API writes null.)
 */
import { expect, it } from 'vitest';
import type { DatabaseProvider } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Clearing the tenant role of a group', (getDb) => {
  it('removes the role and keeps the service permissions and the name', async () => {
    const db: DatabaseProvider = getDb();
    const slug = `clr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const tenantId = String((await db.createTenant({ companyName: 'Clear', slug, dbName, licenseType: 'FREE', ownerId: 'x' }))._id);
    await db.switchToTenant(dbName);
    const group = await db.createGroup({
      tenantId, name: 'Auditors', createdBy: 't', source: 'local', tenantRole: 'admin', servicePermissions: { audit: 'read' },
    } as never);
    const id = String(group._id);
    expect((await db.findGroupById(id))?.tenantRole).toBe('admin');

    await db.updateGroup(id, { tenantRole: null as never, updatedBy: 'a1' });
    const cleared = await db.findGroupById(id);
    expect(cleared?.tenantRole ?? null).toBeNull();
    expect(cleared?.name).toBe('Auditors');
    expect(cleared?.servicePermissions).toMatchObject({ audit: 'read' });

    // leaving it out leaves it as it is
    await db.updateGroup(id, { tenantRole: 'user', updatedBy: 'a1' });
    await db.updateGroup(id, { description: 'Reads the audit trail', updatedBy: 'a1' });
    expect((await db.findGroupById(id))?.tenantRole).toBe('user');
  });
});
