'use client';

import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import WebhookManagement from '@/components/settings/WebhookManagement';
import { useTranslations } from '@/lib/i18n';

/**
 * Outgoing webhooks. The endpoints belong to the project (or the tenant), not to
 * one agent, but what they announce — sessions, approvals, budgets, runs,
 * schedules — is the agents' activity, so the page lives in the Agents menu.
 */
export default function AgentWebhooksPage() {
  const t = useTranslations('navigation');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · Agents · Webhooks"
        title={t('webhooks')}
        subtitle={t('webhooksDescription')}
      />
      <WebhookManagement />
    </PageContainer>
  );
}
