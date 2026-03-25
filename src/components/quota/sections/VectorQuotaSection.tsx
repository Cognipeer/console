'use client';

import { IconDatabase } from '@tabler/icons-react';
import { ModuleQuotaSection } from '@/components/quota';

interface VectorQuotaSectionProps {
  defaultCollapsed?: boolean;
  compact?: boolean;
  resourceOptions?: { value: string; label: string }[];
}

export function VectorQuotaSection({ 
  defaultCollapsed = true, 
  compact = false,
  resourceOptions = [],
}: VectorQuotaSectionProps) {
  return (
    <ModuleQuotaSection
      domain="vector"
      icon={<IconDatabase size={20} />}
      allowedScopes={['tenant', 'user', 'token', 'resource', 'provider']}
      defaultCollapsed={defaultCollapsed}
      compact={compact}
      resourceOptions={resourceOptions}
    />
  );
}
