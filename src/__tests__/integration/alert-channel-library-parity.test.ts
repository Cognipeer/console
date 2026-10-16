/**
 * Alert channel library (`alert_channel_library`), run against BOTH providers.
 */

import { it, expect, beforeEach } from 'vitest';

import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Alert channel library', (getDb) => {
  let tenantId: string;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `alert-lib-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Alert Library', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    await db.switchToTenant(dbName);
    tenantId = String(tenant._id);
  });

  it('reads nothing before the first write, then round-trips an entry', async () => {
    const db = getDb();
    expect(await db.listAlertChannelLibrary(tenantId)).toEqual([]);
    expect(await db.findAlertChannelLibraryEntry('does-not-exist')).toBeNull();

    const created = await db.createAlertChannelLibraryEntry({
      tenantId,
      name: 'Ops Slack',
      kind: 'slack',
      config: { id: 'ch_aaaaaaaaaaaa', type: 'slack', urlHint: 'https://hooks.slack.com/…/ABCD', sealed: 'sealed-payload' },
      createdBy: 'user-1',
    });
    expect(created._id).toBeTruthy();
    expect(created).toMatchObject({ tenantId, name: 'Ops Slack', kind: 'slack', createdBy: 'user-1' });
    expect(created.createdAt).toBeInstanceOf(Date);

    const found = await db.findAlertChannelLibraryEntry(String(created._id));
    expect(found?.config).toEqual(created.config);
    expect((await db.listAlertChannelLibrary(tenantId)).map((e) => e.name)).toEqual(['Ops Slack']);
    expect(await db.listAlertChannelLibrary('another-tenant')).toEqual([]);
  });

  it('updates name and config (kind follows the config) and deletes', async () => {
    const db = getDb();
    const created = await db.createAlertChannelLibraryEntry({
      tenantId,
      name: 'Mail',
      kind: 'email',
      config: { id: 'ch_bbbbbbbbbbbb', type: 'email', recipients: ['a@b.co'] },
      createdBy: 'user-1',
    });
    const id = String(created._id);
    const renamed = await db.updateAlertChannelLibraryEntry(id, { name: 'Mail 2' });
    expect(renamed).toMatchObject({ name: 'Mail 2', kind: 'email' });
    const reconfigured = await db.updateAlertChannelLibraryEntry(id, {
      config: { id: 'ch_bbbbbbbbbbbb', type: 'email', recipients: ['c@d.co', 'e@f.co'] },
    });
    expect(reconfigured?.config).toMatchObject({ recipients: ['c@d.co', 'e@f.co'] });
    expect(await db.updateAlertChannelLibraryEntry('missing-id', { name: 'x' })).toBeNull();

    expect(await db.deleteAlertChannelLibraryEntry(id)).toBe(true);
    expect(await db.deleteAlertChannelLibraryEntry(id)).toBe(false);
    expect(await db.findAlertChannelLibraryEntry(id)).toBeNull();
  });

  it('lists entries by name', async () => {
    const db = getDb();
    for (const name of ['zeta', 'Alpha', 'mike']) {
      await db.createAlertChannelLibraryEntry({
        tenantId,
        name,
        kind: 'email',
        config: { type: 'email', recipients: [] },
        createdBy: 'u',
      });
    }
    expect((await db.listAlertChannelLibrary(tenantId)).map((e) => e.name).sort()).toEqual(['Alpha', 'mike', 'zeta']);
  });
});
