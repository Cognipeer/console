/**
 * usage rollup buffer → flush → usage_daily end-to-end (SQLite-backed).
 *
 * recordUsageEvent resolves attribution from the request-context ALS and
 * buffers increments; flushUsageRollup upserts them per tenant. This test
 * drives the real chain with a temp SQLite provider behind getDatabase().
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';

let provider: SQLiteProvider;

vi.mock('@/lib/database', async () => {
  const actual = await vi.importActual<typeof import('@/lib/database')>('@/lib/database');
  return {
    ...actual,
    getDatabase: async () => provider,
  };
});

import { runWithRequestContext } from '@/lib/core/requestContext';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { flushUsageRollup } from '@/lib/services/usage/usageRollup';

const TENANT_DB = 'tenant_rollup_test';
let tmpDir = '';

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'usage-rollup-'));
  provider = new SQLiteProvider(tmpDir, 'rollup_main');
  await provider.connect();
  await provider.createTenant({
    companyName: 'Rollup Co',
    slug: 'rollup',
    dbName: TENANT_DB,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  await provider.switchToTenant(TENANT_DB);
});

afterAll(async () => {
  await provider.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('usage rollup end-to-end', () => {
  it('buffers events with ALS attribution and flushes them into usage_daily', async () => {
    runWithRequestContext(
      {
        requestId: 'req-1',
        tenantId: 't-1',
        userId: 'user-7',
        apiTokenId: 'tok-7',
        actorType: 'api_token',
        source: 'api',
        projectId: 'proj-7',
      },
      () => {
        for (let i = 0; i < 3; i++) {
          const attribution = recordUsageEvent({
            tenantDbName: TENANT_DB,
            tenantId: 't-1',
            service: 'models',
            refKey: 'gpt-4o',
            status: i === 2 ? 'error' : 'success',
            latencyMs: 100,
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            costUsd: 0.01,
            units: { toolCalls: 1 },
          });
          expect(attribution.userId).toBe('user-7');
          expect(attribution.apiTokenId).toBe('tok-7');
          expect(attribution.actorType).toBe('api_token');
        }
      },
    );

    await flushUsageRollup();

    await provider.switchToTenant(TENANT_DB);
    const rows = await provider.listUsageDaily({ userId: 'user-7' });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.apiTokenId).toBe('tok-7');
    expect(row.projectId).toBe('proj-7');
    expect(row.source).toBe('api');
    expect(row.service).toBe('models');
    expect(row.refKey).toBe('gpt-4o');
    expect(row.requests).toBe(3);
    expect(row.errors).toBe(1);
    expect(row.totalTokens).toBe(45);
    expect(row.costUsd).toBeCloseTo(0.03, 10);
    expect(row.latencyMsSum).toBe(300);
    expect(row.latencyCount).toBe(3);
    expect(row.units).toMatchObject({ toolCalls: 3 });
    expect(row.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it('attributes system work when no request context is open', async () => {
    recordUsageEvent({
      tenantDbName: TENANT_DB,
      tenantId: 't-1',
      projectId: 'proj-7',
      service: 'sandbox',
      refKey: 'tmpl-1',
      status: 'success',
      units: { runtimeMinutes: 12 },
      attribution: { userId: 'owner-1', actorType: 'system' },
    });

    await flushUsageRollup();

    await provider.switchToTenant(TENANT_DB);
    const rows = await provider.listUsageDaily({ service: 'sandbox' });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('owner-1');
    expect(rows[0].apiTokenId).toBe('');
    expect(rows[0].source).toBe('system');
    expect(rows[0].units).toMatchObject({ runtimeMinutes: 12 });
  });
});
