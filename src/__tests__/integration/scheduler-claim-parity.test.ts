/**
 * Scheduler claims parity — the exactly-once primitive behaves identically on
 * SQLite and MongoDB: one winner per key (decided by the database), losers get
 * false, and the cleanup sweep removes only expired claims.
 */

import { it, expect, beforeEach } from 'vitest';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Scheduler claims', (getDb) => {
  beforeEach(async () => {
    const slug = `claims-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    await db.switchToTenant(dbName);
  });

  const future = () => new Date(Date.now() + 60_000);

  it('grants a key once and refuses the second claim', async () => {
    const db = getDb();
    expect(await db.claimSchedulerSlot('crawler:c1:default:2026-05-19T10:00:00.000Z', future())).toBe(true);
    expect(await db.claimSchedulerSlot('crawler:c1:default:2026-05-19T10:00:00.000Z', future())).toBe(false);
  });

  it('treats different keys independently', async () => {
    const db = getDb();
    expect(await db.claimSchedulerSlot('k:1', future())).toBe(true);
    expect(await db.claimSchedulerSlot('k:2', future())).toBe(true);
  });

  it('lets exactly one of many concurrent claimers win', async () => {
    const db = getDb();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => db.claimSchedulerSlot('race:slot', future())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('cleanup removes only expired claims and frees their keys', async () => {
    const db = getDb();
    await db.claimSchedulerSlot('old', new Date(Date.now() - 60_000));
    await db.claimSchedulerSlot('fresh', future());
    expect(await db.cleanupSchedulerClaims(new Date())).toBe(1);
    expect(await db.claimSchedulerSlot('old', future())).toBe(true);
    expect(await db.claimSchedulerSlot('fresh', future())).toBe(false);
  });
});
