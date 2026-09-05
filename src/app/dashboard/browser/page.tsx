'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconEye,
  IconPlus,
  IconRoute,
  IconTrash,
  IconWorld,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type {
  BrowserSessionView,
  BrowserView,
} from '@/lib/services/browser';

interface CreateForm {
  name: string;
  description: string;
  artifactBucketKey: string;
  defaultModelKey: string;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  locale: string;
  timezoneId: string;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  idleTimeoutMs: number;
  allowList: string;
  blockList: string;
  proxyServer: string;
  dialogPolicy: 'accept' | 'dismiss';
  acceptDownloads: boolean;
}

/** "a.com, b.com" -> ["a.com","b.com"]; empty stays undefined, not []. */
function splitHosts(value: string): string[] | undefined {
  const hosts = value.split(',').map((item) => item.trim()).filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

interface RowMetrics {
  sessions: number;
  activeSessions: number;
}

export default function BrowsersListPage() {
  const router = useRouter();
  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [createOpened, createHandlers] = useDisclosure(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BrowserView | null>(null);

  const form = useForm<CreateForm>({
    initialValues: {
      name: '',
      description: '',
      artifactBucketKey: '',
      defaultModelKey: '',
      // Defaults mirror the server's own (`config.browser.*`), so a browser
      // created without touching this section behaves exactly as before.
      headless: true,
      viewportWidth: 1280,
      viewportHeight: 800,
      locale: '',
      timezoneId: '',
      actionTimeoutMs: 15_000,
      navigationTimeoutMs: 30_000,
      idleTimeoutMs: 300_000,
      allowList: '',
      blockList: '',
      proxyServer: '',
      dialogPolicy: 'dismiss',
      acceptDownloads: false,
    },
    validate: { name: (v) => (v.trim().length < 2 ? 'Name is required' : null) },
  });

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [browsersRes, sessionsRes] = await Promise.all([
        fetch('/api/browser/browsers', { cache: 'no-store' }),
        fetch('/api/browser/sessions', { cache: 'no-store' }),
      ]);
      if (!browsersRes.ok) throw new Error('Failed to load browsers');
      const browsersData = await browsersRes.json();
      const sessionsData = sessionsRes.ok
        ? await sessionsRes.json()
        : { sessions: [] };
      setBrowsers(browsersData.browsers ?? []);
      setSessions(sessionsData.sessions ?? []);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const metricsById = useMemo(() => {
    const map = new Map<string, RowMetrics>();
    for (const b of browsers) map.set(b.id, { sessions: 0, activeSessions: 0 });
    for (const s of sessions) {
      const m = map.get(s.browserId ?? '');
      if (!m) continue;
      m.sessions += 1;
      if (s.status === 'running' || s.status === 'idle') m.activeSessions += 1;
    }
    return map;
  }, [browsers, sessions]);

  const summary = useMemo(() => {
    const active = browsers.filter((b) => b.status === 'active').length;
    const disabled = browsers.filter((b) => b.status === 'disabled').length;
    const activeSessions = sessions.filter(
      (s) => s.status === 'running' || s.status === 'idle',
    ).length;
    return {
      total: browsers.length,
      active,
      disabled,
      sessions: sessions.length,
      activeSessions,
    };
  }, [browsers, sessions]);

  const filtered = useMemo(() => {
    return browsers.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !b.name.toLowerCase().includes(q) &&
          !b.key.toLowerCase().includes(q) &&
          !(b.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [browsers, statusFilter, query]);

  async function handleCreate(values: CreateForm) {
    setCreating(true);
    try {
      const res = await fetch('/api/browser/browsers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          artifactBucketKey: values.artifactBucketKey.trim() || undefined,
          defaultModelKey: values.defaultModelKey.trim() || undefined,
          defaultSessionConfig: {
            headless: values.headless,
            viewport: { width: values.viewportWidth, height: values.viewportHeight },
            locale: values.locale.trim() || undefined,
            timezoneId: values.timezoneId.trim() || undefined,
            actionTimeoutMs: values.actionTimeoutMs,
            navigationTimeoutMs: values.navigationTimeoutMs,
            idleTimeoutMs: values.idleTimeoutMs,
            dialogPolicy: values.dialogPolicy,
            acceptDownloads: values.acceptDownloads,
            ...(values.proxyServer.trim() ? { proxy: { server: values.proxyServer.trim() } } : {}),
            access: {
              allowList: splitHosts(values.allowList),
              blockList: splitHosts(values.blockList),
            },
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to create');
      }
      notifications.show({
        color: 'teal',
        title: 'Created',
        message: 'Browser created',
      });
      createHandlers.close();
      form.reset();
      await load();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/browser/browsers/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to delete');
      }
      notifications.show({
        color: 'teal',
        title: 'Deleted',
        message: 'Browser removed',
      });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    }
  }

  const columns: DataGridColumn<BrowserView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (b) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {b.name}
          </span>
          {b.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {b.description.length > 60
                ? `${b.description.slice(0, 60)}…`
                : b.description}
            </span>
          ) : (
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
              {b.key}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'key',
      label: 'Key',
      render: (b) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {b.key}
        </span>
      ),
    },
    {
      key: 'model',
      label: 'Default model',
      render: (b) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {b.defaultModelKey ?? '—'}
        </span>
      ),
    },
    {
      key: 'sessions',
      label: 'Sessions',
      render: (b) => {
        const m = metricsById.get(b.id) ?? { sessions: 0, activeSessions: 0 };
        return (
          <div className="ds-row ds-gap-xs">
            <span className="ds-badge">{m.sessions}</span>
            {m.activeSessions > 0 ? (
              <span className="ds-badge ds-badge-ok">{m.activeSessions} live</span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: (b) => (
        <StatusBadge status={b.status === 'active' ? 'active' : 'paused'} />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Browsers"
        title="Browsers"
        subtitle="Headless browser profiles. Create a browser, then add sessions or run agents on top of it."
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              size="sm"
              leftSection={<IconRoute size={14} stroke={1.7} />}
              onClick={() => router.push('/dashboard/browser/flows')}
            >
              Flows
            </Button>
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlus size={14} stroke={1.7} />}
              onClick={createHandlers.open}
            >
              Create browser
            </Button>
          </Group>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Browsers"
          icon={<IconWorld size={14} stroke={1.7} />}
          value={summary.total}
        />
        <StatTile label="Active" value={summary.active} />
        <StatTile label="Disabled" value={summary.disabled} />
        <StatTile
          label="Sessions"
          value={summary.sessions}
          delta={`${summary.activeSessions} live`}
        />
      </div>

      <DataGrid<BrowserView>
        records={filtered}
        loading={loading}
        rowKey={(b) => b.id}
        onRowClick={(b) => router.push(`/dashboard/browser/${b.id}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search by name, key, description…',
        }}
        filters={[
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Filter by status',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ],
          },
        ]}
        onRefresh={load}
        refreshing={refreshing}
        empty={{
          icon: <IconWorld size={26} stroke={1.7} />,
          title: 'No browsers yet',
          description:
            'Create your first browser profile to start running automation sessions.',
          primaryAction: {
            label: 'Create your first browser',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: createHandlers.open,
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${browsers.length} browsers`}
        rowActions={(b) => [
          {
            id: 'open',
            label: 'Open browser',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/browser/${b.id}`),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(b),
          },
        ]}
      />

      <FormShell
        open={createOpened}
        onClose={createHandlers.close}
        title="Create browser"
        subtitle="A browser profile is the container sessions, flows and agent tools run under — these defaults apply to every session it opens."
        icon={<IconWorld size={18} stroke={1.7} />}
        primaryAction={{
          label: 'Create browser',
          color: 'teal',
          loading: creating,
          onClick: () => form.onSubmit(handleCreate)(),
        }}
        secondaryAction={{ label: 'Cancel', onClick: createHandlers.close }}
      >
        <FormSection number={1} title="Identity">
          <FormRow cols={1}>
            <FormField label="Name" required>
              <TextInput placeholder="Vendor portal" {...form.getInputProps('name')} />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="Description" optional>
              <Textarea
                autosize
                minRows={2}
                placeholder="What this browser is for, and who owns it."
                {...form.getInputProps('description')}
              />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label="Artifact bucket" optional hint="Where screenshots and PDFs land. Empty uses the platform default.">
              <TextInput placeholder="browser-artifacts" {...form.getInputProps('artifactBucketKey')} />
            </FormField>
            <FormField label="Default model key" optional hint="Used by agents bound to this browser.">
              <TextInput placeholder="gpt-5.6" {...form.getInputProps('defaultModelKey')} />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection
          number={2}
          title="Browser window"
          description="How pages are rendered. Viewport size changes what a responsive site shows, so it changes which elements exist."
        >
          <FormRow cols={2}>
            <FormField label="Viewport width">
              <NumberInput min={320} max={8192} {...form.getInputProps('viewportWidth')} />
            </FormField>
            <FormField label="Viewport height">
              <NumberInput min={240} max={8192} {...form.getInputProps('viewportHeight')} />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label="Locale" optional hint="Sent as Accept-Language.">
              <TextInput placeholder="tr-TR" {...form.getInputProps('locale')} />
            </FormField>
            <FormField label="Timezone" optional hint="Pages that render dates read this.">
              <TextInput placeholder="Europe/Istanbul" {...form.getInputProps('timezoneId')} />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="Headless" hint="Off runs a visible browser — only useful on a machine with a display.">
              <Switch
                label={form.values.headless ? 'Headless' : 'Headful'}
                checked={form.values.headless}
                onChange={(event) => form.setFieldValue('headless', event.currentTarget.checked)}
              />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection
          number={3}
          title="Timeouts"
          description="Bounds on how long one step may wait. Too generous and a broken selector costs a minute; too tight and a slow page fails for no reason."
          collapsible
          defaultOpen={false}
        >
          <FormRow cols={3}>
            <FormField label="Action (ms)">
              <NumberInput min={1} max={120_000} {...form.getInputProps('actionTimeoutMs')} />
            </FormField>
            <FormField label="Navigation (ms)">
              <NumberInput min={1} max={300_000} {...form.getInputProps('navigationTimeoutMs')} />
            </FormField>
            <FormField label="Idle close (ms)" hint="Auto-close after this long with no activity.">
              <NumberInput min={1_000} {...form.getInputProps('idleTimeoutMs')} />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection
          number={4}
          title="Network and safety"
          description="What this browser is allowed to reach, and what it does when a page interrupts."
          collapsible
          defaultOpen={false}
        >
          <FormRow cols={2}>
            <FormField label="Allowed hosts" optional hint="Comma separated. Empty means any host. Supports *.example.com.">
              <TextInput placeholder="portal.example.com, *.example.com" {...form.getInputProps('allowList')} />
            </FormField>
            <FormField label="Blocked hosts" optional hint="Evaluated after the allow list.">
              <TextInput placeholder="ads.example.com" {...form.getInputProps('blockList')} />
            </FormField>
          </FormRow>
          <FormRow cols={2}>
            <FormField label="Egress proxy" optional hint="Route this browser through a corporate gateway.">
              <TextInput placeholder="http://proxy.corp.local:8080" {...form.getInputProps('proxyServer')} />
            </FormField>
            <FormField label="Dialogs" hint="An unanswered alert blocks the page forever, so there is no 'leave it open'.">
              <Select
                data={[
                  { value: 'dismiss', label: 'Dismiss (cancel)' },
                  { value: 'accept', label: 'Accept (OK)' },
                ]}
                value={form.values.dialogPolicy}
                onChange={(value) => form.setFieldValue('dialogPolicy', (value as 'accept' | 'dismiss') ?? 'dismiss')}
              />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="File downloads" hint="Off by default — an automated browser that accepts files is an ingest path nobody scanned.">
              <Switch
                label={form.values.acceptDownloads ? 'Allowed' : 'Blocked'}
                checked={form.values.acceptDownloads}
                onChange={(event) => form.setFieldValue('acceptDownloads', event.currentTarget.checked)}
              />
            </FormField>
          </FormRow>
        </FormSection>
      </FormShell>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete browser"
        centered
        size="sm"
      >
        <Stack gap="md">
          <span>
            Delete browser <strong>{deleteTarget?.name}</strong>? Sessions and
            agents must be removed first.
          </span>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={confirmDelete}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </PageContainer>
  );
}
