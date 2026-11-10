/**
 * The pieces of the vector and files screens that know about platform providers: no storage location, no test to run,
 * and the same keys in both languages.
 */
import { describe, expect, it } from 'vitest';
import { storagePreview } from '@/components/files/create/bucketForm';
import { describeProviderHealth } from '@/lib/services/files/fileReads';
import { platformStorageEn } from '@/lib/i18n/messages/platformStorage.en';
import { platformStorageTr } from '@/lib/i18n/messages/platformStorage.tr';

const keysOf = (value: object, prefix = ''): string[] => Object.entries(value).flatMap(([key, item]) => (
  typeof item === 'object' && item !== null ? keysOf(item, `${prefix}${key}.`) : [`${prefix}${key}`]
));

describe('files: a platform provider', () => {
  it('shows no storage location in the create form', () => {
    const base = { driver: 'platform-virtual', driverCapabilities: undefined, storageLocationBase: '/srv/files/' };
    expect(storagePreview({ ...base, platform: true }, 'docs', 'file')).toEqual({ kind: 'none' });
    expect(storagePreview({ ...base, platform: false }, 'docs', 'file')).toMatchObject({ kind: 'path' });
  });

  it('needs no connection test: it is never "untested"', () => {
    const view = { status: 'active' as const, lastTest: undefined, driverCapabilities: undefined };
    expect(describeProviderHealth({ ...view, platform: true })).toEqual({ state: 'builtin' });
    expect(describeProviderHealth({ ...view, platform: false })).toMatchObject({ state: 'untested' });
    expect(describeProviderHealth({ ...view, status: 'disabled', platform: true })).toMatchObject({ state: 'inactive' });
  });
});

describe('platformStorage messages', () => {
  it('have the same keys in English and Turkish, none empty, and no vendor wording', () => {
    expect(keysOf(platformStorageTr).sort()).toEqual(keysOf(platformStorageEn).sort());
    for (const text of [...Object.values(platformStorageEn.vector), ...Object.values(platformStorageEn.files), platformStorageEn.note, platformStorageEn.badge]) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify([platformStorageEn, platformStorageTr])).not.toMatch(/cognipeer|aws|s3|sqlite|disk/i);
  });
});
