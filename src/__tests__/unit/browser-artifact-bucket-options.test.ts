/**
 * The browser forms' "Artifact bucket" picker: the project's buckets by name,
 * a disabled one listed but not choosable, and a stored key that no longer
 * matches a bucket kept visible instead of silently emptying the field.
 */

import { describe, expect, it } from 'vitest';
import { artifactBucketOptions } from '@/components/browser/artifactBucket';

const buckets = [
  { key: 'shots', name: 'Screenshots', status: 'active' },
  { key: 'old', name: 'Old exports', status: 'disabled' },
];

describe('artifactBucketOptions', () => {
  it('lists the buckets by name, a disabled one greyed out', () => {
    expect(artifactBucketOptions(buckets, '')).toEqual([
      { value: 'shots', label: 'Screenshots', disabled: false },
      { value: 'old', label: 'Old exports (disabled)', disabled: true },
    ]);
  });

  it('keeps a disabled bucket choosable when it is the stored one', () => {
    expect(artifactBucketOptions(buckets, 'old')[1]).toEqual({ value: 'old', label: 'Old exports (disabled)', disabled: false });
  });

  it('shows a stored key the project no longer has as not found, first', () => {
    expect(artifactBucketOptions(buckets, 'gone')[0]).toEqual({ value: 'gone', label: 'gone (not found)', disabled: false });
  });

  it('shows the stored key as it is while the list is loading', () => {
    expect(artifactBucketOptions(null, 'shots')).toEqual([{ value: 'shots', label: 'shots', disabled: false }]);
    expect(artifactBucketOptions(null, '')).toEqual([]);
  });

  it('treats a row without a status as usable', () => {
    expect(artifactBucketOptions([{ key: 'a', name: 'A' }], '')).toEqual([{ value: 'a', label: 'A', disabled: false }]);
  });
});
