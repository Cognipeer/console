'use client';

import { IconFiles } from '@tabler/icons-react';
import { ModuleQuotaSection } from '@/components/quota';

interface FileQuotaSectionProps {
  defaultCollapsed?: boolean;
  compact?: boolean;
  resourceOptions?: { value: string; label: string }[];
}

export function FileQuotaSection({ 
  defaultCollapsed = true, 
  compact = false,
  resourceOptions = [],
}: FileQuotaSectionProps) {
  return (
    <ModuleQuotaSection
      domain="file"
      icon={<IconFiles size={20} />}
      allowedScopes={['tenant', 'user', 'token', 'resource']}
      defaultCollapsed={defaultCollapsed}
      compact={compact}
      resourceOptions={resourceOptions}
    />
  );
}
