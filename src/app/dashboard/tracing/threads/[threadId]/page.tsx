'use client';

import { use } from 'react';
import ThreadDetailView from '@/components/tracing/ThreadDetailView';

export default function ThreadDetailPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = use(params);
  return <ThreadDetailView threadId={threadId} />;
}
