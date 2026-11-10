'use client';

import { useParams } from 'next/navigation';
import McpDetailView from '@/components/mcp/McpDetailView';

/** An MCP server of the hub. The same screen opens in a drawer for a server an agent owns (`AgentOwnedMcpServers`). */
export default function McpDetailPage() {
  const params = useParams<{ id: string }>()!;
  return <McpDetailView serverId={params.id} />;
}
