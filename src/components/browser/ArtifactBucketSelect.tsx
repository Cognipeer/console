'use client';

/**
 * Where a browser's screenshots and PDFs land, chosen from the project's file
 * buckets instead of typed as a key. Empty passes the choice down the line:
 * the browser's own bucket for a session, the platform default for a browser.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader, Select } from '@mantine/core';
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
  const [buckets, setBuckets] = useState<ArtifactBucketRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/files/buckets', { cache: 'no-store' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Could not load the file buckets');
        if (!cancelled) setBuckets(body.buckets ?? []);
      } catch (err) {
        if (cancelled) return;
        setBuckets([]);
        setLoadError(err instanceof Error ? err.message : 'Could not load the file buckets');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
