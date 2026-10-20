'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import BucketPage from '@/components/files/bucket/BucketPage';

/** A segment of the address as the bucket key it names (a segment that does not decode is used as it is). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A bucket of the Document Store: Files, Settings and API tabs. Everything lives in `components/files/bucket`;
 * this page only reads the key from the address (the tab and the Files tab's folder, search and filters are in the
 * query string, which needs the Suspense boundary).
 */
export default function FileBucketDetailPage() {
  const params = useParams();
  const raw = params?.bucketKey;
  const segment = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  return (
    <Suspense fallback={null}>
      <BucketPage bucketKey={decodeSegment(segment)} />
    </Suspense>
  );
}
