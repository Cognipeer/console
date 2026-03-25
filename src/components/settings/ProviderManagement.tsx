'use client';

import { useMemo, useState } from 'react';
import { Stack, Title, Text, Grid, Badge, Group } from '@mantine/core';
import SectionCard from '@/components/common/SectionCard';
import type { VectorProviderView } from '@/lib/services/vector';
import ProviderManager from '@/components/providers/ProviderManager';
import VectorIndexManager from '@/components/vector/VectorIndexManager';
import { useTranslations } from '@/lib/i18n';

export default function ProviderManagement() {
  const [selectedProvider, setSelectedProvider] = useState<VectorProviderView | null>(null);
  const t = useTranslations('settings');

  const providerSummary = useMemo(() => {
    if (!selectedProvider) return null;
    return (
      <SectionCard title={selectedProvider.label}>
        <Stack gap="xs">
          <Group gap="xs">
            <Badge color={selectedProvider.status === 'active' ? 'green' : 'yellow'}>
              {selectedProvider.status}
            </Badge>
          </Group>
          {selectedProvider.description && (
            <Text size="sm" c="dimmed">
              {selectedProvider.description}
            </Text>
          )}
          <Text size="sm" c="dimmed">
            Driver: {selectedProvider.driver}
          </Text>
          <Text size="sm" c="dimmed">
            Key: {selectedProvider.key}
          </Text>
        </Stack>
      </SectionCard>
    );
  }, [selectedProvider]);

  return (
    <SectionCard
      title={<Title order={3}>{t('providerManagement.title')}</Title>}
      description={
        <Text size="sm" c="dimmed">
          {t('providerManagement.subtitle')}
        </Text>
      }
    >
      <Stack gap="lg">
        <Grid gutter="md">
          <Grid.Col span={{ base: 12, md: 6 }}>
            <ProviderManager
              domain="vector"
              title="Vector Providers"
              description="Enable vector search by connecting an underlying provider."
              onManageProvider={setSelectedProvider}
              manageLabel="Manage indexes"
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <Stack gap="md">
              {providerSummary}
              <VectorIndexManager provider={selectedProvider} />
            </Stack>
          </Grid.Col>
        </Grid>
      </Stack>
    </SectionCard>
  );
}
