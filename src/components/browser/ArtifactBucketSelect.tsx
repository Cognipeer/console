'use client';

/**
 * Where a browser's screenshots and PDFs land, chosen from the project's file
 * buckets instead of typed as a key. Empty passes the choice down the line:
 * the browser's own bucket for a session, the platform default for a browser.
 */

import { useMemo } from 'react';
import { Loader, Select } from '@mantine/core';
import { errorMessage } from '@/lib/api/client';
import { useArtifactBuckets } from '@/lib/api/queries/browser';
import { artifactBucketOptions, type ArtifactBucketRow } from './artifactBucket';

interface ArtifactBucketSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** What an empty field means here. */
  emptyLabel: string;
  /** Off where clearing would not be saved (the browser's edit form keeps the stored bucket when sent nothing). */
  clearable?: boolean;
}

export default function ArtifactBucketSelect({ value, onChange, emptyLabel, clearable = true }: ArtifactBucketSelectProps) {
  const bucketsQuery = useArtifactBuckets();
  // Until the read answers there is no list (null); a failed read leaves an empty one and says why.
  const bucketRows = bucketsQuery.data;
  const buckets = useMemo<ArtifactBucketRow[] | null>(
    () => (bucketsQuery.isPending ? null : (bucketRows ?? [])),
    [bucketsQuery.isPending, bucketRows],
  );
  const loadError = bucketsQuery.isError ? errorMessage(bucketsQuery.error, 'Could not load the file buckets') : null;

  const options = useMemo(() => artifactBucketOptions(buckets, value), [buckets, value]);
  const empty = buckets !== null && buckets.length === 0 && !loadError;

  return (
    <Select
      data={options}
      value={value || null}
      onChange={(next) => onChange(next ?? '')}
      placeholder={buckets === null ? 'Loading buckets…' : empty ? 'No buckets yet — create one under Files' : emptyLabel}
      nothingFoundMessage="No bucket matches"
      searchable
      clearable={clearable}
      rightSection={buckets === null ? <Loader size={14} /> : undefined}
      error={loadError}
    />
  );
}
