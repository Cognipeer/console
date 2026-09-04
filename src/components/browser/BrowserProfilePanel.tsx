'use client';

/**
 * Signed-in profile + default session settings for one browser.
 *
 * WHY A PROFILE MATTERS: without one, every unattended run has to sign in by
 * pushing credentials through a login form — which means the credentials pass
 * through the action log on every single run, and any change to the login
 * page breaks every flow at once. Uploading a `storageState` once turns that
 * into "already signed in", and a cookie expiry the operator can see coming.
 *
 * The settings below used to be a read-only JSON dump. They are the knobs that
 * decide whether a corporate site works at all (proxy, timezone, downloads),
 * so they are editable here rather than API-only.
 */

import { useRef, useState } from 'react';
import {
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCookie,
  IconDeviceDesktop,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import type { BrowserView, IBrowserSessionConfig } from '@/lib/services/browser';

interface Props {
  browser: BrowserView;
  onUpdated: (browser: BrowserView) => void;
}

/** Days until a date, or null when there is no date. */
function daysUntil(value: unknown): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((date.getTime() - Date.now()) / 86_400_000);
}

export default function BrowserProfilePanel({ browser, onUpdated }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [config, setConfig] = useState<IBrowserSessionConfig>(browser.defaultSessionConfig ?? {});

  const profile = browser.storageStateMeta;
  const expiresInDays = daysUntil(profile?.earliestExpiry);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('That file is not valid JSON. Export it with Playwright’s storageState, or from this console.');
      }

      const res = await fetch(`/api/browser/browsers/${browser.id}/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ storageState: parsed, fileName: file.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      notifications.show({
        color: 'teal',
        title: 'Profile attached',
        message: `${data.profile.cookieCount} cookie(s) across ${data.profile.origins.length} origin(s). New sessions start signed in.`,
      });
      await refresh();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Could not attach profile',
        message: err instanceof Error ? err.message : 'Upload failed',
      });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function refresh() {
    const res = await fetch(`/api/browser/browsers/${browser.id}`, { cache: 'no-store' });
    if (res.ok) onUpdated((await res.json()).browser);
  }

  async function clearProfile() {
    try {
      const res = await fetch(`/api/browser/browsers/${browser.id}/profile`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      notifications.show({
        color: 'teal',
        title: 'Profile removed',
        message: 'New sessions will start signed out.',
      });
      await refresh();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    }
  }

  async function saveConfig() {
    setSavingConfig(true);
    try {
      const res = await fetch(`/api/browser/browsers/${browser.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultSessionConfig: config }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Save failed');
      onUpdated(data.browser);
      notifications.show({
        color: 'teal',
        title: 'Saved',
        message: 'New sessions use these defaults.',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Save failed',
      });
    } finally {
      setSavingConfig(false);
    }
  }

  const set = <K extends keyof IBrowserSessionConfig>(key: K, value: IBrowserSessionConfig[K]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  return (
    <Stack gap="md">
      {/* ── Signed-in profile ───────────────────────────────── */}
      <Paper withBorder p="lg" radius="lg">
        <Stack gap="sm">
          <Group gap="xs">
            <ThemeIcon variant="light" color="grape" radius="md"><IconCookie size={16} /></ThemeIcon>
            <Text fw={600}>Signed-in profile</Text>
            {profile ? <Badge variant="light" color="teal">attached</Badge> : null}
          </Group>

          <Text size="xs" c="dimmed">
            Upload a Playwright <code>storageState</code> file so every new session starts already
            signed in. Sign in once — by hand in a live session, then export it from the session
            menu — instead of replaying credentials through a login form on every run.
            The file is encrypted at rest and is never readable back.
          </Text>

          {profile ? (
            <Stack gap={6}>
              <Group gap="xs" wrap="wrap">
                <Badge variant="light">{profile.cookieCount} cookie(s)</Badge>
                <Badge variant="light">{profile.origins.length} origin(s)</Badge>
                {profile.sourceFileName ? (
                  <Badge variant="light" color="gray">{profile.sourceFileName}</Badge>
                ) : null}
                {expiresInDays !== null ? (
                  <Badge
                    variant="light"
                    color={expiresInDays <= 0 ? 'red' : expiresInDays < 7 ? 'orange' : 'gray'}
                    leftSection={expiresInDays < 7 ? <IconAlertTriangle size={11} /> : undefined}
                  >
                    {expiresInDays <= 0
                      ? 'expired'
                      : `expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}`}
                  </Badge>
                ) : null}
              </Group>
              <Text size="xs" c="dimmed">
                {profile.origins.slice(0, 6).join(', ')}
                {profile.origins.length > 6 ? ` +${profile.origins.length - 6} more` : ''}
              </Text>
              <Text size="xs" c="dimmed">
                Uploaded {new Date(profile.uploadedAt as unknown as string).toLocaleString()}
                {profile.uploadedBy ? ` by ${profile.uploadedBy}` : ''}
              </Text>
            </Stack>
          ) : (
            <Text size="xs" c="dimmed" fs="italic">
              No profile attached — sessions start signed out.
            </Text>
          )}

          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void handleFile(file);
            }}
          />

          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              loading={uploading}
              leftSection={<IconUpload size={14} />}
              onClick={() => fileInput.current?.click()}
            >
              {profile ? 'Replace profile.json' : 'Upload profile.json'}
            </Button>
            {profile ? (
              <Tooltip label="New sessions will start signed out">
                <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={clearProfile}>
                  Remove
                </Button>
              </Tooltip>
            ) : null}
          </Group>
        </Stack>
      </Paper>

      {/* ── Default session settings ────────────────────────── */}
      <Paper withBorder p="lg" radius="lg">
        <Stack gap="sm">
          <Group gap="xs">
            <ThemeIcon variant="light" color="teal" radius="md"><IconDeviceDesktop size={16} /></ThemeIcon>
            <Text fw={600}>Default session settings</Text>
          </Group>
          <Text size="xs" c="dimmed">
            Applied to every session opened under this browser, unless the caller overrides them.
          </Text>

          <Group grow align="flex-start">
            <NumberInput
              size="xs"
              label="Viewport width"
              min={320}
              max={8192}
              value={config.viewport?.width ?? 1280}
              onChange={(value) => set('viewport', {
                width: Number(value) || 1280,
                height: config.viewport?.height ?? 800,
              })}
            />
            <NumberInput
              size="xs"
              label="Viewport height"
              min={240}
              max={8192}
              value={config.viewport?.height ?? 800}
              onChange={(value) => set('viewport', {
                width: config.viewport?.width ?? 1280,
                height: Number(value) || 800,
              })}
            />
          </Group>

          <Group grow align="flex-start">
            <TextInput
              size="xs"
              label="Locale"
              placeholder="tr-TR"
              value={config.locale ?? ''}
              onChange={(event) => set('locale', event.currentTarget.value || undefined)}
            />
            <TextInput
              size="xs"
              label="Timezone"
              placeholder="Europe/Istanbul"
              description="Pages that render dates read this."
              value={config.timezoneId ?? ''}
              onChange={(event) => set('timezoneId', event.currentTarget.value || undefined)}
            />
          </Group>

          <TextInput
            size="xs"
            label="User agent"
            placeholder="Leave empty for the Chromium default"
            value={config.userAgent ?? ''}
            onChange={(event) => set('userAgent', event.currentTarget.value || undefined)}
          />

          <Group grow align="flex-start">
            <NumberInput
              size="xs"
              label="Action timeout (ms)"
              description="How long one click or type may wait."
              min={1}
              max={120_000}
              value={config.actionTimeoutMs ?? 15_000}
              onChange={(value) => set('actionTimeoutMs', Number(value) || undefined)}
            />
            <NumberInput
              size="xs"
              label="Navigation timeout (ms)"
              min={1}
              max={300_000}
              value={config.navigationTimeoutMs ?? 30_000}
              onChange={(value) => set('navigationTimeoutMs', Number(value) || undefined)}
            />
          </Group>

          <Group grow align="flex-start">
            <NumberInput
              size="xs"
              label="Idle timeout (ms)"
              description="Auto-close after this long with no activity."
              min={1_000}
              value={config.idleTimeoutMs ?? 300_000}
              onChange={(value) => set('idleTimeoutMs', Number(value) || undefined)}
            />
            <NumberInput
              size="xs"
              label="Max lifetime (ms)"
              min={1_000}
              value={config.maxLifetimeMs ?? 1_800_000}
              onChange={(value) => set('maxLifetimeMs', Number(value) || undefined)}
            />
          </Group>

          <TextInput
            size="xs"
            label="Egress proxy"
            placeholder="http://proxy.corp.local:8080"
            description="Route this browser's traffic through a corporate gateway."
            value={config.proxy?.server ?? ''}
            onChange={(event) => set('proxy', event.currentTarget.value
              ? { ...config.proxy, server: event.currentTarget.value }
              : undefined)}
          />

          <Group grow align="flex-start">
            <TextInput
              size="xs"
              label="Allowed hosts"
              placeholder="portal.example.com, *.example.com"
              description="Comma separated. Empty means any host."
              value={(config.access?.allowList ?? []).join(', ')}
              onChange={(event) => set('access', {
                ...config.access,
                allowList: event.currentTarget.value
                  .split(',').map((item) => item.trim()).filter(Boolean),
              })}
            />
            <TextInput
              size="xs"
              label="Blocked hosts"
              placeholder="ads.example.com"
              description="Evaluated after the allow list."
              value={(config.access?.blockList ?? []).join(', ')}
              onChange={(event) => set('access', {
                ...config.access,
                blockList: event.currentTarget.value
                  .split(',').map((item) => item.trim()).filter(Boolean),
              })}
            />
          </Group>

          <Select
            size="xs"
            label="Browser dialogs"
            description="alert / confirm / prompt. An unanswered dialog blocks the page forever, so there is no 'leave it open'."
            data={[
              { value: 'dismiss', label: 'Dismiss (cancel)' },
              { value: 'accept', label: 'Accept (OK)' },
            ]}
            value={config.dialogPolicy ?? 'dismiss'}
            onChange={(value) => set('dialogPolicy', (value as 'accept' | 'dismiss') ?? 'dismiss')}
          />

          <Switch
            size="sm"
            label="Allow file downloads"
            description="Off by default — an automated browser that accepts files is an ingest path nobody scanned."
            checked={config.acceptDownloads ?? false}
            onChange={(event) => set('acceptDownloads', event.currentTarget.checked)}
          />

          <Switch
            size="sm"
            color="red"
            label="Ignore HTTPS errors"
            description="Disables certificate verification. Only for an internal site with a known-broken chain."
            checked={config.ignoreHTTPSErrors ?? false}
            onChange={(event) => set('ignoreHTTPSErrors', event.currentTarget.checked)}
          />

          <Group justify="flex-end">
            <Button size="xs" color="teal" loading={savingConfig} onClick={saveConfig}>
              Save defaults
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}
