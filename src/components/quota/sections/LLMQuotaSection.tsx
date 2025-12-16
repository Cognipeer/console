'use client';

import { IconMessageChatbot } from '@tabler/icons-react';
import { ModuleQuotaSection } from '@/components/quota';

interface LLMQuotaSectionProps {
  defaultCollapsed?: boolean;
  compact?: boolean;
  resourceOptions?: { value: string; label: string }[];
}

export function LLMQuotaSection({ 
  defaultCollapsed = true, 
  compact = false,
  resourceOptions = [],
}: LLMQuotaSectionProps) {
  return (
    <ModuleQuotaSection
      domain="llm"
      icon={<IconMessageChatbot size={20} />}
      allowedScopes={['tenant', 'user', 'token', 'resource']}
      defaultCollapsed={defaultCollapsed}
      compact={compact}
      resourceOptions={resourceOptions}
    />
  );
}
