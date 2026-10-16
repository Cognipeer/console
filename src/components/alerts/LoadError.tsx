'use client';

import { Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

export interface LoadErrorProps {
  message: string;
  onRetry?: () => void;
  /** Render without the card chrome (inside an existing card). */
  bare?: boolean;
}

/** A failed load with a retry button; used by every alerts screen. */
export default function LoadError({ message, onRetry, bare }: LoadErrorProps) {
  const t = useTranslations('alerts');
  return (
    <div role="alert" className={bare ? undefined : 'ds-card ds-card-pad'} style={{ display: 'flex', alignItems: 'center' }}>
      <Group gap="sm" wrap="wrap">
        <IconAlertTriangle size={16} stroke={1.7} color="var(--ds-err)" />
        <Text size="sm">{message}</Text>
        {onRetry ? (
          <Button variant="default" size="xs" leftSection={<IconRefresh size={12} stroke={1.7} />} onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
      </Group>
    </div>
  );
}
