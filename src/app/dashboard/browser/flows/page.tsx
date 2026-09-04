'use client';

/**
 * Browser Flows — recorded browser tasks that replay without a model.
 *
 * The list exists to answer two questions an operator actually has: which
 * automations exist, and did the last run work. Everything else (steps,
 * inputs, run history) lives on the detail page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Select, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconPlayerPlay,
  IconPlus,
  IconRoute,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { BrowserFlowView, BrowserSessionView, BrowserView } from '@/lib/services/browser';

interface CreateForm {
  name: string;
  description: string;
  browserId: string;
  /** Empty means "start from nothing"; otherwise record this session. */
  sessionId: string;
}

const RUN_STATUS_VARIANT: Record<string, 'active' | 'paused' | 'error'> = {
  succeeded: 'active',
  running: 'paused',
  pending: 'paused',
  failed: 'error',
  cancelled: 'paused',
};

export default function BrowserFlowsPage() {
  const router = useRouter();
  const [flows, setFlows] = useState<BrowserFlowView[]>([]);
  const [browsers, setBrowsers] = useState<BrowserView[]>([]);
  const [sessions, setSessions] = useState<BrowserSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BrowserFlowView | null>(null);

  const form = useForm<CreateForm>({
    initialValues: { name: '', description: '', browserId: '', sessionId: '' },
    validate: {
      name: (value) => (value.trim().length < 2 ? 'Name is required' : null),
      browserId: (value, values) =>
        // Recording infers the browser from the session, so it is only
        // required when starting from an empty flow.
        !value && !values.sessionId ? 'Pick a browser' : null,
    },
  });

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [flowsRes, browsersRes, sessionsRes] = await Promise.all([
        fetch('/api/browser/flows', { cache: 'no-store' }),
        fetch('/api/browser/browsers?status=active', { cache: 'no-store' }),
        fetch('/api/browser/sessions', { cache: 'no-store' }),
      ]);
      if (!flowsRes.ok) throw new Error('Failed to load flows');
      const flowsData = await flowsRes.json();
      setFlows(flowsData.flows ?? []);
      setBrowsers(browsersRes.ok ? (await browsersRes.json()).browsers ?? [] : []);
      setSessions(sessionsRes.ok ? (await sessionsRes.json()).sessions ?? [] : []);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load flows',
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Sessions worth recording: ones that actually did something.
   *
   * A session with no events produces no steps, and offering it here only
   * leads to an error message after the fact.
   */
  const recordableSessions = useMemo(
    () => sessions.filter((session) => (session.eventCount ?? 0) > 1),
    [sessions],
  );

  const browserName = useCallback(
    (id: string) => browsers.find((item) => item.id === id)?.name ?? '—',
    [browsers],
  );

  const summary = useMemo(() => {
    const active = flows.filter((flow) => flow.status === 'active').length;
    const drafts = flows.filter((flow) => flow.status === 'draft').length;
    const failing = flows.filter((flow) => flow.lastRun?.status === 'failed').length;
    return { total: flows.length, active, drafts, failing };
  }, [flows]);

  const filtered = useMemo(
    () => flows.filter((flow) => {
      if (statusFilter !== 'all' && flow.status !== statusFilter) return false;
      if (!query) return true;
      const needle = query.toLowerCase();
      return (
        flow.name.toLowerCase().includes(needle)
        || flow.key.toLowerCase().includes(needle)
        || (flow.description ?? '').toLowerCase().includes(needle)
      );
    }),
    [flows, statusFilter, query],
  );

  async function handleCreate(values: CreateForm) {
    setCreating(true);
    try {
      // Two ways in, one dialog: record an existing session, or start empty
      // and add steps by hand on the detail page.
      const endpoint = values.sessionId ? '/api/browser/flows/record' : '/api/browser/flows';
      const body = values.sessionId
        ? {
            sessionId: values.sessionId,
            name: values.name.trim(),
            description: values.description.trim() || undefined,
          }
        : {
            name: values.name.trim(),
            description: values.description.trim() || undefined,
            browserId: values.browserId,
            steps: [],
          };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to create flow');

      notifications.show({
        color: 'teal',
        title: values.sessionId ? 'Recorded' : 'Created',
        message: values.sessionId
          ? `${data.flow.steps.length} step(s) captured from the session`
          : 'Flow created — add steps to it next',
      });
      setCreateOpen(false);
      form.reset();
      router.push(`/dashboard/browser/flows/${data.flow.id}`);
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
      const res = await fetch(`/api/browser/flows/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      notifications.show({ color: 'teal', title: 'Deleted', message: 'Flow removed' });
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

  const columns: DataGridColumn<BrowserFlowView>[] = [
    {
      key: 'name',
      label: 'Flow',
      render: (flow) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>{flow.name}</span>
          <span className="ds-mono ds-faint" style={{ fontSize: 11 }}>{flow.key}</span>
        </div>
      ),
    },
    {
      key: 'browser',
      label: 'Browser',
      render: (flow) => (
        <span className="ds-muted" style={{ fontSize: 12 }}>{browserName(flow.browserId)}</span>
      ),
    },
    {
      key: 'steps',
      label: 'Steps',
      render: (flow) => (
        <div className="ds-row ds-gap-xs">
          <span className="ds-badge">{flow.steps.length}</span>
          {(flow.inputs?.length ?? 0) > 0 ? (
            <span className="ds-badge">{flow.inputs?.length} input(s)</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'lastRun',
      label: 'Last run',
      render: (flow) => (flow.lastRun ? (
        <div className="ds-row ds-gap-xs">
          <StatusBadge
            status={RUN_STATUS_VARIANT[flow.lastRun.status] ?? 'paused'}
            label={flow.lastRun.status}
          />
          <span className="ds-faint" style={{ fontSize: 11 }}>
            {new Date(flow.lastRun.startedAt).toLocaleString()}
          </span>
        </div>
      ) : (
        <span className="ds-faint" style={{ fontSize: 12 }}>never run</span>
      )),
    },
    {
      key: 'status',
      label: 'Status',
      render: (flow) => (
        <StatusBadge
          status={flow.status === 'active' ? 'active' : flow.status === 'draft' ? 'paused' : 'error'}
          label={flow.status}
        />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Browsers"
        title="Flows"
        subtitle="Recorded browser tasks. Discover a task once, then replay it with no model in the loop."
        actions={(
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateOpen(true)}
          >
            New flow
          </Button>
        )}
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Flows" icon={<IconRoute size={14} stroke={1.7} />} value={summary.total} />
        <StatTile label="Active" value={summary.active} />
        <StatTile label="Drafts" value={summary.drafts} />
        <StatTile label="Failing" value={summary.failing} />
      </div>

      <DataGrid<BrowserFlowView>
        records={filtered}
        loading={loading}
        rowKey={(flow) => flow.id}
        onRowClick={(flow) => router.push(`/dashboard/browser/flows/${flow.id}`)}
        columns={columns}
        search={{ value: query, onChange: setQuery, placeholder: 'Search flows…' }}
        filters={[{
          value: statusFilter,
          onChange: setStatusFilter,
          ariaLabel: 'Filter by status',
          width: 150,
          options: [
            { value: 'all', label: 'All statuses' },
            { value: 'active', label: 'Active' },
            { value: 'draft', label: 'Draft' },
            { value: 'disabled', label: 'Disabled' },
          ],
        }]}
        onRefresh={load}
        refreshing={refreshing}
        rowActions={(flow) => [
          {
            icon: <IconPlayerPlay size={14} />,
            label: 'Open',
            onClick: () => router.push(`/dashboard/browser/flows/${flow.id}`),
          },
          {
            icon: <IconTrash size={14} />,
            label: 'Delete',
            color: 'red',
            onClick: () => setDeleteTarget(flow),
          },
        ]}
        empty={{
          icon: <IconRoute size={26} stroke={1.7} />,
          title: 'No flows yet',
          description:
            'Drive a browser session once — by hand or with an agent — then record it here as a flow you can replay.',
          primaryAction: {
            label: 'Create your first flow',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateOpen(true),
          },
        }}
      />

      <FormShell
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New browser flow"
        subtitle="Record a session you already drove, or start empty and add steps by hand."
        icon={<IconRoute size={18} stroke={1.7} />}
        primaryAction={{
          label: form.values.sessionId ? 'Record flow' : 'Create flow',
          color: 'teal',
          loading: creating,
          onClick: () => form.onSubmit(handleCreate)(),
        }}
        secondaryAction={{ label: 'Cancel', onClick: () => setCreateOpen(false) }}
      >
        <FormSection number={1} title="Identity">
          <FormRow cols={1}>
            <FormField label="Name" required>
              <TextInput placeholder="Submit monthly expense" {...form.getInputProps('name')} />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="Description" optional>
              <Textarea
                autosize
                minRows={2}
                placeholder="What this flow does, and when someone should run it."
                {...form.getInputProps('description')}
              />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection
          number={2}
          title="Where the steps come from"
          description="Recording reads a session's action log and turns it into durable steps. Values you typed become flow inputs — they are never baked in."
        >
          <FormRow cols={1}>
            <FormField
              label="Record from session"
              optional
              hint={
                recordableSessions.length === 0
                  ? 'No sessions with actions yet. Open a browser, drive it, then come back — or leave this empty and add steps by hand.'
                  : 'Leave empty to start with an empty flow.'
              }
            >
              <Select
                clearable
                searchable
                placeholder={
                  recordableSessions.length === 0 ? 'No recordable sessions' : 'Pick a driven session'
                }
                data={recordableSessions.map((session) => ({
                  value: session.id,
                  label: `${session.name || session.sessionKey} · ${session.eventCount ?? 0} actions · ${
                    session.currentUrl ?? 'no url'
                  }`,
                }))}
                {...form.getInputProps('sessionId')}
              />
            </FormField>
          </FormRow>

          {!form.values.sessionId ? (
            <FormRow cols={1}>
              <FormField label="Browser" required hint="Supplies the session config and egress rules the flow runs under.">
                <Select
                  searchable
                  placeholder={browsers.length === 0 ? 'No active browsers' : 'Pick a browser'}
                  data={browsers.map((browser) => ({
                    value: browser.id,
                    label: `${browser.name} (${browser.key})`,
                  }))}
                  {...form.getInputProps('browserId')}
                />
              </FormField>
            </FormRow>
          ) : null}
        </FormSection>
      </FormShell>

      <FormShell
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name ?? 'flow'}?`}
        subtitle="The flow and its entire run history are removed. This cannot be undone."
        primaryAction={{ label: 'Delete', color: 'red', onClick: confirmDelete }}
        secondaryAction={{ label: 'Cancel', onClick: () => setDeleteTarget(null) }}
      >
        <FormSection title="Confirm">
          <p className="ds-muted" style={{ fontSize: 13 }}>
            {deleteTarget?.steps.length ?? 0} step(s) will be deleted along with every recorded run.
          </p>
        </FormSection>
      </FormShell>
    </PageContainer>
  );
}
