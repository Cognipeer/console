/**
 * The three-way `projectId` contract of the by-key lookups, on BOTH providers.
 *
 *   - a string  → that project's row only;
 *   - `null`    → the TENANT-WIDE row only (`projectId IS NULL` / `{ projectId: null }`);
 *   - undefined → the first row with that key in ANY project.
 *
 * Keys are unique per project, not per tenant, so two projects sharing a key is
 * the normal case (presets, slugs). Before `null` existed every "workspace-wide
 * fallback" in the runtime asked with `undefined` and was handed whichever
 * project's row sorted first — project A's binding evaluating against project
 * B's policy the moment A's own row was gone. The parity harness runs this
 * against SQLite and, when mongodb-memory-server is installed, MongoDB, because
 * the two spell "no project" differently on disk (`NULL` column vs. a missing
 * field) and the whole point is that both answer the `null` question the same.
 */

import { beforeEach, expect, it } from 'vitest';

import type { IGuardrail, IGuardrailWordList, IPiiPolicy } from '@/lib/database/provider.interface';
import { describeForEachProvider } from '../integration/db-parity.helper';

const suffix = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const idOf = (row: { _id?: unknown } | null | undefined): string | undefined =>
  row?._id === undefined ? undefined : String(row._id);

describeForEachProvider('by-key lookups: project / tenant-wide (null) / any (undefined)', (getDb) => {
  const tenantId = 'tenant-fix-null-lookup';
  const dbName = `tenant_fix_null_lookup_${suffix()}`;

  beforeEach(async () => {
    await getDb().switchToTenant(dbName);
  });

  const guardrail = (
    projectId: string | undefined,
    key: string,
  ): Omit<IGuardrail, '_id' | 'createdAt' | 'updatedAt'> => ({
    tenantId,
    projectId,
    key,
    name: `Guardrail ${key}`,
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    createdBy: 'user-1',
  });

  const wordList = (
    projectId: string | undefined,
    key: string,
  ): Omit<IGuardrailWordList, '_id' | 'createdAt' | 'updatedAt'> => ({
    tenantId,
    projectId,
    key,
    name: `List ${key}`,
    words: [projectId ?? 'tenant-wide'],
    createdBy: 'user-1',
  });

  const piiPolicy = (
    projectId: string | undefined,
    key: string,
  ): Omit<IPiiPolicy, '_id' | 'createdAt' | 'updatedAt'> => ({
    tenantId,
    projectId,
    key,
    name: `PII ${key}`,
    defaultAction: 'redact',
    categories: { email: true },
    enabled: true,
    createdBy: 'user-1',
  });

  it('findGuardrailByKey(key, null) ignores rows other projects hold under the same key', async () => {
    const db = getDb();
    const key = `shared-${suffix()}`;
    const a = await db.createGuardrail(guardrail('proj-a', key));
    await db.createGuardrail(guardrail('proj-b', key));

    expect(idOf(await db.findGuardrailByKey(key, 'proj-a'))).toBe(idOf(a));
    // THE PIN: no tenant-wide row exists, so the tenant-wide question is "no".
    expect(await db.findGuardrailByKey(key, null)).toBeNull();
    // `undefined` keeps its old meaning for the callers that want "any".
    expect(await db.findGuardrailByKey(key)).not.toBeNull();
  });

  it('findGuardrailByKey(key, null) finds the row no project owns beside a project row with the same key', async () => {
    const db = getDb();
    const key = `wide-${suffix()}`;
    const scoped = await db.createGuardrail(guardrail('proj-a', key));
    const wide = await db.createGuardrail(guardrail(undefined, key));

    const found = await db.findGuardrailByKey(key, null);
    expect(idOf(found)).toBe(idOf(wide));
    expect(found?.projectId ?? null).toBeNull();
    expect(idOf(await db.findGuardrailByKey(key, 'proj-a'))).toBe(idOf(scoped));
  });

  it('findGuardrailWordListByKey follows the same contract', async () => {
    const db = getDb();
    const key = `list-${suffix()}`;
    await db.createGuardrailWordList(wordList('proj-a', key));
    await db.createGuardrailWordList(wordList('proj-b', key));
    expect(await db.findGuardrailWordListByKey(key, null)).toBeNull();

    const wide = await db.createGuardrailWordList(wordList(undefined, key));
    const found = await db.findGuardrailWordListByKey(key, null);
    expect(idOf(found)).toBe(idOf(wide));
    expect(found?.words).toEqual(['tenant-wide']);
    expect((await db.findGuardrailWordListByKey(key, 'proj-b'))?.words).toEqual(['proj-b']);
  });

  it('findPiiPolicyByKey follows the same contract', async () => {
    const db = getDb();
    const key = `pii-${suffix()}`;
    await db.createPiiPolicy(piiPolicy('proj-a', key));
    await db.createPiiPolicy(piiPolicy('proj-b', key));
    expect(await db.findPiiPolicyByKey(key, null)).toBeNull();

    const wide = await db.createPiiPolicy(piiPolicy(undefined, key));
    const found = await db.findPiiPolicyByKey(key, null);
    expect(idOf(found)).toBe(idOf(wide));
    expect(found?.projectId ?? null).toBeNull();
    expect(idOf(await db.findPiiPolicyByKey(key, 'proj-a'))).not.toBe(idOf(wide));
  });
});
