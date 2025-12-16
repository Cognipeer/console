'use client';

import { Stack, Text, SimpleGrid, Skeleton, Alert, Group, Button } from '@mantine/core';
import { IconAlertCircle, IconPlus } from '@tabler/icons-react';
import type { IQuotaPolicy } from '@/lib/database/provider.interface';
import { QuotaPolicyCard } from './QuotaPolicyCard';
import { useTranslations } from '@/lib/i18n';

interface QuotaPolicyListProps {
  policies: IQuotaPolicy[];
  loading?: boolean;
  error?: string | null;
  onEdit?: (policy: IQuotaPolicy) => void;
  onDelete?: (policy: IQuotaPolicy) => void;
  onAdd?: () => void;
  showDomain?: boolean;
  compact?: boolean;
  emptyMessage?: string;
  addButtonLabel?: string;
  columns?: number;
}

export function QuotaPolicyList({
  policies,
  loading = false,
  error = null,
  onEdit,
  onDelete,
  onAdd,
  showDomain = true,
  compact = false,
  emptyMessage,
  addButtonLabel,
  columns = 2,
}: QuotaPolicyListProps) {
  const t = useTranslations('settings.quotaSection');
  
  const displayEmptyMessage = emptyMessage || t('emptyMessage', { domain: '' });
  const displayAddButtonLabel = addButtonLabel || t('addPolicy');

  if (loading) {
    return (
      <SimpleGrid cols={{ base: 1, sm: columns }}>
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} height={compact ? 60 : 200} radius="md" />
        ))}
      </SimpleGrid>
    );
  }

  if (error) {
    return (
      <Alert icon={<IconAlertCircle size={16} />} title={t('error')} color="red">
        {error}
      </Alert>
    );
  }

  if (policies.length === 0) {
    return (
      <Stack align="center" gap="md" py="xl">
        <Text c="dimmed" ta="center">
          {displayEmptyMessage}
        </Text>
        {onAdd && (
          <Button leftSection={<IconPlus size={16} />} variant="light" onClick={onAdd}>
            {displayAddButtonLabel}
          </Button>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      {onAdd && (
        <Group justify="flex-end">
          <Button leftSection={<IconPlus size={16} />} size="sm" onClick={onAdd}>
            {displayAddButtonLabel}
          </Button>
        </Group>
      )}
      <SimpleGrid cols={{ base: 1, sm: columns }}>
        {policies.map((policy) => (
          <QuotaPolicyCard
            key={String(policy._id)}
            policy={policy}
            onEdit={onEdit}
            onDelete={onDelete}
            showDomain={showDomain}
            compact={compact}
          />
        ))}
      </SimpleGrid>
    </Stack>
  );
}
