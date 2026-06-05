'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCertificate, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

type LicenseResponse = {
  canManage: boolean;
  projectCount: number;
  license: {
    error?: string;
    expiresAt?: string;
    features?: string[];
    licenseId: string;
    licenseType: string;
    limits?: {
      maxProjects?: number;
    };
    source: string;
    status: string;
  };
};

function formatLimit(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value === -1) return 'Unlimited';
  return String(value);
}

export default function LicenseManagement() {
  const [data, setData] = useState<LicenseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const t = useTranslations('license');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');

  const form = useForm({
    initialValues: {
      licenseKey: '',
    },
    validate: {
      licenseKey: (value) =>
        value.trim().length >= 20 ? null : t('form.keyRequired'),
    },
  });

  const fetchLicense = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/license', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || t('errors.load'));
      }
      setData(body);
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('errors.load'),
        title: tNotifications('errorTitle'),
      });
    } finally {
      setLoading(false);
    }
  }, [t, tNotifications]);

  useEffect(() => {
    void fetchLicense();
  }, [fetchLicense]);

  const applyLicense = async (values: typeof form.values) => {
    setSaving(true);
    try {
      const response = await fetch('/api/license', {
        body: JSON.stringify({ licenseKey: values.licenseKey.trim() }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || t('errors.save'));
      }
      notifications.show({
        color: 'green',
        message: t('messages.saved'),
        title: tCommon('success'),
      });
      form.reset();
      await fetchLicense();
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('errors.save'),
        title: tNotifications('errorTitle'),
      });
    } finally {
      setSaving(false);
    }
  };

  const resetLicense = async () => {
    setResetting(true);
    try {
      const response = await fetch('/api/license', { method: 'DELETE' });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || t('errors.reset'));
      }
      notifications.show({
        color: 'green',
        message: t('messages.reset'),
        title: tCommon('success'),
      });
      await fetchLicense();
    } catch (error) {
      notifications.show({
        color: 'red',
        message: error instanceof Error ? error.message : t('errors.reset'),
        title: tNotifications('errorTitle'),
      });
    } finally {
      setResetting(false);
    }
  };

  const license = data?.license;
  const maxProjects = license?.limits?.maxProjects;
  const statusColor = license?.status === 'active' ? 'teal' : license?.status === 'free' ? 'blue' : 'red';

  return (
    <Box p="md">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text size="lg" fw={600}>
              {t('header.title')}
            </Text>
            <Text size="sm" c="dimmed">
              {t('header.subtitle')}
            </Text>
          </div>
          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            loading={loading}
            onClick={fetchLicense}
          >
            {t('actions.refresh')}
          </Button>
        </Group>

        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
          <Paper withBorder radius="md" p="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              {t('fields.status')}
            </Text>
            <Group gap="xs" mt={8}>
              <Badge color={statusColor} variant="light">
                {license?.status ?? '—'}
              </Badge>
              <Text size="sm" fw={600}>
                {license?.licenseType ?? '—'}
              </Text>
            </Group>
          </Paper>
          <Paper withBorder radius="md" p="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              {t('fields.projects')}
            </Text>
            <Text size="xl" fw={700} mt={6}>
              {data?.projectCount ?? 0} / {formatLimit(maxProjects)}
            </Text>
          </Paper>
          <Paper withBorder radius="md" p="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
              {t('fields.expires')}
            </Text>
            <Text size="sm" fw={600} mt={8}>
              {license?.expiresAt ? new Date(license.expiresAt).toLocaleDateString() : t('fields.never')}
            </Text>
          </Paper>
        </SimpleGrid>

        <Paper withBorder radius="md" p="md">
          <Stack gap="xs">
            <Text size="sm" fw={600}>
              {t('fields.licenseId')}
            </Text>
            <Text size="sm" ff="monospace" c="dimmed">
              {license?.licenseId ?? 'FREE'}
            </Text>
            {license?.error ? (
              <Text size="sm" c="red">
                {license.error}
              </Text>
            ) : null}
          </Stack>
        </Paper>

        <Divider />

        {data?.canManage ? (
          <form onSubmit={form.onSubmit(applyLicense)}>
            <Stack gap="sm">
              <Textarea
                autosize
                minRows={5}
                label={t('form.keyLabel')}
                placeholder={t('form.keyPlaceholder')}
                {...form.getInputProps('licenseKey')}
              />
              <Group justify="space-between">
                <Button
                  color="red"
                  variant="light"
                  leftSection={<IconTrash size={16} />}
                  loading={resetting}
                  onClick={resetLicense}
                >
                  {t('actions.reset')}
                </Button>
                <Button
                  type="submit"
                  leftSection={<IconCertificate size={16} />}
                  loading={saving}
                >
                  {t('actions.apply')}
                </Button>
              </Group>
            </Stack>
          </form>
        ) : (
          <Text size="sm" c="dimmed">
            {t('messages.readOnly')}
          </Text>
        )}
      </Stack>
    </Box>
  );
}
