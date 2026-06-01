'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Radio,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconRefresh, IconShieldLock } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { GpuFleetApi } from '../_lib/api';
import { formatBytes, formatRelative } from '../_lib/format';
import type { FleetSettingsView } from '../_lib/types';

export default function GpuFleetSettingsPage() {
  const [settings, setSettings] = useState<FleetSettingsView | null>(null);
  const [mode, setMode] = useState<'console-served' | 'external-url'>('console-served');
  const [externalTemplate, setExternalTemplate] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await GpuFleetApi.getSettings<FleetSettingsView>();
      setSettings(s);
      setMode(s.agentDistributionMode);
      setExternalTemplate(s.agentDistributionExternalUrlTemplate ?? '');
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to load settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDistribution = async () => {
    setBusy(true);
    try {
      await GpuFleetApi.updateAgentDistribution({
        mode,
        externalUrlTemplate: mode === 'external-url' ? externalTemplate.trim() : null,
      });
      notifications.show({ color: 'teal', title: 'Saved', message: 'Distribution settings updated' });
      void load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Save failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  const rotateToken = async () => {
    setBusy(true);
    try {
      const result = await GpuFleetApi.rotateFleetToken<{ token: string; rotatedAt: string }>();
      setRevealedToken(result.token);
      notifications.show({ color: 'teal', title: 'Token rotated', message: 'Copy it now — only the hash is stored.' });
      void load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Rotate failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · GPU Fleet · Settings"
        title="Fleet settings"
        subtitle="Where the agent binary comes from, who can self-register, terminal session caps."
      />

      <Card withBorder mb="md">
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={5}>Fleet registration token</Title>
            <Badge color={settings?.fleetTokenSet ? 'teal' : 'gray'} variant="light">
              {settings?.fleetTokenSet ? 'set' : 'not set'}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            A tenant-wide shared token. The same token can self-register N agents — they all land
            in <Code>pending_claim</Code> state and an admin promotes them. Last rotated: {formatRelative(settings?.fleetTokenRotatedAt)}.
          </Text>
          <Text size="xs" c="dimmed">
            <strong>Security:</strong> if the token leaks, anyone with network access can register a host in
            pending_claim — they cannot receive commands until you claim them. When in doubt, <strong>Rotate</strong>.
            The old token stops working immediately; already-paired agents keep running with their own
            agent tokens.
          </Text>
          <Group>
            <Button leftSection={<IconRefresh size={14} />} onClick={rotateToken} loading={busy}>
              Rotate fleet token
            </Button>
          </Group>
          {revealedToken ? (
            <Alert color="yellow" icon={<IconShieldLock size={16} />}>
              <Stack gap={4}>
                <Text size="sm">Copy this now — we only store the hash:</Text>
                <Code block>{revealedToken}</Code>
              </Stack>
            </Alert>
          ) : null}
        </Stack>
      </Card>

      <Card withBorder mb="md">
        <Stack gap="sm">
          <Title order={5}>Agent distribution</Title>
          <Text size="sm" c="dimmed">
            Where install.sh fetches the agent tarball from. Console-served is the default and works without external
            dependencies. Use external URL when shipping behind a CDN or blob storage.
          </Text>
          <Radio.Group value={mode} onChange={(v) => setMode(v as 'console-served' | 'external-url')}>
            <Stack gap="xs">
              <Radio value="console-served" label="Console-served (serve from the console filesystem)" />
              <Radio value="external-url" label="External URL (Azure Blob, S3, custom CDN…)" />
            </Stack>
          </Radio.Group>
          {mode === 'external-url' ? (
            <TextInput
              label="External URL template"
              placeholder="https://my-blob.example.com/gpu-agent/{{platform}}.tar.gz"
              description="Use {{platform}} as the placeholder. Each host's request inlines its OS+arch."
              value={externalTemplate}
              onChange={(e) => setExternalTemplate(e.currentTarget.value)}
            />
          ) : null}
          <Group>
            <Button onClick={saveDistribution} loading={busy}>
              Save
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card withBorder>
        <Stack gap="sm">
          <Title order={5}>Available bundles on disk</Title>
          {settings && settings.availableBundles.length > 0 ? (
            settings.availableBundles.map((b) => (
              <Group key={b.platform} justify="space-between">
                <Group gap="xs">
                  <Badge variant="outline">{b.platform}</Badge>
                  <Text size="xs" c="dimmed">{formatBytes(b.sizeBytes)}</Text>
                </Group>
                <Text size="xs" c="dimmed">
                  built {formatRelative(b.mtime)}
                </Text>
              </Group>
            ))
          ) : (
            <Text size="sm" c="dimmed">
              No bundles staged. Drop tarballs under <Code>data/agent-bundles/&lt;platform&gt;/cognipeer-gpu-agent-latest.tar.gz</Code>.
            </Text>
          )}
        </Stack>
      </Card>
    </PageContainer>
  );
}
