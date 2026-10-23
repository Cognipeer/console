'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import LoadingState from '@/components/common/LoadingState';

export default function Home() {
  const router = useRouter();
  // Every outcome of the old auth probe ended at the overview (an unauthenticated visit is
  // sent on to /login by the middleware), so go there once, replacing "/" in the history
  // so that Back does not bounce through this redirect again.
  useEffect(() => {
    router.replace('/dashboard/overview');
  }, [router]);

  return (
    <LoadingState minHeight="100vh" size="lg" label="Redirecting to overview" />
  );
}
