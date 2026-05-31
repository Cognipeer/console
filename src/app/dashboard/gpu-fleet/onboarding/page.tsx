'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Divider,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowRight,
  IconCircleCheck,
  IconCopy,
  IconRefresh,
  IconRocket,
  IconShieldLock,
  IconX,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { GpuFleetApi } from '../_lib/api';
import { formatRelative, statusColor } from '../_lib/format';
import type { FleetSettingsView, HostView, InstallSnippetView } from '../_lib/types';

const PLATFORMS = [
  { value: 'linux-x64', label: 'Linux · x86_64' },
  { value: 'linux-arm64', label: 'Linux · arm64' },
  { value: 'darwin-arm64', label: 'macOS · Apple Silicon' },
  { value: 'darwin-x64', label: 'macOS · Intel' },
];

export default function GpuFleetOnboardingPage() {
  const [settings, setSettings] = useState<FleetSettingsView | null>(null);
  const [pending, setPending] = useState<HostView[]>([]);
  const [snippet, setSnippet] = useState<InstallSnippetView | null>(null);
  const [platform, setPlatform] = useState<string>('linux-x64');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        GpuFleetApi.getSettings<FleetSettingsView>(),
        GpuFleetApi.listPendingClaim<{ hosts: HostView[] }>(),
      ]);
      setSettings(s);
      setPending(p.hosts);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Failed to refresh',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(id);
  }, [refresh]);

  const generate = async (rotateToken: boolean) => {
    setBusy(true);
    try {
      const result = await GpuFleetApi.renderInstallSnippet<InstallSnippetView>({
        platform,
        rotateToken,
      });
      setSnippet(result);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Snippet failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · GPU Fleet · Onboarding"
        title="Connect GPU machines"
        subtitle="Run the one-liner on each host. They will appear below in the Pending Claim list; promote them when ready."
      />

      <Card withBorder mb="md">
        <Stack gap="md">
          <Group justify="space-between">
            <Title order={5}>Step 1 — Generate install command</Title>
            <Group gap="xs">
              <Select
                data={PLATFORMS}
                value={platform}
                onChange={(v) => setPlatform(v ?? 'linux-x64')}
                size="xs"
                w={220}
              />
              <Button
                size="xs"
                leftSection={<IconRefresh size={14} />}
                onClick={() => void generate(true)}
                loading={busy}
              >
                {settings?.fleetTokenSet ? 'Generate new command' : 'Generate'}
              </Button>
            </Group>
          </Group>
          {!settings?.fleetTokenSet ? (
            <Alert color="blue">
              No fleet token exists yet for this tenant. Click <strong>Generate</strong> to mint one — the token is
              shown only once, but you can come back and click again to mint a fresh one any time.
            </Alert>
          ) : (
            <Text size="sm" c="dimmed">
              A fleet token already exists (last rotated {formatRelative(settings.fleetTokenRotatedAt)}). Since the
              raw value is never stored, clicking <strong>Generate new command</strong> rotates to a fresh token and
              shows it once. Already-paired agents are not affected — they use their own agent tokens.
            </Text>
          )}

          {snippet ? (
            <Stack gap="xs">
              <Alert color="yellow" icon={<IconShieldLock size={16} />}>
                <strong>This token is shown ONCE.</strong> Copy it now — only the hash is stored in the database.
                Losing it is fine — click Rotate to mint a fresh one.
              </Alert>
              <Alert color="teal" icon={<IconArrowRight size={16} />}>
                <Text size="sm">
                  <strong>Next step:</strong> run the command on the target host.
                  On Linux the snippet starts with <Code>sudo bash</Code>;
                  on macOS it runs without sudo (per-user install).
                  The host will show up in the &quot;Pending claim&quot; list below within 5-10 seconds
                  once the agent connects.
                </Text>
              </Alert>
              <Textarea
                value={snippet.curl}
                readOnly
                autosize
                minRows={4}
                styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
              />
              <Group justify="flex-end" gap="xs">
                <CopyButton value={snippet.curl}>
                  {({ copied, copy }) => (
                    <Button
                      size="xs"
                      variant={copied ? 'filled' : 'light'}
                      color={copied ? 'teal' : 'blue'}
                      leftSection={<IconCopy size={14} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied' : 'Copy command'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
              <Divider my="xs" />
              <Group gap="md">
                <Detail label="Fleet token" value={snippet.fleetToken} mono />
                <Detail label="Asset URL" value={snippet.assetUrl} mono />
              </Group>
            </Stack>
          ) : null}
        </Stack>
      </Card>

      <Card withBorder>
        <Group justify="space-between" mb="md">
          <Title order={5}>Step 2 — Claim hosts</Title>
          <Badge color={pending.length > 0 ? 'blue' : 'gray'} variant="light">
            {pending.length} pending
          </Badge>
        </Group>

        {pending.length === 0 ? (
          <Alert color="gray" variant="light">
            <Text size="sm">
              No hosts waiting to be claimed yet. Run the install command from <strong>Step 1</strong> on a GPU host —
              it should show up here. This page <strong>polls every 5 seconds</strong>.
            </Text>
            <Text size="xs" c="dimmed" mt={6}>
              Ran the command but nothing appeared? Tail the agent logs:
              <Code>journalctl -u cognipeer-gpu-agent -f</Code> on Linux, or
              <Code>tail -F ~/.cognipeer/gpu-agent/logs/agent.err.log</Code> on macOS.
              A failed handshake will print the error there.
            </Text>
          </Alert>
        ) : (
          <Stack gap="sm">
            {pending.map((host) => (
              <PendingHostCard key={host.id} host={host} onChanged={refresh} />
            ))}
          </Stack>
        )}
      </Card>
    </PageContainer>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Text size="xs" style={{ fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>
        {value}
      </Text>
    </Stack>
  );
}

interface PendingHostCardProps {
  host: HostView;
  onChanged: () => void | Promise<void>;
}

function PendingHostCard({ host, onChanged }: PendingHostCardProps) {
  const [name, setName] = useState(host.name);
  const [serviceAddress, setServiceAddress] = useState<string>(
    (host.inventory?.preferredServiceAddress as string | undefined) ?? '',
  );
  const [terminalEnabled, setTerminalEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const inventory = host.inventory ?? {};
  const accelerator = (inventory.accelerator as string | undefined) ?? 'cpu';
  const gpus = (inventory.gpus as Array<{ productName: string; memoryTotalMiB: number }> | undefined) ?? [];
  const toolchain = (inventory.system as { toolchain?: Record<string, string | null> } | undefined)?.toolchain;

  const claim = async () => {
    setBusy(true);
    try {
      await GpuFleetApi.claimPending<{ host: HostView }>(host.id, {
        name: name.trim() || host.name,
        serviceAddress: serviceAddress.trim() || null,
        terminalEnabled,
      });
      notifications.show({ color: 'teal', title: 'Host claimed', message: name });
      void onChanged();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Claim failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await GpuFleetApi.rejectPending(host.id);
      notifications.show({ color: 'gray', title: 'Host rejected', message: host.name });
      void onChanged();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Reject failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder padding="md">
      <Group justify="space-between" align="flex-start" mb="sm">
        <Stack gap={4}>
          <Group gap="xs">
            <Badge color={statusColor(host.status)} variant="dot">{host.status}</Badge>
            <Text fw={600}>{host.name}</Text>
            <Text size="xs" c="dimmed">agent v{host.agentVersion ?? '?'}</Text>
          </Group>
          <Text size="xs" c="dimmed">
            <Code>{accelerator}</Code> · {gpus.length || 'no'} GPU · heartbeat {formatRelative(host.lastHeartbeatAt)}
          </Text>
          {gpus.length > 0 ? (
            <Text size="xs" c="dimmed">
              GPUs: {gpus.map((g) => `${g.productName} (${Math.round(g.memoryTotalMiB / 1024)} GiB)`).join(', ')}
            </Text>
          ) : null}
        </Stack>
        <Group gap="xs">
          <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={reject} loading={busy}>
            Reject
          </Button>
          <Button size="xs" leftSection={<IconCircleCheck size={14} />} onClick={claim} loading={busy}>
            Claim
          </Button>
        </Group>
      </Group>

      <Group grow gap="sm" mb="sm">
        <TextInput
          label="Display name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          size="xs"
        />
        <TextInput
          label="Service address (override)"
          placeholder={serviceAddress || 'auto'}
          value={serviceAddress}
          onChange={(e) => setServiceAddress(e.currentTarget.value)}
          size="xs"
        />
        <Stack gap={2} justify="flex-end">
          <Text size="xs" c="dimmed">Terminal access</Text>
          <Switch
            size="sm"
            checked={terminalEnabled}
            onChange={(e) => setTerminalEnabled(e.currentTarget.checked)}
            label={terminalEnabled ? 'on' : 'off'}
          />
        </Stack>
      </Group>

      {toolchain ? (
        <Group gap="sm">
          <Toolchain ok={Boolean(toolchain.nvidiaDriver)} label={`driver ${toolchain.nvidiaDriver ?? '—'}`} />
          <Toolchain ok={Boolean(toolchain.cuda)} label={`cuda ${toolchain.cuda ?? '—'}`} />
          <Toolchain ok={Boolean(toolchain.docker)} label={`docker ${toolchain.docker ?? '—'}`} />
          <Toolchain
            ok={Boolean(toolchain.nvidiaContainerToolkit)}
            label={`nvidia-ctk ${toolchain.nvidiaContainerToolkit ?? '—'}`}
          />
        </Group>
      ) : null}
    </Card>
  );
}

function Toolchain({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge color={ok ? 'teal' : 'gray'} variant={ok ? 'light' : 'outline'} leftSection={ok ? <IconRocket size={10} /> : undefined}>
      {label}
    </Badge>
  );
}
