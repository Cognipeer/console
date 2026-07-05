/**
 * Parity test — provider project scoping vs the legacy-projectId backfill.
 *
 * Regression for a cross-project leak: `assignProjectIdToLegacyRecords` (run
 * on every project-context resolution via ensureDefaultProject) used to stamp
 * the DEFAULT project's id onto EVERY provider row missing the legacy
 * `projectId` field — including new-style records that are correctly assigned
 * via `projectIds`. The `listProviders` filter (`projectId = X OR projectIds
 * contains X`) then surfaced those records in the default project too, so a
 * Web Search instance (or any provider) created in project A also appeared
 * after switching to the default project.
 */

import { expect, it } from 'vitest';
import { describeForEachProvider } from './db-parity.helper';

const TENANT = 'tenant-scope';
const PROJECT_A = 'project-aaaa';
const DEFAULT_PROJECT = 'project-default';

let seq = 0;
function providerRecord(key: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    tenantId: TENANT,
    key: `${key}-${seq}`,
    type: 'websearch' as const,
    driver: 'duckduckgo',
    label: key,
    status: 'active' as const,
    credentialsEnc: 'enc',
    settings: {},
    createdBy: 'user-1',
    ...extra,
  };
}

describeForEachProvider('Provider scoping vs legacy backfill', (getDb) => {
  it('does not stamp the default project onto projectIds-assigned providers', async () => {
    const db = getDb();
    await db.switchToTenant('tenant_scope_a');

    const created = await db.createProvider(
      providerRecord('scoped', { projectIds: [PROJECT_A] }),
    );

    await db.assignProjectIdToLegacyRecords(TENANT, DEFAULT_PROJECT);

    const inDefault = await db.listProviders(TENANT, { projectId: DEFAULT_PROJECT });
    expect(inDefault.map((p) => p.key)).not.toContain(created.key);

    const inA = await db.listProviders(TENANT, { projectId: PROJECT_A });
    expect(inA.map((p) => p.key)).toContain(created.key);
  });

  it('still backfills truly unassigned legacy providers into the default project', async () => {
    const db = getDb();
    await db.switchToTenant('tenant_scope_b');

    const legacy = await db.createProvider(providerRecord('legacy'));

    await db.assignProjectIdToLegacyRecords(TENANT, DEFAULT_PROJECT);

    const inDefault = await db.listProviders(TENANT, { projectId: DEFAULT_PROJECT });
    expect(inDefault.map((p) => p.key)).toContain(legacy.key);
  });

  it('self-heals providers previously stamped with the default project', async () => {
    const db = getDb();
    await db.switchToTenant('tenant_scope_c');

    // Simulate the pre-fix state: projectIds-assigned record that the old
    // unconditional backfill stamped with the default project's id.
    const leaked = await db.createProvider(
      providerRecord('leaked', { projectId: DEFAULT_PROJECT, projectIds: [PROJECT_A] }),
    );

    const before = await db.listProviders(TENANT, { projectId: DEFAULT_PROJECT });
    expect(before.map((p) => p.key)).toContain(leaked.key);

    await db.assignProjectIdToLegacyRecords(TENANT, DEFAULT_PROJECT);

    const after = await db.listProviders(TENANT, { projectId: DEFAULT_PROJECT });
    expect(after.map((p) => p.key)).not.toContain(leaked.key);

    const inA = await db.listProviders(TENANT, { projectId: PROJECT_A });
    expect(inA.map((p) => p.key)).toContain(leaked.key);
  });
});
