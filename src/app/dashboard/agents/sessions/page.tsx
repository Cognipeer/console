'use client';

import { Suspense } from 'react';
import AgentSessionsPage from '@/components/agents/sessions/AgentSessionsPage';
import LoadingState from '@/components/common/LoadingState';

export default function DashboardAgentSessionsPage() {
  // The page reads `?view=`, and useSearchParams needs a boundary to suspend
  // against while prerendering.
  return (
    <Suspense fallback={<LoadingState label="Loading sessions..." minHeight={400} />}>
      <AgentSessionsPage />
    </Suspense>
  );
}
