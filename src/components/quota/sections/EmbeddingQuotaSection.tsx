'use client';

import { IconVectorBezier2 } from '@tabler/icons-react';
import { ModuleQuotaSection } from '@/components/quota';

interface EmbeddingQuotaSectionProps {
  defaultCollapsed?: boolean;
  compact?: boolean;
  resourceOptions?: { value: string; label: string }[];
}

export function EmbeddingQuotaSection({ 
  defaultCollapsed = true, 
  compact = false,
  resourceOptions = [],
}: EmbeddingQuotaSectionProps) {
  return (
    <ModuleQuotaSection
      domain="embedding"
      icon={<IconVectorBezier2 size={20} />}
      allowedScopes={['tenant', 'user', 'token', 'resource']}
      defaultCollapsed={defaultCollapsed}
      compact={compact}
      resourceOptions={resourceOptions}
    />
  );
}
