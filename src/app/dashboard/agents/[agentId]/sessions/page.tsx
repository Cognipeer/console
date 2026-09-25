import { redirect } from 'next/navigation';

/**
 * The session list lives on the agent page's Sessions tab. This route exists
 * because the breadcrumb on a session page links every path segment, and
 * `/dashboard/agents/:id/sessions` would otherwise be a 404.
 */
export default async function AgentSessionsRedirect({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  redirect(`/dashboard/agents/${encodeURIComponent(agentId)}?tab=sessions`);
}
