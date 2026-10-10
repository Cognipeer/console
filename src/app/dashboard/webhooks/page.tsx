import { redirect } from 'next/navigation';

// Webhooks moved into the Agents menu (/dashboard/agents/webhooks); old links and bookmarks keep working.
export default function WebhooksRedirectPage() {
  redirect('/dashboard/agents/webhooks');
}
