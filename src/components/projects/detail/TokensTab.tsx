'use client';

import TokenManagement from '@/components/settings/TokenManagement';

/**
 * Project API tokens: list, create (the secret is shown once), inspect and
 * revoke. The token manager already speaks the project-scoped endpoints
 * (`/api/projects/:projectId/tokens`), including the per-project token limit error.
 */
export default function TokensTab({ projectId }: { projectId: string }) {
  return <TokenManagement projectId={projectId} />;
}
