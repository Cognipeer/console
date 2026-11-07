/**
 * Storage at the upload sites: the refusal is 413 `storage_quota_exceeded` on the Files routes (`describeFileError`),
 * shadow mode allows and records, off mode never reads the stored bytes, and the Files UI words the code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  plan: { tenantId: 't1', mode: 'on', limits: null } as any,
  db: { sumFileRecordBytes: vi.fn(async () => 0) },
  events: [] as any[],
}));

vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
vi.mock('@/lib/database', () => ({ getDatabase: async () => h.db }));
vi.mock('@/lib/limits/events', () => ({
  outcomeEventFor: (d: unknown, c: unknown) => h.events.push({ d, c }),
  recordLimitEvent: vi.fn(),
}));

import { assertStorageStock, clearStorageCacheForTests, noteStoredBytes } from '@/lib/limits/storage';
import { describeFileError } from '@/server/api/fileHttp';
import { FILES_ERROR_CODE_KEYS, filesErrorMessage } from '@/components/files/shared/filesErrors';
import { FilesApiError } from '@/components/files/filesApi';
import { filesCommonEn } from '@/lib/i18n/messages/filesCommon.en';
import { filesCommonTr } from '@/lib/i18n/messages/filesCommon.tr';

function setPlan(mode: 'on' | 'shadow' | 'off', storageBytes?: number) {
  h.plan = {
    tenantId: 't1',
    mode,
    limits: { concurrency: {}, monthly: {}, seats: {}, credits: {}, ...(storageBytes === undefined ? {} : { storageBytes }) },
  };
}

beforeEach(() => {
  clearStorageCacheForTests();
  h.events.length = 0;
  h.db.sumFileRecordBytes.mockReset();
  h.db.sumFileRecordBytes.mockResolvedValue(900);
});

async function refusal(incomingBytes = 200): Promise<unknown> {
  try {
    await assertStorageStock({ tenantId: 't1', incomingBytes });
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('storage refusal at an upload', () => {
  it('is a 413 storage_quota_exceeded answer on the Files routes (on)', async () => {
    setPlan('on', 1000);
    const error = await refusal();
    expect(error).toMatchObject({ code: 'storage_quota_exceeded', status: 413 });
    const answer = describeFileError(error);
    expect(answer.status).toBe(413);
    expect(answer.unexpected).toBe(false);
    expect(answer.body).toMatchObject({ code: 'storage_quota_exceeded', kind: 'storage', limit: 1000, used: 900 });
    expect(typeof answer.body.error).toBe('string');
  });

  it('allows and records in shadow mode', async () => {
    setPlan('shadow', 1000);
    expect(await refusal()).toBeUndefined();
    expect(h.events).toHaveLength(1);
  });

  it('never reads the stored bytes when off or without a limit', async () => {
    setPlan('off', 1000);
    expect(await refusal()).toBeUndefined();
    setPlan('on');
    expect(await refusal()).toBeUndefined();
    expect(h.db.sumFileRecordBytes).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  it('counts a stored upload straight away (noteStoredBytes) so the next check sees it', async () => {
    setPlan('on', 1000);
    // 900 used, 100 incoming fits; after noting 100 the same 100 no longer does.
    expect(await refusal(100)).toBeUndefined();
    noteStoredBytes('t1', 100);
    expect(await refusal(100)).toMatchObject({ code: 'storage_quota_exceeded' });
    expect(h.db.sumFileRecordBytes).toHaveBeenCalledTimes(1);
  });

  it('leaves other file errors alone', () => {
    expect(describeFileError(new Error('boom')).status).toBe(500);
  });
});

describe('Files UI wording of storage_quota_exceeded', () => {
  it('maps to a translated message in both languages', () => {
    expect(FILES_ERROR_CODE_KEYS.storage_quota_exceeded).toBe('errors.storageQuotaExceeded');
    expect(filesCommonEn.errors.storageQuotaExceeded).toBeTruthy();
    expect(filesCommonTr.errors.storageQuotaExceeded).toBeTruthy();
    const error = FilesApiError.fromBody(413, { error: 'Storage is full', code: 'storage_quota_exceeded' });
    expect(filesErrorMessage(error, (key) => key)).toBe('errors.storageQuotaExceeded');
  });
});
