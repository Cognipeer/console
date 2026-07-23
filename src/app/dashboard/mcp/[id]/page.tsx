'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Center,
  Code,
  CopyButton,
  Group,
  Loader,
  Menu,
  Modal,
  Pagination,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCheck,
  IconChartBar,
  IconCode,
  IconCopy,
  IconDots,
  IconEdit,
  IconHistory,
  IconList,
  IconPlayerPlay,
  IconPlugConnected,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import FormShell, { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import McpToolArgsEditor from '@/components/mcp/McpToolArgsEditor';
import McpToolsPanel from '@/components/mcp/McpToolsPanel';
import RuntimeContextEditor, { parseRuntimeContextJson } from '@/components/common/RuntimeContextEditor';
import SpecImportField, { type SpecFormat } from '@/components/common/SpecImportField';
import type { McpServerView, McpRequestLogView } from '@/lib/services/mcp';

const AUTH_LABELS: Record<string, string> = {
  none: 'None',
  token: 'Bearer Token',
  header: 'Custom Header',
  basic: 'Basic Auth',
};

const SOURCE_LABELS: Record<string, string> = {
  openapi: 'OpenAPI proxy',
  remote: 'Remote MCP proxy',
  stdio: 'Stdio package',
};

const STATUS_COLORS: Record<string, string> = {
  success: 'teal',
  error: 'red',
};

interface McpAggregateView {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs?: number | null;
  toolBreakdown?: Record<string, number>;
}

export default function McpDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab = ['overview', 'usage', 'tools', 'playground', 'logs', 'audit'].includes(tabParam ?? '')
    ? (tabParam as string)
    : 'overview';

  const [server, setServer] = useState<(McpServerView & { openApiSpec?: string }) | null>(null);
  const [logs, setLogs] = useState<McpRequestLogView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [selectedLog, setSelectedLog] = useState<McpRequestLogView | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPage, setLogsPage] = useState(1);
  const [logsLimit] = useState(20);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsTotalPages, setLogsTotalPages] = useState(1);
  const [logsKeywordInput, setLogsKeywordInput] = useState('');
  const [logsKeyword, setLogsKeyword] = useState('');
  const [logsFrom, setLogsFrom] = useState('');
  const [logsTo, setLogsTo] = useState('');
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewAggregate, setOverviewAggregate] = useState<McpAggregateView | null>(null);
  const [todaySummary, setTodaySummary] = useState({ total: 0, success: 0, error: 0 });
  // Enterprise sub-feature availability for THIS tenant (sandbox exec + Aegis).
  // `available`/`hookAvailable` fold the enterprise build seam AND the tenant's
  // ENTERPRISE license, so a downgraded tenant sees the warning below.
  const [caps, setCaps] = useState<{
    stdioSandbox: { available: boolean };
    aegis: { hookAvailable: boolean };
  } | null>(null);

  // ── Playground state ──
  const [pgTool, setPgTool] = useState<string | null>(null);
  const [pgArgs, setPgArgs] = useState('{}');
  const [runtimeContextJson, setRuntimeContextJson] = useState('');
  const [pgResult, setPgResult] = useState<string>('');
  const [pgLatency, setPgLatency] = useState<number | null>(null);
  const [pgRunning, setPgRunning] = useState(false);

  // ── Tools refresh + audit state ──
  const [refreshingTools, setRefreshingTools] = useState(false);
  const [auditLogs, setAuditLogs] = useState<Array<{
    _id?: string;
    action: string;
    performedBy: string;
    ipAddress?: string;
    userAgent?: string;
    changes?: Record<string, { from?: unknown; to?: unknown }>;
    createdAt?: string;
  }>>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      upstreamBaseUrl: '',
      authType: 'none' as string,
      authToken: '',
      authHeaderName: '',
      authHeaderValue: '',
      authUsername: '',
      authPassword: '',
      openApiSpec: '',
      specFormat: 'auto' as SpecFormat,
      // remote source
      remoteUrl: '',
      remoteTransport: 'streamable-http' as string,
      // stdio source
      stdioRuntime: 'npx' as string,
      stdioPackage: '',
      stdioArgs: '',
      stdioEnv: '',
    },
    validate: {
      name: (v) => (!v.trim() ? 'Name is required' : null),
    },
  });

  const loadServer = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/mcp/${params.id}?includeAggregate=true`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404) {
          router.push('/dashboard/mcp');
          return;
        }
        throw new Error('Failed to load server');
      }
      const data = await res.json();
      setServer(data.server);
      setOverviewAggregate((data.aggregate ?? null) as McpAggregateView | null);

      const stdioEnvLines = Object.entries(
        (data.server.stdioConfig?.env ?? {}) as Record<string, string>,
      ).map(([k, val]) => `${k}=${val}`).join('\n');

      form.setValues({
        name: data.server.name || '',
        description: data.server.description || '',
        upstreamBaseUrl: data.server.upstreamBaseUrl || '',
        authType: data.server.upstreamAuth?.type || 'none',
        // Secrets come back masked (••••••) when present. Prefill the masked
        // placeholder so an untouched save round-trips it and the vault keeps
        // the stored secret — leaving these blank drops the secret on save.
        authToken: data.server.upstreamAuth?.token || '',
        authHeaderName: data.server.upstreamAuth?.headerName || '',
        authHeaderValue: data.server.upstreamAuth?.headerValue || '',
        authUsername: data.server.upstreamAuth?.username || '',
        authPassword: data.server.upstreamAuth?.password || '',
        openApiSpec: data.server.openApiSpec || '',
        // Stored spec is already normalized to OpenAPI JSON; a re-import can
        // still bring YAML/Postman, so the format hint resets to auto-detect.
        specFormat: 'auto',
        remoteUrl: data.server.remoteConfig?.url || '',
        remoteTransport: data.server.remoteConfig?.transport || 'streamable-http',
        stdioRuntime: data.server.stdioConfig?.runtime || 'npx',
        stdioPackage: data.server.stdioConfig?.packageName || '',
        stdioArgs: (data.server.stdioConfig?.args ?? []).join(' '),
        stdioEnv: stdioEnvLines,
      });
    } catch (err) {
      console.error('Failed to load MCP server', err);
      notifications.show({
        title: 'Error',
        message: 'Failed to load MCP server details',
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
        fetch(`/api/mcp/${params.id}/logs?page=1&limit=1&from=${date}&to=${date}`, { cache: 'no-store' }),
        fetch(`/api/mcp/${params.id}/logs?page=1&limit=1&status=success&from=${date}&to=${date}`, { cache: 'no-store' }),
        fetch(`/api/mcp/${params.id}/logs?page=1&limit=1&status=error&from=${date}&to=${date}`, { cache: 'no-store' }),
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

      const res = await fetch(`/api/mcp/${params.id}/logs?${query.toString()}`, {
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

  useEffect(() => {
    loadServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  useEffect(() => {
    fetch('/api/mcp/capabilities', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setCaps(data); })
      .catch(() => setCaps(null));
  }, []);

  useEffect(() => {
    loadOverviewMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  useEffect(() => {
    if (activeTab !== 'logs') return;
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, params.id, logsPage, logsKeyword, logsFrom, logsTo]);

  useEffect(() => {
    if (activeTab !== 'audit' || !server) return;
    setAuditLoading(true);
    fetch(`/api/mcp/audit?serverKey=${encodeURIComponent(server.key)}&limit=100`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { logs: [] }))
      .then((data) => setAuditLogs(data.logs ?? []))
      .catch(() => setAuditLogs([]))
      .finally(() => setAuditLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, server?.key]);

  const handleRefreshTools = async () => {
    if (!params.id) return;
    setRefreshingTools(true);
    try {
      const res = await fetch(`/api/mcp/${params.id}/refresh-tools`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Tool discovery failed');
      setServer(data.server);
      notifications.show({
        title: 'Tools refreshed',
        message: `${data.server?.tools?.length ?? 0} tools discovered`,
        color: 'teal',
      });
    } catch (err) {
      notifications.show({
        title: 'Tool discovery failed',
        message: err instanceof Error ? err.message : 'Unknown error',
        color: 'red',
      });
    } finally {
      setRefreshingTools(false);
    }
  };

  const handleSave = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setSaving(true);
    try {
      const values = form.values;
      const sourceType = server?.sourceType ?? 'openapi';
      const update: Record<string, unknown> = {
        name: values.name,
        description: values.description || undefined,
      };

      // Upstream auth applies to openapi/remote sources; stdio talks over
      // stdin/stdout and authenticates via env vars instead.
      if (sourceType !== 'stdio') {
        const upstreamAuth: Record<string, string> = { type: values.authType };
        if (values.authType === 'token' && values.authToken) {
          upstreamAuth.token = values.authToken;
        } else if (values.authType === 'header') {
          upstreamAuth.headerName = values.authHeaderName;
          if (values.authHeaderValue) upstreamAuth.headerValue = values.authHeaderValue;
        } else if (values.authType === 'basic') {
          upstreamAuth.username = values.authUsername;
          if (values.authPassword) upstreamAuth.password = values.authPassword;
        }
        update.upstreamAuth = upstreamAuth;
      }

      if (sourceType === 'openapi') {
        update.upstreamBaseUrl = values.upstreamBaseUrl || undefined;
        // Update spec if changed. A re-imported spec may be YAML/Postman, so
        // pass the format hint through for server-side normalization.
        if (values.openApiSpec && values.openApiSpec !== server?.openApiSpec) {
          update.openApiSpec = values.openApiSpec;
          update.specFormat = values.specFormat;
        }
      } else if (sourceType === 'remote') {
        if (!values.remoteUrl.trim()) throw new Error('MCP server URL is required');
        const currentRemote = server?.remoteConfig;
        if (values.remoteUrl.trim() !== (currentRemote?.url ?? '')
          || values.remoteTransport !== (currentRemote?.transport ?? 'streamable-http')) {
          update.remoteConfig = {
            url: values.remoteUrl.trim(),
            transport: values.remoteTransport,
          };
        }
      } else if (sourceType === 'stdio') {
        if (!values.stdioPackage.trim()) throw new Error('Package name is required');
        const env: Record<string, string> = {};
        for (const line of values.stdioEnv.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq <= 0) continue;
          env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
        }
        // Masked values ("••••••") are resolved server-side to the stored
        // secrets; execution mode / sandbox settings pass through unchanged.
        // Sending stdioConfig triggers tool re-discovery, so only include it
        // when the launch configuration actually changed.
        const current = server?.stdioConfig;
        const currentEnvLines = Object.entries(current?.env ?? {})
          .map(([k, val]) => `${k}=${val}`).join('\n');
        const args = values.stdioArgs.split(/\s+/).map((a) => a.trim()).filter(Boolean);
        const stdioChanged = values.stdioRuntime !== (current?.runtime ?? 'npx')
          || values.stdioPackage.trim() !== (current?.packageName ?? '')
          || args.join(' ') !== (current?.args ?? []).join(' ')
          || values.stdioEnv.trim() !== currentEnvLines.trim();
        if (stdioChanged) {
          update.stdioConfig = {
            runtime: values.stdioRuntime,
            packageName: values.stdioPackage.trim(),
            args,
            env: Object.keys(env).length ? env : undefined,
            executionMode: current?.executionMode ?? 'subprocess',
            sandbox: current?.sandbox,
          };
        }
      }

      const res = await fetch(`/api/mcp/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to update server');
      }

      notifications.show({
        title: 'Saved',
        message: 'MCP server settings updated',
        color: 'teal',
      });
      setEditOpen(false);
      await loadServer();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to save',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/mcp/${params.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Deleted',
        message: `"${server?.name}" was deleted`,
        color: 'red',
      });
      router.push('/dashboard/mcp');
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleRunPlayground = async () => {
    if (!pgTool) return;
    setPgRunning(true);
    setPgResult('');
    setPgLatency(null);
    try {
      let args: unknown = {};
      if (pgArgs.trim()) {
        try {
          args = JSON.parse(pgArgs);
        } catch {
          setPgResult('Error: Arguments must be valid JSON');
          setPgRunning(false);
          return;
        }
      }

      const res = await fetch(`/api/mcp/${params.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: pgTool,
          arguments: args,
          runtime_context: parseRuntimeContextJson(runtimeContextJson),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPgResult(`Error: ${data.error || 'Execution failed'}`);
      } else {
        setPgLatency(typeof data.latencyMs === 'number' ? data.latencyMs : null);
        setPgResult(
          typeof data.result === 'string'
            ? data.result
            : JSON.stringify(data.result, null, 2),
        );
      }
    } catch (err) {
      setPgResult(`Error: ${err instanceof Error ? err.message : 'Failed to execute'}`);
    } finally {
      setPgRunning(false);
    }
  };

  const enabledPgTools = (server?.tools ?? []).filter(
    (t) => !(server?.disabledTools ?? []).includes(t.name),
  );
  const selectedPgTool = server?.tools?.find((t) => t.name === pgTool) ?? null;

  if (loading) {
    return (
      <Center p="xl" mt="xl">
        <Loader size="md" />
      </Center>
    );
  }

  if (!server) {
    return (
      <Center p="xl" mt="xl">
        <Text c="dimmed">Server not found</Text>
      </Center>
    );
  }

  const totalRequests = overviewAggregate?.totalRequests ?? 0;
  const successCount = overviewAggregate?.successCount ?? 0;
  const errorCount = overviewAggregate?.errorCount ?? 0;
  const avgLatencyMs = overviewAggregate?.avgLatencyMs;
  const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;
  const todaySuccessRate = todaySummary.total > 0 ? (todaySummary.success / todaySummary.total) * 100 : 0;
  const topTools = Object.entries(overviewAggregate?.toolBreakdown ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const headerActions = (
    <>
      {server.sourceType !== 'openapi' ? (
        <Button
          variant="default"
          size="sm"
          leftSection={<IconRefresh size={14} stroke={1.7} />}
          loading={refreshingTools}
          onClick={() => void handleRefreshTools()}
        >
          Update tools
        </Button>
      ) : null}
      <Button
        variant="default"
        size="sm"
        leftSection={<IconEdit size={14} stroke={1.7} />}
        onClick={() => setEditOpen(true)}
      >
        Edit
      </Button>
      <Menu withinPortal position="bottom-end" withArrow>
        <Menu.Target>
          <ActionIcon variant="default" radius="md" size="lg" aria-label="More">
            <IconDots size={15} stroke={1.7} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => setDeleteOpen(true)}
          >
            Delete server
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </>
  );

  return (
    <>
      <DetailShell
        backHref="/dashboard/mcp"
        backLabel="Back to MCP servers"
        icon={
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 10,
              background: 'var(--ds-accent-soft)',
              color: 'var(--ds-accent)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <IconPlugConnected size={22} stroke={1.7} />
          </div>
        }
        title={
          <>
            <h1 className="ds-h2" style={{ margin: 0, whiteSpace: 'nowrap' }}>
              {server.name}
            </h1>
            <StatusBadge
              status={server.status === 'active' ? 'ok' : 'paused'}
              label={server.status === 'active' ? 'Active' : 'Disabled'}
            />
            <span className="ds-badge ds-badge-info">
              {server.disabledTools?.length
                ? `${(server.tools?.length ?? 0) - server.disabledTools.length}/${server.tools?.length ?? 0} tools`
                : `${server.tools?.length ?? 0} tools`}
            </span>
          </>
        }
        meta={
          <>
            <span className="ds-mono">{server.key}</span>
            <span className="ds-faint">·</span>
            <span>
              auth:{' '}
              <span className="ds-mono">
                {AUTH_LABELS[server.upstreamAuth?.type] ?? 'None'}
              </span>
            </span>
            {server.description ? (
              <>
                <span className="ds-faint">·</span>
                <span>{server.description}</span>
              </>
            ) : null}
          </>
        }
        actions={headerActions}
      >

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v || 'overview')}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview" leftSection={<IconChartBar size={14} />}>
            Overview
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconPlugConnected size={14} />}>
            Usage
          </Tabs.Tab>
          <Tabs.Tab value="tools" leftSection={<IconCode size={14} />}>
            {server.disabledTools?.length
              ? `Tools (${(server.tools?.length ?? 0) - server.disabledTools.length}/${server.tools?.length ?? 0})`
              : `Tools (${server.tools?.length ?? 0})`}
          </Tabs.Tab>
          <Tabs.Tab value="playground" leftSection={<IconPlayerPlay size={14} />}>
            Playground
          </Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<IconList size={14} />}>
            Request Logs
          </Tabs.Tab>
          <Tabs.Tab value="audit" leftSection={<IconHistory size={14} />}>
            Audit
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Overview Tab ── */}
        <Tabs.Panel value="overview">
          {caps && (
            (server.stdioConfig?.executionMode === 'sandbox' && !caps.stdioSandbox.available)
            || ((server.aegis?.mode ?? 'off') !== 'off' && !caps.aegis.hookAvailable)
          ) ? (
            <Alert
              color="yellow"
              icon={<IconAlertTriangle size={16} />}
              title="Enterprise features inactive"
              mb="md"
            >
              {server.stdioConfig?.executionMode === 'sandbox' && !caps.stdioSandbox.available ? (
                <Text size="sm">
                  This server is configured for <b>persistent sandbox execution</b>, an Enterprise
                  feature that is not active on your current plan — it will not run until you upgrade
                  under Dashboard → License.
                </Text>
              ) : null}
              {(server.aegis?.mode ?? 'off') !== 'off' && !caps.aegis.hookAvailable ? (
                <Text size="sm" mt={server.stdioConfig?.executionMode === 'sandbox' && !caps.stdioSandbox.available ? 6 : 0}>
                  An <b>Aegis shield</b> is bound in <b>{server.aegis?.mode}</b> mode but will not
                  enforce without an active Enterprise plan.
                </Text>
              ) : null}
            </Alert>
          ) : null}

          {server.lastError ? (
            <Paper withBorder p="md" radius="md" mb="md" style={{ borderColor: 'var(--mantine-color-red-4)' }}>
              <Group gap="xs">
                <IconAlertTriangle size={16} color="var(--mantine-color-red-6)" />
                <Text size="sm" fw={600} c="red">Last runtime error</Text>
              </Group>
              <Text size="sm" c="dimmed" mt={4} style={{ wordBreak: 'break-word' }}>
                {server.lastError.message}
              </Text>
            </Paper>
          ) : null}

          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md" mb="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Status</Text>
              <Badge
                size="lg"
                variant="light"
                color={server.status === 'active' ? 'teal' : 'gray'}
                mt="xs"
              >
                {server.status === 'active' ? 'Active' : 'Disabled'}
              </Badge>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Tools</Text>
              <Text fw={700} size="xl" mt="xs">
                {(server.tools?.length ?? 0) - (server.disabledTools?.length ?? 0)}
                {server.disabledTools?.length ? (
                  <Text span size="sm" c="dimmed" fw={500}> of {server.tools?.length ?? 0} enabled</Text>
                ) : null}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Authentication</Text>
              <Text fw={500} size="sm" mt="xs">
                {AUTH_LABELS[server.upstreamAuth?.type] ?? 'None'}
              </Text>
            </Paper>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md" mb="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Tool Source</Text>
              <Badge size="lg" variant="light" color="grape" mt="xs">
                {SOURCE_LABELS[server.sourceType] ?? 'OpenAPI'}
              </Badge>
              <Text size="xs" c="dimmed" mt={6} ff="monospace" style={{ wordBreak: 'break-all' }}>
                {server.sourceType === 'remote'
                  ? server.remoteConfig?.url
                  : server.sourceType === 'stdio'
                    ? `${server.stdioConfig?.runtime ?? 'npx'} ${server.stdioConfig?.packageName ?? ''} · ${server.stdioConfig?.executionMode === 'sandbox' ? 'sandbox' : 'subprocess'}`
                    : server.upstreamBaseUrl || '—'}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Exposure</Text>
              <Group gap="xs" mt="xs">
                {(server.exposure?.protocols ?? ['streamable-http', 'sse']).map((p) => (
                  <Badge key={p} size="sm" variant="light" color="blue">
                    {p === 'streamable-http' ? 'Streamable HTTP' : 'SSE'}
                  </Badge>
                ))}
                <Badge
                  size="sm"
                  variant="light"
                  color={server.exposure?.accessMode === 'public' ? 'orange' : 'teal'}
                >
                  {server.exposure?.accessMode === 'public' ? 'Public URL' : 'API token'}
                </Badge>
              </Group>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Aegis Shield</Text>
              <Group gap="xs" mt="xs">
                <Badge
                  size="sm"
                  variant="light"
                  color={server.aegis?.mode === 'enforce' ? 'red' : server.aegis?.mode === 'monitor' ? 'yellow' : 'gray'}
                >
                  {server.aegis?.mode ?? 'off'}
                </Badge>
                {server.aegis?.shieldId ? (
                  <Code style={{ fontSize: 11 }}>{server.aegis.shieldId}</Code>
                ) : null}
              </Group>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Runtime Headers</Text>
              <Switch
                mt="xs"
                size="sm"
                label="Accept caller headers"
                checked={
                  (server.metadata?.runtimeHeaders as { allow?: boolean } | undefined)?.allow === true
                }
                onChange={async (event) => {
                  const allow = event.currentTarget.checked;
                  try {
                    const res = await fetch(`/api/mcp/${server.id}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ runtimeHeaders: allow ? { allow: true } : null }),
                    });
                    if (!res.ok) throw new Error('update failed');
                    const data = await res.json();
                    setServer(data.server);
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
                  <Text size="xs" c="dimmed" mt={4}>Based on today’s requests</Text>
                </>
              )}
            </Paper>
          </SimpleGrid>

          <Paper withBorder p="md" radius="md" mb="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">Top Tools</Text>
            {topTools.length === 0 ? (
              <Text size="sm" c="dimmed">No executions yet</Text>
            ) : (
              <Stack gap="xs">
                {topTools.map(([toolName, count]) => (
                  <Group key={toolName} justify="space-between" wrap="nowrap">
                    <Code>{toolName}</Code>
                    <Badge size="sm" variant="light" color="blue">{count} calls</Badge>
                  </Group>
                ))}
              </Stack>
            )}
          </Paper>

          <Paper withBorder p="md" radius="md" mb="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">Server Key</Text>
            <Group gap="sm">
              <Code>{server.key}</Code>
              <CopyButton value={server.key}>
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

          <Paper withBorder p="md" radius="md" mb="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">Upstream URL</Text>
            <Text size="sm">{server.upstreamBaseUrl || '—'}</Text>
          </Paper>

          <Paper withBorder p="md" radius="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="xs">Endpoint Slug</Text>
            <Code>{server.endpointSlug}</Code>
          </Paper>
        </Tabs.Panel>

        {/* ── Usage Tab ── */}
        <Tabs.Panel value="usage">
          <Stack gap="lg">
            {server.exposure?.accessMode === 'public' ? (
              <Paper withBorder p="lg" radius="md" style={{ borderColor: 'var(--mantine-color-orange-4)' }}>
                <Group gap="xs" mb="sm">
                  <Badge size="lg" variant="light" color="orange">Public access</Badge>
                  <Text fw={600} size="lg">Unauthenticated endpoint</Text>
                </Group>
                <Text size="sm" c="dimmed" mb="md">
                  This server is exposed on an unguessable public URL — no API token
                  required. Treat the URL like a webhook secret.
                </Text>
                <Text fw={600} size="sm" mb={4}>Streamable HTTP (JSON-RPC)</Text>
                <Group gap="sm" mb="md">
                  <Code block style={{ flex: 1 }}>
                    {`POST /api/public/mcp/${server.tenantId}/${server.endpointSlug}/message`}
                  </Code>
                  <CopyButton value={`/api/public/mcp/${server.tenantId}/${server.endpointSlug}/message`}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy URL'}>
                        <Button variant="subtle" size="compact-xs" color={copied ? 'teal' : 'gray'} onClick={copy}>
                          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                        </Button>
                      </Tooltip>
                    )}
                  </CopyButton>
                </Group>
                <Text fw={600} size="sm" mb={4}>SSE</Text>
                <Group gap="sm">
                  <Code block style={{ flex: 1 }}>
                    {`GET /api/public/mcp/${server.tenantId}/${server.endpointSlug}/sse`}
                  </Code>
                  <CopyButton value={`/api/public/mcp/${server.tenantId}/${server.endpointSlug}/sse`}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy URL'}>
                        <Button variant="subtle" size="compact-xs" color={copied ? 'teal' : 'gray'} onClick={copy}>
                          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                        </Button>
                      </Tooltip>
                    )}
                  </CopyButton>
                </Group>
              </Paper>
            ) : null}

            {/* SSE Transport (Primary) */}
            <Paper withBorder p="lg" radius="md">
              <Group gap="xs" mb="sm">
                <Badge size="lg" variant="light" color="blue">Recommended</Badge>
                <Text fw={600} size="lg">MCP SSE Transport</Text>
              </Group>
              <Text size="sm" c="dimmed" mb="md">
                The SSE (Server-Sent Events) transport is the standard way to connect to this MCP server.
                Compatible with all MCP clients including Claude Desktop, Cursor, and the official MCP SDK.
              </Text>

              <Text fw={600} size="sm" mb={4}>1. SSE Connection URL</Text>
              <Text size="sm" c="dimmed" mb="xs">
                The MCP client connects to this URL to open an SSE stream.
                The server will send an <Code>endpoint</Code> event containing
                the message URL for JSON-RPC communication.
              </Text>
              <Group gap="sm" mb="md">
                <Code block style={{ flex: 1 }}>
                  {`GET /api/client/v1/mcp/${server.key}/sse`}
                </Code>
                <CopyButton value={`/api/client/v1/mcp/${server.key}/sse`}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy URL'}>
                      <Button variant="subtle" size="compact-xs" color={copied ? 'teal' : 'gray'} onClick={copy}>
                        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                      </Button>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>

              <Text fw={600} size="sm" mb={4}>2. Message Endpoint</Text>
              <Text size="sm" c="dimmed" mb="xs">
                After connecting via SSE, the client sends JSON-RPC messages (such as <Code>tools/list</Code> and <Code>tools/call</Code>)
                via POST to the message endpoint. The session ID is provided automatically in the SSE <Code>endpoint</Code> event.
              </Text>
              <Code block mb="md">
                {`POST /api/client/v1/mcp/${server.key}/message?sessionId=<SESSION_ID>`}
              </Code>

              <Text fw={600} size="sm" mb={4}>3. Authentication</Text>
              <Text size="sm" c="dimmed" mb="sm">
                Include your Cognipeer API token in the <Code>Authorization</Code> header on both the SSE connection and all POST messages.
              </Text>
              <Code block mb="md">
                {`Authorization: Bearer YOUR_API_TOKEN`}
              </Code>

              <Text fw={600} size="sm" mb={4}>Protocol Flow</Text>
              <Code block>
{`1. Client  → GET  /api/client/v1/mcp/${server.key}/sse
             Header: Authorization: Bearer <token>

2. Server  → SSE event: "endpoint"
             data: /api/client/v1/mcp/${server.key}/message?sessionId=<id>

3. Client  → POST to the endpoint above
             { "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                 "protocolVersion": "2024-11-05",
                 "clientInfo": { "name": "my-client", "version": "1.0.0" },
                 "capabilities": {}
             }}

4. Server  → SSE event: "message"
             { "jsonrpc": "2.0", "id": 1, "result": {
                 "protocolVersion": "2024-11-05",
                 "capabilities": { "tools": {} },
                 "serverInfo": { "name": "cognipeer-mcp-gateway", "version": "1.0.0" }
             }}

5. Client  → POST { "jsonrpc":"2.0", "method": "notifications/initialized" }

6. Client  → POST { "jsonrpc":"2.0", "id":2, "method":"tools/list" }
   Server  → SSE  { "jsonrpc":"2.0", "id":2, "result": { "tools": [...] } }

7. Client  → POST { "jsonrpc":"2.0", "id":3, "method":"tools/call",
                     "params": { "name":"<tool>", "arguments": {...} } }
   Server  → SSE  { "jsonrpc":"2.0", "id":3, "result": {
                     "content": [{ "type":"text", "text":"..." }] } }`}
              </Code>
            </Paper>

            {/* Claude Desktop / Cursor Config */}
            <Paper withBorder p="lg" radius="md">
              <Text fw={600} size="lg" mb="xs">MCP Client Configuration</Text>
              <Text size="sm" c="dimmed" mb="md">
                Add this configuration to your MCP client. The examples below show
                configurations for Claude Desktop and Cursor.
              </Text>

              <Text fw={600} size="sm" mb={4}>Claude Desktop / Cursor <Code>mcp.json</Code></Text>
              <Code block>
{`{
  "mcpServers": {
    "${server.key}": {
      "url": "https://YOUR_GATEWAY_HOST/api/client/v1/mcp/${server.key}/sse",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}`}
              </Code>
            </Paper>

            {/* MCP SDK (TypeScript) */}
            <Paper withBorder p="lg" radius="md">
              <Text fw={600} size="lg" mb="xs">TypeScript MCP SDK</Text>
              <Text size="sm" c="dimmed" mb="md">
                Connect programmatically using the official <Code>@modelcontextprotocol/sdk</Code> package.
              </Text>
              <Code block>
{`import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(
  new URL("https://YOUR_GATEWAY_HOST/api/client/v1/mcp/${server.key}/sse"),
  {
    requestInit: {
      headers: {
        Authorization: "Bearer YOUR_API_TOKEN",
      },
    },
  },
);

const client = new Client({
  name: "my-app",
  version: "1.0.0",
});

await client.connect(transport);

// List tools
const { tools } = await client.listTools();
console.log(tools);

// Call a tool
const result = await client.callTool({
  name: "${server.tools?.[0]?.name ?? 'tool_name'}",
  arguments: { /* ... */ },
});
console.log(result);`}
              </Code>
            </Paper>

            {/* Python MCP SDK */}
            <Paper withBorder p="lg" radius="md">
              <Text fw={600} size="lg" mb="xs">Python MCP SDK</Text>
              <Text size="sm" c="dimmed" mb="md">
                Connect using the <Code>mcp</Code> Python package.
              </Text>
              <Code block>
{`from mcp.client.sse import sse_client
from mcp import ClientSession

async with sse_client(
    url="https://YOUR_GATEWAY_HOST/api/client/v1/mcp/${server.key}/sse",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
) as (read_stream, write_stream):
    async with ClientSession(read_stream, write_stream) as session:
        await session.initialize()

        # List tools
        tools = await session.list_tools()
        print(tools)

        # Call a tool
        result = await session.call_tool(
            "${server.tools?.[0]?.name ?? 'tool_name'}",
            arguments={},
        )
        print(result)`}
              </Code>
            </Paper>

            {/* REST (Direct) */}
            <Paper withBorder p="lg" radius="md">
              <Text fw={600} size="lg" mb="xs">REST (Direct Execution)</Text>
              <Text size="sm" c="dimmed" mb="md">
                You can also call tools directly without SSE using the REST endpoint.
                This is useful for simple one-off calls or testing.
              </Text>

              <Text fw={600} size="sm" mb={4}>Execute a tool</Text>
              <Code block mb="md">
{`curl -X POST https://YOUR_GATEWAY_HOST/api/client/v1/mcp/${server.key}/execute \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "tool": "${server.tools?.[0]?.name ?? 'tool_name'}",
    "arguments": {}
  }'`}
              </Code>

              <Text fw={600} size="sm" mb={4}>List available tools</Text>
              <Code block mb="md">
{`curl https://YOUR_GATEWAY_HOST/api/client/v1/mcp/${server.key}/execute \\
  -H "Authorization: Bearer YOUR_API_TOKEN"`}
              </Code>

              <Text fw={600} size="sm" mb={4}>Stateless JSON-RPC (no SSE)</Text>
              <Text size="sm" c="dimmed" mb="xs">
                The message endpoint also works without an SSE session — just omit the <Code>sessionId</Code> parameter
                and the response will be returned directly as HTTP JSON.
              </Text>
              <Code block>
{`curl -X POST https://YOUR_GATEWAY_HOST/api/client/v1/mcp/${server.key}/message \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'`}
              </Code>
            </Paper>
          </Stack>
        </Tabs.Panel>

        {/* ── Tools Tab ── */}
        <Tabs.Panel value="tools">
          <Group justify="space-between" mb="sm">
            <Text size="sm" c="dimmed">
              {server.sourceType !== 'openapi'
                ? `Tools discovered from the ${server.sourceType === 'remote' ? 'remote MCP server' : 'stdio package'}`
                : 'Tools imported from the OpenAPI spec'}
              {server.toolsDiscoveredAt
                ? ` · last discovery ${new Date(server.toolsDiscoveredAt).toLocaleString()}`
                : ''}
              {' '}· disabled tools are hidden from tools/list and rejected on execution
            </Text>
            {server.sourceType !== 'openapi' ? (
              <Button
                variant="default"
                size="xs"
                leftSection={<IconRefresh size={13} />}
                loading={refreshingTools}
                onClick={() => void handleRefreshTools()}
              >
                Update tools
              </Button>
            ) : null}
          </Group>
          <McpToolsPanel
            serverId={params.id}
            tools={server.tools ?? []}
            disabledTools={server.disabledTools ?? []}
            onServerUpdated={(s) => setServer(s as McpServerView & { openApiSpec?: string })}
          />
        </Tabs.Panel>

        {/* ── Playground Tab ── */}
        <Tabs.Panel value="playground">
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            <Paper withBorder radius="md" p="md">
              <Stack gap="md">
                <Text fw={600} size="sm">Try a tool</Text>
                <Select
                  label="Tool"
                  placeholder={enabledPgTools.length ? 'Select a tool to run' : 'No enabled tools available'}
                  disabled={!enabledPgTools.length}
                  data={enabledPgTools.map((t) => ({
                    value: t.name,
                    label: t.httpMethod && t.httpPath
                      ? `${t.name} · ${t.httpMethod} ${t.httpPath}`
                      : t.name,
                  }))}
                  value={pgTool}
                  onChange={(v) => {
                    setPgTool(v);
                    setPgArgs('{}');
                    setPgResult('');
                    setPgLatency(null);
                  }}
                  searchable
                />

                {selectedPgTool?.description && (
                  <Text size="sm" c="dimmed">{selectedPgTool.description}</Text>
                )}

                {server.sourceType === 'openapi' && pgTool ? (
                  <Text size="xs" c="dimmed">
                    Path/query params at top level; request body under a &quot;body&quot; key.
                  </Text>
                ) : null}

                {pgTool ? (
                  <McpToolArgsEditor
                    key={pgTool}
                    inputSchema={selectedPgTool?.inputSchema ?? null}
                    value={pgArgs}
                    onChange={setPgArgs}
                  />
                ) : null}

                <RuntimeContextEditor
                  value={runtimeContextJson}
                  onChange={setRuntimeContextJson}
                />

                <Group>
                  <Button
                    leftSection={<IconPlayerPlay size={14} />}
                    loading={pgRunning}
                    disabled={!pgTool}
                    onClick={handleRunPlayground}
                  >
                    Run
                  </Button>
                  {pgLatency !== null && (
                    <Badge variant="light" color="gray">{pgLatency} ms</Badge>
                  )}
                </Group>
              </Stack>
            </Paper>

            <Stack gap="md">
              {selectedPgTool?.inputSchema && (
                <Paper withBorder radius="md" p="md">
                  <Text fw={600} size="sm" mb="xs">Input schema</Text>
                  <Code block style={{ maxHeight: 220, overflow: 'auto', fontSize: 12 }}>
                    {JSON.stringify(selectedPgTool.inputSchema, null, 2)}
                  </Code>
                </Paper>
              )}
              <Paper withBorder radius="md" p="md">
                <Text fw={600} size="sm" mb="xs">Result</Text>
                {pgResult ? (
                  <Code block style={{ maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                    {pgResult}
                  </Code>
                ) : (
                  <Text size="sm" c="dimmed">Run a tool to see its response here.</Text>
                )}
              </Paper>
            </Stack>
          </SimpleGrid>
        </Tabs.Panel>

        {/* ── Logs Tab ── */}
        <Tabs.Panel value="logs">
          <Stack gap="md">
            <Paper withBorder radius="md" p="md">
              <Group align="flex-end" gap="sm" wrap="wrap">
                <TextInput
                  label="Keyword"
                  placeholder="Tool name or error message"
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

            <Paper withBorder radius="md" p={0} style={{ overflow: 'hidden' }}>
            {logsLoading ? (
              <Center p="xl">
                <Loader size="sm" />
              </Center>
            ) : logs.length === 0 ? (
              <Center p="xl">
                <Stack align="center" gap="xs">
                  <ThemeIcon size={40} radius="xl" variant="light" color="gray">
                    <IconList size={20} />
                  </ThemeIcon>
                  <Text c="dimmed" size="sm">No request logs yet</Text>
                  <Text c="dimmed" size="xs">
                    Logs will appear here once tools are executed via the API endpoint
                  </Text>
                </Stack>
              </Center>
            ) : (
              <Table horizontalSpacing="md" verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={64}>Detail</Table.Th>
                    <Table.Th>Tool</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Latency</Table.Th>
                    <Table.Th>Error</Table.Th>
                    <Table.Th>Time</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {logs.map((log) => {
                    const hasPayload = !!log.requestPayload || !!log.responsePayload;
                    return (
                      <Table.Tr
                        key={log.id}
                        onClick={() => hasPayload && setSelectedLog(log)}
                        style={{ cursor: hasPayload ? 'pointer' : 'default' }}
                      >
                        <Table.Td>
                          <Text size="xs" c={hasPayload ? 'blue' : 'dimmed'}>
                            {hasPayload ? 'View' : '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Code>{log.toolName}</Code>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4} wrap="nowrap">
                            <Badge
                              size="sm"
                              variant="light"
                              color={STATUS_COLORS[log.status] ?? 'gray'}
                            >
                              {log.status}
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
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">
                            {log.latencyMs !== undefined ? `${log.latencyMs}ms` : '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {log.errorMessage || '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {log.createdAt
                              ? new Date(log.createdAt).toLocaleString()
                              : '—'}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            )}
            </Paper>

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

        {/* ── Audit Tab ── */}
        <Tabs.Panel value="audit">
          <Paper withBorder radius="md" p={0} style={{ overflow: 'hidden' }}>
            {auditLoading ? (
              <Center p="xl"><Loader size="sm" /></Center>
            ) : auditLogs.length === 0 ? (
              <Center p="xl">
                <Text c="dimmed">No audit entries yet</Text>
              </Center>
            ) : (
              <Table horizontalSpacing="md" verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Time</Table.Th>
                    <Table.Th>Action</Table.Th>
                    <Table.Th>By</Table.Th>
                    <Table.Th>IP</Table.Th>
                    <Table.Th>Changes</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {auditLogs.map((entry, idx) => (
                    <Table.Tr key={entry._id ?? idx}>
                      <Table.Td>
                        <Text size="xs" ff="monospace" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                          {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color={
                          entry.action === 'delete' ? 'red'
                            : entry.action === 'secrets_change' ? 'orange'
                              : entry.action === 'create' ? 'teal'
                                : 'blue'
                        }>
                          {entry.action.replace(/_/g, ' ')}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">{entry.performedBy}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace" c="dimmed">{entry.ipAddress ?? '—'}</Text>
                      </Table.Td>
                      <Table.Td>
                        {entry.changes && Object.keys(entry.changes).length ? (
                          <Tooltip
                            multiline
                            maw={420}
                            label={<pre style={{ margin: 0, fontSize: 11 }}>{JSON.stringify(entry.changes, null, 2)}</pre>}
                          >
                            <Text size="xs" c="dimmed" style={{ cursor: 'help' }}>
                              {Object.keys(entry.changes).join(', ')}
                            </Text>
                          </Tooltip>
                        ) : (
                          <Text size="xs" c="dimmed">—</Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Paper>
        </Tabs.Panel>

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
              <Text size="sm" c="dimmed">Tool:</Text>
              <Code>{selectedLog.toolName}</Code>
              <Badge size="sm" variant="light" color={STATUS_COLORS[selectedLog.status] ?? 'gray'}>
                {selectedLog.status}
              </Badge>
            </Group>

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

      </Tabs>
      </DetailShell>

      <FormShell
        open={editOpen}
        onClose={() => setEditOpen(false)}
        icon={<IconPlugConnected size={16} stroke={1.7} />}
        title="Edit MCP server"
        subtitle={
          <>
            {SOURCE_LABELS[server.sourceType ?? 'openapi'] ?? 'MCP server'}
            {' · '}
            <span className="ds-mono">{server.key}</span>
          </>
        }
        primaryAction={{
          label: 'Save changes',
          icon: <IconCheck size={13} />,
          loading: saving,
          onClick: handleSave,
        }}
      >
        <FormSection
          number={1}
          title="Identity"
          description="How this MCP server is identified across the console."
        >
          <FormRow cols={1}>
            <FormField label="Name" required>
              <TextInput placeholder="My API Service" {...form.getInputProps('name')} />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="Description" optional>
              <Textarea
                placeholder="Brief description of what this MCP server does"
                minRows={2}
                autosize
                {...form.getInputProps('description')}
              />
            </FormField>
          </FormRow>
        </FormSection>

        <FormSection
          number={2}
          title="Tool source"
          description="Where this server's tools are discovered from."
        >
          {server.sourceType === 'openapi' ? (
            <>
              <FormRow cols={1}>
                <FormField label="Upstream base URL" optional>
                  <TextInput
                    placeholder="https://api.example.com"
                    {...form.getInputProps('upstreamBaseUrl')}
                  />
                </FormField>
              </FormRow>
              <FormRow cols={1}>
                <FormField
                  label="OpenAPI specification"
                  hint="Paste, upload, or re-fetch the spec from a URL to refresh the available tools. Saving re-imports the tool list."
                >
                  <SpecImportField
                    value={form.values.openApiSpec}
                    onChange={(val) => form.setFieldValue('openApiSpec', val)}
                    format={form.values.specFormat}
                    onFormatChange={(val) => form.setFieldValue('specFormat', val)}
                    minRows={10}
                  />
                </FormField>
              </FormRow>
            </>
          ) : null}

          {server.sourceType === 'remote' ? (
            <>
              <FormRow cols={1}>
                <FormField
                  label="MCP server URL"
                  required
                  hint="Changing the URL re-discovers the tool list."
                >
                  <TextInput
                    placeholder="https://mcp.example.com/mcp"
                    {...form.getInputProps('remoteUrl')}
                  />
                </FormField>
              </FormRow>
              <FormRow cols={1}>
                <FormField label="Upstream transport">
                  <Select
                    data={[
                      { value: 'streamable-http', label: 'Streamable HTTP' },
                      { value: 'sse', label: 'SSE (legacy)' },
                    ]}
                    {...form.getInputProps('remoteTransport')}
                  />
                </FormField>
              </FormRow>
            </>
          ) : null}

          {server.sourceType === 'stdio' ? (
            <>
              <FormRow cols={2}>
                <FormField label="Runtime">
                  <Select
                    data={[
                      { value: 'npx', label: 'npx (Node)' },
                      { value: 'uvx', label: 'uvx (Python)' },
                    ]}
                    {...form.getInputProps('stdioRuntime')}
                  />
                </FormField>
                <FormField label="Package" required>
                  <TextInput
                    placeholder="@modelcontextprotocol/server-everything"
                    {...form.getInputProps('stdioPackage')}
                  />
                </FormField>
              </FormRow>
              <FormRow cols={1}>
                <FormField
                  label="Arguments"
                  optional
                  hint="Space-separated arguments passed to the package."
                >
                  <TextInput placeholder="--flag value" {...form.getInputProps('stdioArgs')} />
                </FormField>
              </FormRow>
              <FormRow cols={1}>
                <FormField
                  label="Environment variables"
                  optional
                  hint="One KEY=value per line. Masked values (••••••) keep the stored secret; changing the config re-discovers the tool list."
                >
                  <Textarea
                    placeholder={'API_KEY=sk-...\nBASE_URL=https://api.example.com'}
                    minRows={2}
                    autosize
                    styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                    {...form.getInputProps('stdioEnv')}
                  />
                </FormField>
              </FormRow>
            </>
          ) : null}
        </FormSection>

        {server.sourceType !== 'stdio' ? (
          <FormSection
            number={3}
            title="Upstream authentication"
            description="Credentials the gateway uses when calling the upstream service."
          >
            <FormRow cols={1}>
              <FormField label="Authentication type">
                <Select
                  data={[
                    { value: 'none', label: 'No authentication' },
                    { value: 'token', label: 'Bearer Token' },
                    { value: 'header', label: 'Custom Header' },
                    { value: 'basic', label: 'Basic Auth' },
                  ]}
                  {...form.getInputProps('authType')}
                />
              </FormField>
            </FormRow>

            {form.values.authType === 'token' && (
              <FormRow cols={1}>
                <FormField label="Bearer token" hint="Keep the masked value to preserve the current token, or type a new one to replace it.">
                  <PasswordInput {...form.getInputProps('authToken')} />
                </FormField>
              </FormRow>
            )}

            {form.values.authType === 'header' && (
              <FormRow cols={2}>
                <FormField label="Header name">
                  <TextInput {...form.getInputProps('authHeaderName')} />
                </FormField>
                <FormField label="Header value" hint="Keep the masked value to preserve the current value, or type a new one to replace it.">
                  <PasswordInput {...form.getInputProps('authHeaderValue')} />
                </FormField>
              </FormRow>
            )}

            {form.values.authType === 'basic' && (
              <FormRow cols={2}>
                <FormField label="Username">
                  <TextInput {...form.getInputProps('authUsername')} />
                </FormField>
                <FormField label="Password" hint="Keep the masked value to preserve the current password, or type a new one to replace it.">
                  <PasswordInput {...form.getInputProps('authPassword')} />
                </FormField>
              </FormRow>
            )}
          </FormSection>
        ) : null}
      </FormShell>

      {/* Delete confirmation modal */}
      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete MCP Server"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{server.name}</strong>?
          This will remove the endpoint and all request logs. This action cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={handleDelete}>Delete</Button>
        </Group>
      </Modal>
    </>
  );
}
