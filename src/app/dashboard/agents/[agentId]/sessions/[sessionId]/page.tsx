'use client';

import { useParams } from 'next/navigation';
import AgentSessionView from '@/components/agents/session/AgentSessionView';

export default function DashboardAgentSessionPage() {
  const params = useParams();
  const agentId = params.agentId as string;
  const sessionId = params.sessionId as string;
  return <AgentSessionView agentId={agentId} sessionId={sessionId} />;
}
