/**
 * Provider project scoping.
 *
 * A provider assigned to project A via `projectIds` must surface ONLY in
 * project A, never in the default project. This used to be violated by the
 * `assignProjectIdToLegacyRecords` backfill (which stamped the default
 * project's id onto every provider missing the legacy `projectId` field); that
 * backfill was removed entirely (prod verified 0 legacy rows), so the leak
 * cannot recur — this test guards the underlying `listProviders` scoping filter
 * (`projectId = X OR projectIds contains X`) directly, without any backfill.
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

describeForEachProvider('Provider project scoping', (getDb) => {
  it('surfaces a projectIds-assigned provider only in its own project', async () => {
    const db = getDb();
    await db.switchToTenant('tenant_scope_a');

    const created = await db.createProvider(
      providerRecord('scoped', { projectIds: [PROJECT_A] }),
    );

    const inDefault = await db.listProviders(TENANT, { projectId: DEFAULT_PROJECT });
    expect(inDefault.map((p) => p.key)).not.toContain(created.key);

    const inA = await db.listProviders(TENANT, { projectId: PROJECT_A });
    expect(inA.map((p) => p.key)).toContain(created.key);
  });
});
