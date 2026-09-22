'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import AgentSessionView from '@/components/agents/session/AgentSessionView';
import LoadingState from '@/components/common/LoadingState';

export default function DashboardAgentSessionPage() {
  const params = useParams();
  const agentId = params.agentId as string;
  const sessionId = params.sessionId as string;
  // The view reads `?version=` (the version StartSessionModal pinned), and
  // useSearchParams needs a boundary to suspend against while prerendering.
  return (
    <Suspense fallback={<LoadingState label="Loading session..." minHeight={400} />}>
      <AgentSessionView agentId={agentId} sessionId={sessionId} />
    </Suspense>
  );
}
