'use client';

import { IconActivity } from '@tabler/icons-react';
import { ModuleQuotaSection } from '@/components/quota';

interface TracingQuotaSectionProps {
  defaultCollapsed?: boolean;
  compact?: boolean;
  resourceOptions?: { value: string; label: string }[];
}

export function TracingQuotaSection({ 
  defaultCollapsed = true, 
  compact = false,
  resourceOptions = [],
}: TracingQuotaSectionProps) {
  return (
    <ModuleQuotaSection
      domain="tracing"
      icon={<IconActivity size={20} />}
      allowedScopes={['tenant', 'user', 'token', 'resource']}
      defaultCollapsed={defaultCollapsed}
      compact={compact}
      resourceOptions={resourceOptions}
    />
  );
}
