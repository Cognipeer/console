'use client';

import { useTranslations } from '@/lib/i18n';
import { useDeleteResource, ResourceUsageSection } from '@/components/common/confirm';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Center,
  Code,
  CopyButton,
  Group,
  JsonInput,
  Loader,
  Modal,
  Pagination,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
  ActionIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconChartBar,
  IconCheck,
  IconCode,
  IconCopy,
  IconList,
  IconPlugConnected,
  IconRefresh,
  IconSettings,
  IconTool,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import FormShell, { FormField, FormSection } from '@/components/common/ui/FormShell';
import RuntimeContextEditor, { parseRuntimeContextJson } from '@/components/common/RuntimeContextEditor';
import type { ToolView, ToolRequestLogView } from '@/lib/services/tools';
import type { IToolAction } from '@/lib/database';

// ── Constants ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  active: 'teal',
  disabled: 'gray',
  success: 'teal',
  error: 'red',
};

const actionColumnsFor = (tm: (key: string) => string): DataGridColumn<IToolAction>[] => [
  { key: 'key', label: 'Action Key', render: (action) => <Code>{action.key}</Code> },
  {
    key: 'name',
    label: 'Name',
    render: (action) => <Text size="sm" fw={500}>{action.name}</Text>,
  },
  {
    key: 'description',
    label: 'Description',
    render: (action) => <Text size="xs" c="dimmed" lineClamp={2}>{action.description}</Text>,
  },
  {
    key: 'type',
    label: 'Type',
    render: (action) => (
      <Badge size="xs" variant="light" color={EXECUTION_COLORS[action.executionType] ?? 'violet'}>
        {action.executionType === 'openapi_http'
          ? 'HTTP'
          : action.executionType === 'connector_action'
            ? tm('native')
            : 'MCP'}
      </Badge>
    ),
  },
  {
    key: 'target',
    label: 'Method / Path',
    render: (action) =>
      action.httpMethod && action.httpPath ? (
        <Text size="xs" ff="monospace">
          {action.httpMethod} {action.httpPath}
        </Text>
      ) : action.mcpToolName ? (
        <Text size="xs" ff="monospace">{action.mcpToolName}</Text>
      ) : (
        <Text size="xs" c="dimmed">—</Text>
      ),
  },
];

const logColumns: DataGridColumn<ToolRequestLogView>[] = [
  {
    key: 'detail',
    label: 'Detail',
    width: 64,
    render: (log) => {
      const hasPayload = !!log.requestPayload || !!log.responsePayload;
      return (
        <Text size="xs" c={hasPayload ? 'blue' : 'dimmed'}>
          {hasPayload ? 'View' : '—'}
        </Text>
      );
    },
  },
  { key: 'action', label: 'Action', render: (log) => <Code>{log.actionName || log.actionKey}</Code> },
  {
    key: 'status',
    label: 'Status',
    render: (log) => (
      <Badge size="sm" variant="light" color={STATUS_COLORS[log.status] ?? 'gray'}>
        {log.status}
      </Badge>
    ),
  },
  {
    key: 'latency',
    label: 'Latency',
    render: (log) => (
      <Text size="sm">{log.latencyMs !== undefined ? `${log.latencyMs}ms` : '—'}</Text>
    ),
  },
  {
    key: 'caller',
    label: 'Caller',
    render: (log) => (
      <Group gap={4} wrap="nowrap">
        <Badge size="xs" variant="light" color="gray">
          {log.callerType || 'unknown'}
        </Badge>
        {(() => {
          const auth = (log.requestPayload as Record<string, unknown> | undefined)
            ?._runtimeAuth as { headerKeys?: string[]; source?: string } | undefined;
          if (!auth?.headerKeys?.length) return null;
          return (
            <Tooltip label={`Runtime headers: ${auth.headerKeys.join(', ')}${auth.source ? ` (${auth.source})` : ''}`}>
              <Badge size="xs" variant="outline" color="orange">
                runtime auth
              </Badge>
            </Tooltip>
          );
        })()}
      </Group>
    ),
  },
  {
    key: 'error',
    label: 'Error',
    render: (log) => (
      <Text size="xs" c="dimmed" lineClamp={1}>
        {log.errorMessage || '—'}
      </Text>
    ),
  },
  {
    key: 'time',
    label: 'Time',
    render: (log) => (
      <Text size="xs" c="dimmed">
        {log.createdAt ? new Date(log.createdAt).toLocaleString() : '—'}
      </Text>
    ),
  },
];

const TYPE_LABELS: Record<string, string> = {
  openapi: 'OpenAPI',
  mcp: 'MCP',
  connector: 'Connector',
};

const EXECUTION_COLORS: Record<string, string> = {
  openapi_http: 'indigo',
  mcp_call: 'violet',
  connector_action: 'grape',
};

const TYPE_COLORS: Record<string, string> = {
  openapi: 'indigo',
  mcp: 'violet',
  connector: 'grape',
};

interface ToolAggregateView {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs?: number | null;
  actionBreakdown?: Record<string, number>;
}

// ── Usage Section ────────────────────────────────────────────────────────

function UsageSection({ tool }: { tool: ToolView }) {
  const firstAction = tool.actions?.[0];
  const actionKey = firstAction?.key ?? 'action-key';
  const actionName = firstAction?.name ?? 'action_name';

  return (
    <Stack gap="md">
      {/* Tool key */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Tool Key</Text>
        <Group gap="sm">
          <Code fz="sm" style={{ flex: 1 }}>{tool.key}</Code>
          <CopyButton value={tool.key} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                <Button size="xs" variant={copied ? 'filled' : 'light'}
                  color={copied ? 'teal' : 'blue'}
                  leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  onClick={copy}
                >
                  {copied ? 'Copied' : 'Copy key'}
                </Button>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
        {firstAction && (
          <Text size="xs" c="dimmed" mt="sm">
            Example action: <Code fz="xs">{actionName}</Code> ({actionKey})
          </Text>
        )}
      </Paper>

      {/* The public client Tools API is retired: agents run tools server-side. */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Using this tool</Text>
        <Text size="sm" c="dimmed">
          Tools run server-side through agent tool bindings. Add <Code fz="xs">{tool.key}</Code> to an agent
          (Tools tab, source “Tool”) and call the agent through the Agents API. The standalone
          client Tools API (<Code fz="xs">/api/client/v1/tools</Code>) has been retired. Use the Test tab to try an action here.
        </Text>
      </Paper>
    </Stack>
  );
}

// ── Component ────────────────────────────────────────────────────────────

export default function ToolDetailPage() {
  const params = useParams<{ id: string }>()!;
  const router = useRouter();
  const tConfirm = useTranslations('common.confirm');
  const tm = useTranslations('managedTools');
  const deleteResource = useDeleteResource();
  const searchParams = useSearchParams()!;
  const tabParam = searchParams.get('tab');
  const initialTab = ['overview', 'actions', 'logs', 'usage', 'test'].includes(tabParam ?? '')
    ? (tabParam as string)
    : 'overview';

  // ── Tool state ──
  const [tool, setTool] = useState<ToolView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(initialTab);

  // ── Overview state ──
  const [overviewAggregate, setOverviewAggregate] = useState<ToolAggregateView | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [todaySummary, setTodaySummary] = useState({ total: 0, success: 0, error: 0 });

  // ── Action detail modal ──
  const [selectedAction, setSelectedAction] = useState<IToolAction | null>(null);

  // ── Request Logs state ──
  const [logs, setLogs] = useState<ToolRequestLogView[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPage, setLogsPage] = useState(1);
  const [logsLimit] = useState(20);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsTotalPages, setLogsTotalPages] = useState(1);
  const [logsKeywordInput, setLogsKeywordInput] = useState('');
  const [logsKeyword, setLogsKeyword] = useState('');
  const [logsFrom, setLogsFrom] = useState('');
  const [logsTo, setLogsTo] = useState('');
  const [selectedLog, setSelectedLog] = useState<ToolRequestLogView | null>(null);

  // ── Test state ──
  const [testAction, setTestAction] = useState<string | null>(null);
  const [testArgs, setTestArgs] = useState('{}');
  const [runtimeContextJson, setRuntimeContextJson] = useState('');
  const [testResult, setTestResult] = useState<string>('');
  const [testing, setTesting] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      upstreamBaseUrl: '',
      mcpEndpoint: '',
      mcpTransport: 'streamable-http' as string,
      authType: 'none' as string,
      authToken: '',
      authHeaderName: '',
      authHeaderValue: '',
      authUsername: '',
      authPassword: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
    },
  });

  // ── Computed overview values ──
  const totalRequests = overviewAggregate?.totalRequests ?? 0;
  const successCount = overviewAggregate?.successCount ?? 0;
  const errorCount = overviewAggregate?.errorCount ?? 0;
  const avgLatencyMs = overviewAggregate?.avgLatencyMs ?? null;
  const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;
  const todaySuccessRate = todaySummary.total > 0
    ? (todaySummary.success / todaySummary.total) * 100
    : 0;
  const topActions = Object.entries(overviewAggregate?.actionBreakdown ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  // ── Data loading ──

  const loadTool = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tools/${params.id}?includeAggregate=true`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404) {
          router.push('/dashboard/agents/tools');
          return;
        }
        throw new Error('Failed to load tool');
      }
      const data = await res.json();
      setTool(data.tool);
      setOverviewAggregate((data.aggregate ?? null) as ToolAggregateView | null);

      form.setValues({
        name: data.tool.name || '',
        description: data.tool.description || '',
        upstreamBaseUrl: data.tool.upstreamBaseUrl || '',
        mcpEndpoint: data.tool.mcpEndpoint || '',
        mcpTransport: data.tool.mcpTransport || 'streamable-http',
        authType: 'none',
        authToken: '',
        authHeaderName: '',
        authHeaderValue: '',
        authUsername: '',
        authPassword: '',
      });
    } catch (err) {
      console.error('Failed to load tool', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to load tool details',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const loadOverviewMetrics = async () => {
    if (!params.id) return;
    setOverviewLoading(true);
    try {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const date = `${yyyy}-${mm}-${dd}`;

      const [totalRes, successRes, errorRes] = await Promise.all([
        fetch(`/api/tools/${params.id}/logs?page=1&limit=1&from=${date}&to=${date}`, { cache: 'no-store' }),
        fetch(`/api/tools/${params.id}/logs?page=1&limit=1&status=success&from=${date}&to=${date}`, { cache: 'no-store' }),
        fetch(`/api/tools/${params.id}/logs?page=1&limit=1&status=error&from=${date}&to=${date}`, { cache: 'no-store' }),
      ]);

      if (!totalRes.ok || !successRes.ok || !errorRes.ok) {
        throw new Error('Failed to load overview metrics');
      }

      const [totalBody, successBody, errorBody] = await Promise.all([
        totalRes.json(),
        successRes.json(),
        errorRes.json(),
      ]);

      setTodaySummary({
        total: totalBody.total ?? 0,
        success: successBody.total ?? 0,
        error: errorBody.total ?? 0,
      });
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load overview metrics',
        color: 'red',
      });
    } finally {
      setOverviewLoading(false);
    }
  };

  const loadLogs = async () => {
    if (!params.id) return;
    setLogsLoading(true);
    try {
      const query = new URLSearchParams();
      query.set('page', String(logsPage));
      query.set('limit', String(logsLimit));
      if (logsKeyword.trim()) query.set('keyword', logsKeyword.trim());
      if (logsFrom) query.set('from', logsFrom);
      if (logsTo) query.set('to', logsTo);

      const res = await fetch(`/api/tools/${params.id}/logs?${query.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load request logs');

      const data = await res.json();
      setLogs(data.logs ?? []);
      setLogsTotal(data.total ?? 0);
      setLogsTotalPages(data.totalPages ?? 1);
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load request logs',
        color: 'red',
      });
    } finally {
      setLogsLoading(false);
    }
  };

  // ── Effects ──

  useEffect(() => {
    loadTool();
    loadOverviewMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  useEffect(() => {
    if (activeTab !== 'logs') return;
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, params.id, logsPage, logsKeyword, logsFrom, logsTo]);

  const handleSave = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setSaving(true);
    try {
      const values = form.values;
      const body: Record<string, unknown> = {
        name: values.name,
        description: values.description || undefined,
      };

      if (tool?.type === 'openapi') {
        if (values.upstreamBaseUrl) body.upstreamBaseUrl = values.upstreamBaseUrl;
      } else {
        if (values.mcpEndpoint) body.mcpEndpoint = values.mcpEndpoint;
        if (values.mcpTransport) body.mcpTransport = values.mcpTransport;
      }

      // Include auth if changed
      if (values.authType !== 'none') {
        const upstreamAuth: Record<string, string> = { type: values.authType };
        if (values.authType === 'token') upstreamAuth.token = values.authToken;
        if (values.authType === 'header') {
          upstreamAuth.headerName = values.authHeaderName;
          upstreamAuth.headerValue = values.authHeaderValue;
        }
        if (values.authType === 'basic') {
          upstreamAuth.username = values.authUsername;
          upstreamAuth.password = values.authPassword;
        }
        body.upstreamAuth = upstreamAuth;
      }

      const res = await fetch(`/api/tools/${params.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update tool');
      }

      notifications.show({ title: 'Saved', message: 'Tool updated successfully', color: 'teal' });
      setEditOpen(false);
      await loadTool();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to update',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/tools/${params.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sync: true }),
      });
      if (!res.ok) throw new Error('Failed to sync');
      notifications.show({ title: 'Synced', message: 'Actions refreshed from source', color: 'teal' });
      await loadTool();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to sync',
        color: 'red',
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = async () => {
    try {
      const deleted = await deleteResource({
        noun: tConfirm('nouns.tool'),
        name: tool?.name,
        type: 'tool',
        id: String(params.id),
        action: async () => {
          const res = await fetch(`/api/tools/${params.id}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('Failed to delete');
        },
      });
      if (!deleted) return;
      notifications.show({ title: 'Deleted', message: `"${tool?.name}" was deleted`, color: 'red' });
      router.push('/dashboard/agents/tools');
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
    }
  };

  const handleTestAction = async () => {
    if (!testAction || !tool) return;
    setTesting(true);
    setTestResult('');
    try {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(testArgs);
      } catch {
        setTestResult('Error: Invalid JSON arguments');
        setTesting(false);
        return;
      }

      const res = await fetch(`/api/tools/${tool.id}/actions/${testAction}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          arguments: args,
          runtime_context: parseRuntimeContextJson(runtimeContextJson),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setTestResult(`Error: ${data.error || 'Unknown error'}`);
      } else {
        setTestResult(JSON.stringify(data, null, 2));
      }
    } catch (err) {
      setTestResult(`Error: ${err instanceof Error ? err.message : 'Failed to execute'}`);
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <Center p="xl">
        <Loader size="sm" />
      </Center>
    );
  }

  if (!tool) return null;

  // A connector's tool: the Tools API refuses to change or delete it (409), so this page only shows it.
  const managedBy = tool.managedBy;
  const readOnly = Boolean(managedBy);

  return (
    <>
      <PageContainer>
      <PageHeader
        eyebrow="Build · Agents · Tool"
        title={tool.name}
        subtitle={tool.description || 'No description'}
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/agents/tools')}
            >
              Back
            </Button>
            {/* Hidden, not disabled, for a connector's tool: a disabled light button looks the same as an enabled one. */}
            {!readOnly && (
              <>
                <Button
                  variant="light"
                  size="xs"
                  leftSection={<IconRefresh size={14} />}
                  loading={syncing}
                  onClick={handleSync}
                >
                  Sync Actions
                </Button>
                <Button
                  variant="light"
                  size="xs"
                  leftSection={<IconSettings size={14} />}
                  onClick={() => setEditOpen(true)}
                >
                  Settings
                </Button>
                <Button
                  variant="light"
                  color="red"
                  size="xs"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => void handleDelete()}
                >
                  Delete
                </Button>
              </>
            )}
          </Group>
        }
      />

      {managedBy && (
        <Alert
          color="blue"
          variant="light"
          icon={<IconPlugConnected size={16} />}
          title={tm('noticeTitle')}
          mb="md"
          data-testid="managed-tool-notice"
        >
          {tm('noticeBody')}{' '}
          <Anchor component={Link} size="sm" href={`/dashboard/connectors/${managedBy.id}`}>
            {tm('openConnector')}
          </Anchor>
        </Alert>
      )}

      {/* Metadata cards */}
      <Group gap="xs" mb="md">
        <Badge variant="light" color={STATUS_COLORS[tool.status] ?? 'gray'}>
          {tool.status === 'active' ? 'Active' : 'Disabled'}
        </Badge>
        <Badge variant="light" color={TYPE_COLORS[tool.type] ?? 'violet'}>
          {TYPE_LABELS[tool.type]}
        </Badge>
        <Badge variant="light" color="blue">
          {tool.actions?.length ?? 0} action(s)
        </Badge>
        <Group gap={4}>
          <Text size="xs" c="dimmed" ff="monospace">{tool.key}</Text>
          <CopyButton value={tool.key}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy key'}>
                <ActionIcon variant="subtle" size="xs" color={copied ? 'teal' : 'gray'} onClick={copy}>
                  {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      </Group>

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v || 'overview')}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview" leftSection={<IconChartBar size={14} />}>
            Overview
          </Tabs.Tab>
          <Tabs.Tab value="actions" leftSection={<IconTool size={14} />}>
            Actions ({tool.actions?.length ?? 0})
          </Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<IconList size={14} />}>
            Request Logs
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconPlugConnected size={14} />}>
            Usage
          </Tabs.Tab>
          <Tabs.Tab value="test" leftSection={<IconCode size={14} />}>
            Playground
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Overview Tab ── */}
        <Tabs.Panel value="overview">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md" mb="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Status</Text>
              <Badge
                size="lg"
                variant="light"
                color={tool.status === 'active' ? 'teal' : 'gray'}
                mt="xs"
              >
                {tool.status === 'active' ? 'Active' : 'Disabled'}
              </Badge>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Actions</Text>
              <Text fw={700} size="xl" mt="xs">{tool.actions?.length ?? 0}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Source Type</Text>
              <Text fw={500} size="sm" mt="xs">
                {TYPE_LABELS[tool.type] ?? tool.type}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Runtime Headers</Text>
              <Switch
                mt="xs"
                size="sm"
                disabled={readOnly}
                label="Accept caller headers"
                checked={
                  (tool.metadata?.runtimeHeaders as { allow?: boolean } | undefined)?.allow === true
                }
                onChange={async (event) => {
                  const allow = event.currentTarget.checked;
                  try {
                    const res = await fetch(`/api/tools/${tool.id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ runtimeHeaders: allow ? { allow: true } : null }),
                    });
                    if (!res.ok) throw new Error('update failed');
                    const data = await res.json();
                    setTool(data.tool);
                  } catch {
                    notifications.show({
                      title: 'Error',
                      message: 'Failed to update runtime header policy',
                      color: 'red',
                    });
                  }
                }}
              />
              <Text size="xs" c="dimmed" mt={6}>
                Allow API/A2A/realtime callers to pass per-request headers to the upstream.
              </Text>
            </Paper>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md" mb="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Total Requests</Text>
              <Text fw={800} size="xl" mt="xs">{totalRequests}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Successful</Text>
              <Text fw={800} size="xl" mt="xs" c="teal">{successCount}</Text>
              <Text size="xs" c="dimmed" mt={2}>{successRate.toFixed(1)}% success rate</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Failed</Text>
              <Text fw={800} size="xl" mt="xs" c="red">{errorCount}</Text>
              <Text size="xs" c="dimmed" mt={2}>
                {totalRequests > 0 ? ((errorCount / totalRequests) * 100).toFixed(1) : '0.0'}% error rate
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Average Latency</Text>
              <Text fw={800} size="xl" mt="xs">{avgLatencyMs ? `${Math.round(avgLatencyMs)}ms` : '—'}</Text>
              <Text size="xs" c="dimmed" mt={2}>All-time average</Text>
            </Paper>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" mb="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Today Requests</Text>
              {overviewLoading ? (
                <Loader size="sm" mt="sm" />
              ) : (
                <>
                  <Text fw={800} size="xl" mt="xs">{todaySummary.total}</Text>
                  <Group gap="xs" mt="sm">
                    <Badge size="sm" variant="light" color="teal">Success: {todaySummary.success}</Badge>
                    <Badge size="sm" variant="light" color="red">Error: {todaySummary.error}</Badge>
                  </Group>
                </>
              )}
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Today Success Rate</Text>
              {overviewLoading ? (
                <Loader size="sm" mt="sm" />
              ) : (
                <>
                  <Text fw={800} size="xl" mt="xs">{todaySuccessRate.toFixed(1)}%</Text>
                  <Text size="xs" c="dimmed" mt={4}>Based on today&apos;s requests</Text>
                </>
              )}
            </Paper>
          </SimpleGrid>

          <Paper withBorder p="md" radius="md" mb="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">Top Actions</Text>
            {topActions.length === 0 ? (
              <Text size="sm" c="dimmed">No executions yet</Text>
            ) : (
              <Stack gap="xs">
                {topActions.map(([actionKey, count]) => (
                  <Group key={actionKey} justify="space-between" wrap="nowrap">
                    <Code>{actionKey}</Code>
                    <Badge size="sm" variant="light" color="blue">{count} calls</Badge>
                  </Group>
                ))}
              </Stack>
            )}
          </Paper>

          <Paper withBorder p="md" radius="md" mb="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">Tool Key</Text>
            <Group gap="sm">
              <Code>{tool.key}</Code>
              <CopyButton value={tool.key}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? 'Copied' : 'Copy'}>
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      color={copied ? 'teal' : 'gray'}
                      onClick={copy}
                      leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
            </Group>
          </Paper>

          {tool.type === 'openapi' && tool.upstreamBaseUrl && (
            <Paper withBorder p="md" radius="md" mb="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">Upstream URL</Text>
              <Text size="sm">{tool.upstreamBaseUrl}</Text>
            </Paper>
          )}

          {tool.type === 'mcp' && tool.mcpEndpoint && (
            <Paper withBorder p="md" radius="md" mb="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">MCP Endpoint</Text>
              <Text size="sm">{tool.mcpEndpoint}</Text>
            </Paper>
          )}
          <Paper withBorder p="md" radius="md" mb="md">
            <ResourceUsageSection type="tool" id={String(params.id)} />
          </Paper>
        </Tabs.Panel>

        {/* ── Actions Tab ── */}
        <Tabs.Panel value="actions">
          {tool.actions.length === 0 ? (
            <Paper withBorder radius="md" p="xl">
              <Stack align="center" gap="sm">
                <ThemeIcon size={40} variant="light" color="gray" radius="xl">
                  <IconTool size={20} />
                </ThemeIcon>
                <Text c="dimmed" size="sm">
                  {/* A managed tool is synced from its connector: there is no Sync Actions button above for it. */}
                  {readOnly ? tm('noActions') : 'No actions discovered yet. Try syncing.'}
                </Text>
              </Stack>
            </Paper>
          ) : (
            <DataGrid<IToolAction>
              records={tool.actions}
              rowKey={(action) => action.key}
              columns={actionColumnsFor(tm)}
              onRowClick={(action) => setSelectedAction(action)}
            />
          )}
        </Tabs.Panel>

        {/* ── Request Logs Tab ── */}
        <Tabs.Panel value="logs">
          <Stack gap="md">
            <Paper withBorder radius="md" p="md">
              <Group align="flex-end" gap="sm" wrap="wrap">
                <TextInput
                  label="Keyword"
                  placeholder="Action name or error message"
                  value={logsKeywordInput}
                  onChange={(event) => setLogsKeywordInput(event.currentTarget.value)}
                  style={{ flex: 1, minWidth: 220 }}
                />
                <TextInput
                  label="From"
                  type="date"
                  value={logsFrom}
                  onChange={(event) => {
                    setLogsPage(1);
                    setLogsFrom(event.currentTarget.value);
                  }}
                />
                <TextInput
                  label="To"
                  type="date"
                  value={logsTo}
                  onChange={(event) => {
                    setLogsPage(1);
                    setLogsTo(event.currentTarget.value);
                  }}
                />
                <Button
                  variant="light"
                  onClick={() => {
                    setLogsPage(1);
                    setLogsKeyword(logsKeywordInput.trim());
                  }}
                >
                  Search
                </Button>
                <Button
                  variant="default"
                  onClick={() => {
                    setLogsPage(1);
                    setLogsKeywordInput('');
                    setLogsKeyword('');
                    setLogsFrom('');
                    setLogsTo('');
                  }}
                >
                  Reset
                </Button>
              </Group>
            </Paper>

            <DataGrid<ToolRequestLogView>
              records={logs}
              rowKey={(log) => log.id}
              columns={logColumns}
              loading={logsLoading}
              onRowClick={(log) => {
                if (log.requestPayload || log.responsePayload) setSelectedLog(log);
              }}
              empty={{
                icon: <IconList size={20} />,
                title: 'No request logs yet',
                description: 'Logs will appear here once tool actions are executed',
              }}
            />

            <Group justify="space-between" align="center">
              <Text size="sm" c="dimmed">
                {logsTotal > 0
                  ? `${(logsPage - 1) * logsLimit + 1}-${Math.min(logsPage * logsLimit, logsTotal)} / ${logsTotal}`
                  : '0 records'}
              </Text>
              <Pagination
                total={logsTotalPages}
                value={logsPage}
                onChange={setLogsPage}
                size="sm"
                disabled={logsTotalPages <= 1}
              />
            </Group>
          </Stack>
        </Tabs.Panel>

        {/* ── Usage Tab ── */}
        <Tabs.Panel value="usage">
          <UsageSection tool={tool} />
        </Tabs.Panel>

        {/* ── Test Tab ── */}
        <Tabs.Panel value="test">
          <Paper withBorder radius="md" p="md">
            <Stack gap="md">
              <Select
                label="Action"
                placeholder="Select an action to test"
                data={tool.actions.map((a) => ({
                  value: a.key,
                  label: `${a.name} (${a.key})`,
                }))}
                value={testAction}
                onChange={setTestAction}
              />

              <JsonInput
                label="Arguments (JSON)"
                placeholder='{"param": "value"}'
                minRows={4}
                maxRows={10}
                autosize
                formatOnBlur
                value={testArgs}
                onChange={setTestArgs}
              />

              <RuntimeContextEditor
                value={runtimeContextJson}
                onChange={setRuntimeContextJson}
              />

              <Button
                leftSection={<IconCode size={14} />}
                loading={testing}
                disabled={!testAction}
                onClick={handleTestAction}
              >
                Execute
              </Button>

              {testResult && (
                <div>
                  <Text size="sm" fw={500} mb="xs">Result</Text>
                  <Code block style={{ maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                    {testResult}
                  </Code>
                </div>
              )}
            </Stack>
          </Paper>
        </Tabs.Panel>
      </Tabs>
      </PageContainer>

      {/* ── Action Detail Modal ── */}
      <Modal
        opened={!!selectedAction}
        onClose={() => setSelectedAction(null)}
        title="Action Details"
        centered
        size="lg"
      >
        {selectedAction && (
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Box>
                <Text size="xs" fw={600} c="dimmed" mb={4}>Key</Text>
                <Code>{selectedAction.key}</Code>
              </Box>
              <Box>
                <Text size="xs" fw={600} c="dimmed" mb={4}>Name</Text>
                <Text size="sm" fw={500}>{selectedAction.name}</Text>
              </Box>
            </SimpleGrid>

            {selectedAction.description && (
              <Box>
                <Text size="xs" fw={600} c="dimmed" mb={4}>Description</Text>
                <Text size="sm">{selectedAction.description}</Text>
              </Box>
            )}

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Box>
                <Text size="xs" fw={600} c="dimmed" mb={4}>Execution Type</Text>
                <Badge size="sm" variant="light" color={EXECUTION_COLORS[selectedAction.executionType] ?? 'violet'}>
                  {selectedAction.executionType === 'openapi_http'
                    ? 'HTTP (OpenAPI)'
                    : selectedAction.executionType === 'connector_action'
                      ? tm('nativeCall')
                      : 'MCP Call'}
                </Badge>
              </Box>
              {selectedAction.httpMethod && selectedAction.httpPath && (
                <Box>
                  <Text size="xs" fw={600} c="dimmed" mb={4}>Endpoint</Text>
                  <Code>{selectedAction.httpMethod} {selectedAction.httpPath}</Code>
                </Box>
              )}
              {selectedAction.mcpToolName && (
                <Box>
                  <Text size="xs" fw={600} c="dimmed" mb={4}>MCP Tool Name</Text>
                  <Code>{selectedAction.mcpToolName}</Code>
                </Box>
              )}
            </SimpleGrid>

            <Box>
              <Text size="xs" fw={600} c="dimmed" mb={4}>Input Schema</Text>
              <Code block style={{ maxHeight: 400, overflow: 'auto', fontSize: 12 }}>
                {selectedAction.inputSchema
                  ? JSON.stringify(selectedAction.inputSchema, null, 2)
                  : 'No input schema defined'}
              </Code>
            </Box>

            <Group justify="flex-end">
              <Button
                variant="light"
                size="sm"
                onClick={() => {
                  setTestAction(selectedAction.key);
                  setSelectedAction(null);
                  setActiveTab('test');
                }}
              >
                Test This Action
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      {/* ── Request / Response Detail Modal ── */}
      <Modal
        opened={!!selectedLog}
        onClose={() => setSelectedLog(null)}
        title="Request / Response Details"
        centered
        size="xl"
      >
        {selectedLog && (
          <Stack gap="md">
            <Group gap="sm">
              <Text size="sm" c="dimmed">Action:</Text>
              <Code>{selectedLog.actionName || selectedLog.actionKey}</Code>
              <Badge size="sm" variant="light" color={STATUS_COLORS[selectedLog.status] ?? 'gray'}>
                {selectedLog.status}
              </Badge>
              {selectedLog.latencyMs !== undefined && (
                <Text size="xs" c="dimmed">{selectedLog.latencyMs}ms</Text>
              )}
              {selectedLog.callerType && (
                <Badge size="xs" variant="light" color="gray">{selectedLog.callerType}</Badge>
              )}
            </Group>

            {selectedLog.errorMessage && (
              <Box>
                <Text size="xs" fw={600} c="red" mb={4}>Error</Text>
                <Code block style={{ fontSize: 12 }}>{selectedLog.errorMessage}</Code>
              </Box>
            )}

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Box>
                <Text size="xs" fw={600} c="dimmed" mb={4}>Request</Text>
                <Code block style={{ maxHeight: 360, overflow: 'auto', fontSize: 12 }}>
                  {selectedLog.requestPayload
                    ? JSON.stringify(selectedLog.requestPayload, null, 2)
                    : 'No request payload'}
                </Code>
              </Box>

              <Box>
                <Text size="xs" fw={600} c="dimmed" mb={4}>Response</Text>
                <Code block style={{ maxHeight: 360, overflow: 'auto', fontSize: 12 }}>
                  {selectedLog.responsePayload
                    ? JSON.stringify(selectedLog.responsePayload, null, 2)
                    : 'No response payload'}
                </Code>
              </Box>
            </SimpleGrid>
          </Stack>
        )}
      </Modal>

      {/* ── Edit Tool ── */}
      <FormShell
        open={editOpen}
        onClose={() => setEditOpen(false)}
        icon={<IconSettings size={16} />}
        title="Edit tool"
        subtitle={tool.name}
        primaryAction={{
          label: 'Save',
          loading: saving,
          disabled: !form.values.name.trim(),
          onClick: () => void handleSave(),
        }}
        secondaryAction={{ label: 'Cancel', onClick: () => setEditOpen(false) }}
      >
        <FormSection number={1} title="Details" description="How this tool is named and where it connects.">
          <FormField label="Name" required>
            <TextInput {...form.getInputProps('name')} />
          </FormField>
          <FormField label="Description" optional>
            <Textarea rows={2} {...form.getInputProps('description')} />
          </FormField>

          {tool.type === 'openapi' && (
            <FormField label="Upstream Base URL" optional>
              <TextInput
                placeholder="https://api.example.com"
                {...form.getInputProps('upstreamBaseUrl')}
              />
            </FormField>
          )}

          {tool.type === 'mcp' && (
            <>
              <FormField label="MCP Endpoint">
                <TextInput
                  placeholder="https://mcp-server.example.com/mcp"
                  {...form.getInputProps('mcpEndpoint')}
                />
              </FormField>
              <FormField label="Transport">
                <Select
                  data={[
                    { value: 'streamable-http', label: 'Streamable HTTP' },
                    { value: 'sse', label: 'SSE' },
                  ]}
                  {...form.getInputProps('mcpTransport')}
                />
              </FormField>
            </>
          )}
        </FormSection>

        <FormSection number={2} title="Authentication" description="Leave as 'None' to keep existing auth unchanged.">
          <FormField label="Update Authentication">
            <Select
              data={[
                { value: 'none', label: 'None (keep existing)' },
                { value: 'token', label: 'Bearer Token' },
                { value: 'header', label: 'Custom Header' },
                { value: 'basic', label: 'Basic Auth' },
              ]}
              {...form.getInputProps('authType')}
            />
          </FormField>

          {form.values.authType === 'token' && (
            <FormField label="Bearer Token">
              <PasswordInput autoComplete="off" {...form.getInputProps('authToken')} />
            </FormField>
          )}
          {form.values.authType === 'header' && (
            <>
              <FormField label="Header Name">
                <TextInput autoComplete="off" {...form.getInputProps('authHeaderName')} />
              </FormField>
              <FormField label="Header Value">
                <PasswordInput autoComplete="off" {...form.getInputProps('authHeaderValue')} />
              </FormField>
            </>
          )}
          {form.values.authType === 'basic' && (
            <>
              <FormField label="Username">
                <TextInput autoComplete="off" {...form.getInputProps('authUsername')} />
              </FormField>
              <FormField label="Password">
                <PasswordInput autoComplete="off" {...form.getInputProps('authPassword')} />
              </FormField>
            </>
          )}
        </FormSection>
      </FormShell>
    </>
  );
}
