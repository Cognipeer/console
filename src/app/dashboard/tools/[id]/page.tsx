'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Badge,
  Box,
  Button,
  Center,
  Code,
  CopyButton,
  Divider,
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
  Table,
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
  IconApi,
  IconCloud,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import type { ToolView, ToolRequestLogView } from '@/lib/services/tools';
import type { IToolAction } from '@/lib/database';

// ── Constants ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  active: 'teal',
  disabled: 'gray',
  success: 'teal',
  error: 'red',
};

const TYPE_LABELS: Record<string, string> = {
  openapi: 'OpenAPI',
  mcp: 'MCP',
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

  const curlListTools = `curl -X GET "https://your-cognipeer-host/api/client/v1/tools" \\
  -H "Authorization: Bearer YOUR_API_TOKEN"`;

  const curlGetTool = `curl -X GET "https://your-cognipeer-host/api/client/v1/tools/${tool.key}" \\
  -H "Authorization: Bearer YOUR_API_TOKEN"`;

  const curlExecute = `curl -X POST "https://your-cognipeer-host/api/client/v1/tools/${tool.key}/actions/${actionKey}/execute" \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "arguments": {
      "param": "value"
    }
  }'`;

  const sdkTypeScript = `import { ConsoleClient } from '@cognipeer/console-sdk';

const client = new ConsoleClient({
  apiKey: 'YOUR_API_TOKEN',
  baseURL: 'https://your-cognipeer-host',
});

// List all tools
const tools = await client.tools.list();
console.log(\`Found \${tools.length} tools\`);

// Get tool details
const tool = await client.tools.get('${tool.key}');
console.log(\`Tool: \${tool.name}, Actions: \${tool.actions.length}\`);

// Execute an action
const result = await client.tools.execute(
  '${tool.key}',
  '${actionKey}',
  { param: 'value' },
);
console.log('Result:', result);

// Convert to agent-sdk compatible tools
const agentTools = await client.tools.toAgentTools('${tool.key}');
// Pass agentTools directly to createAgent({ tools: agentTools })`;

  const sdkPython = `import httpx

BASE_URL = "https://your-cognipeer-host"
API_TOKEN = "YOUR_API_TOKEN"
headers = {"Authorization": f"Bearer {API_TOKEN}"}

# List all tools
resp = httpx.get(f"{BASE_URL}/api/client/v1/tools", headers=headers)
tools = resp.json()["tools"]
for t in tools:
    print(f"  {t['name']} ({t['key']}): {len(t.get('actions', []))} actions")

# Get tool details
resp = httpx.get(f"{BASE_URL}/api/client/v1/tools/${tool.key}", headers=headers)
tool = resp.json()["tool"]

# Execute an action
resp = httpx.post(
    f"{BASE_URL}/api/client/v1/tools/${tool.key}/actions/${actionKey}/execute",
    headers=headers,
    json={"arguments": {"param": "value"}},
)
result = resp.json()
print(f"Result: {result['result']}")
print(f"Latency: {result['latencyMs']}ms")`;

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

      {/* Base URL */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Base Endpoint</Text>
        <Code block fz="xs">{`/api/client/v1/tools/${tool.key}`}</Code>
        <Text size="xs" c="dimmed" mt="sm">
          Endpoints: <Code fz="xs">GET /tools</Code>{' '}
          <Code fz="xs">GET /tools/:toolKey</Code>{' '}
          <Code fz="xs">POST /tools/:toolKey/actions/:actionKey/execute</Code>
        </Text>
      </Paper>

      {/* cURL — list tools */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">cURL — List Tools</Text>
        <Text size="xs" c="dimmed" mb="sm">
          Replace <Code fz="xs">YOUR_API_TOKEN</Code> with a valid API token from Settings.
        </Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={curlListTools} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs">{curlListTools}</Code>
        </Box>
      </Paper>

      {/* cURL — get tool */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">cURL — Get Tool Details</Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={curlGetTool} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs">{curlGetTool}</Code>
        </Box>
      </Paper>

      {/* cURL — execute action */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">cURL — Execute Action</Text>
        <Text size="xs" c="dimmed" mb="sm">
          Pass action arguments as a JSON object in <Code fz="xs">arguments</Code>.
        </Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={curlExecute} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs">{curlExecute}</Code>
        </Box>
      </Paper>

      <Divider label="SDK Examples" labelPosition="center" />

      {/* TypeScript SDK */}
      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" mb="xs">
          <Text fw={600}>TypeScript / Node.js SDK</Text>
          <Badge size="sm" variant="light" color="blue">@cognipeer/console-sdk</Badge>
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          Install: <Code fz="xs">npm install @cognipeer/console-sdk</Code>
        </Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={sdkTypeScript} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs" style={{ maxHeight: 400, overflow: 'auto' }}>{sdkTypeScript}</Code>
        </Box>
      </Paper>

      {/* Python */}
      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" mb="xs">
          <Text fw={600}>Python</Text>
          <Badge size="sm" variant="light" color="yellow">httpx</Badge>
        </Group>
        <Text size="xs" c="dimmed" mb="sm">
          Install: <Code fz="xs">pip install httpx</Code>
        </Text>
        <Box style={{ position: 'relative' }}>
          <CopyButton value={sdkPython} timeout={2000}>
            {({ copied, copy }) => (
              <Button size="xs" variant={copied ? 'filled' : 'outline'} color={copied ? 'teal' : 'gray'}
                leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                onClick={copy}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            )}
          </CopyButton>
          <Code block fz="xs" style={{ maxHeight: 400, overflow: 'auto' }}>{sdkPython}</Code>
        </Box>
      </Paper>

      {/* Response format */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="xs">Execute Response Format</Text>
        <Code block fz="xs">{`{
  "result": { ... },
  "latencyMs": 245,
  "toolKey": "${tool.key}",
  "actionKey": "${actionKey}"
}`}</Code>
      </Paper>
    </Stack>
  );
}

// ── Component ────────────────────────────────────────────────────────────

export default function ToolDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
          router.push('/dashboard/tools');
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
    setDeleting(true);
    try {
      const res = await fetch(`/api/tools/${params.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${tool?.name}" was deleted`, color: 'red' });
      router.push('/dashboard/tools');
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
        body: JSON.stringify({ arguments: args }),
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

  return (
    <>
      <PageHeader
        icon={tool.type === 'openapi' ? <IconApi size={20} /> : <IconCloud size={20} />}
        title={tool.name}
        subtitle={tool.description || 'No description'}
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/tools')}
            >
              Back
            </Button>
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
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          </Group>
        }
      />

      {/* Metadata cards */}
      <Group gap="xs" mb="md">
        <Badge variant="light" color={STATUS_COLORS[tool.status] ?? 'gray'}>
          {tool.status === 'active' ? 'Active' : 'Disabled'}
        </Badge>
        <Badge variant="light" color={tool.type === 'openapi' ? 'indigo' : 'violet'}>
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
            Test
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
        </Tabs.Panel>

        {/* ── Actions Tab ── */}
        <Tabs.Panel value="actions">
          {tool.actions.length === 0 ? (
            <Paper withBorder radius="md" p="xl">
              <Stack align="center" gap="sm">
                <ThemeIcon size={40} variant="light" color="gray" radius="xl">
                  <IconTool size={20} />
                </ThemeIcon>
                <Text c="dimmed" size="sm">No actions discovered yet. Try syncing.</Text>
              </Stack>
            </Paper>
          ) : (
            <Paper withBorder radius="md">
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Action Key</Table.Th>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Description</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Method / Path</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {tool.actions.map((action) => (
                    <Table.Tr
                      key={action.key}
                      onClick={() => setSelectedAction(action)}
                      style={{ cursor: 'pointer' }}
                    >
                      <Table.Td>
                        <Code>{action.key}</Code>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={500}>{action.name}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" lineClamp={2}>{action.description}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="xs" variant="light" color={action.executionType === 'openapi_http' ? 'indigo' : 'violet'}>
                          {action.executionType === 'openapi_http' ? 'HTTP' : 'MCP'}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        {action.httpMethod && action.httpPath ? (
                          <Text size="xs" ff="monospace">
                            {action.httpMethod} {action.httpPath}
                          </Text>
                        ) : action.mcpToolName ? (
                          <Text size="xs" ff="monospace">{action.mcpToolName}</Text>
                        ) : (
                          <Text size="xs" c="dimmed">—</Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Paper>
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
                      Logs will appear here once tool actions are executed
                    </Text>
                  </Stack>
                </Center>
              ) : (
                <Table horizontalSpacing="md" verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th w={64}>Detail</Table.Th>
                      <Table.Th>Action</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th>Latency</Table.Th>
                      <Table.Th>Caller</Table.Th>
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
                            <Code>{log.actionName || log.actionKey}</Code>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              size="sm"
                              variant="light"
                              color={STATUS_COLORS[log.status] ?? 'gray'}
                            >
                              {log.status}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">
                              {log.latencyMs !== undefined ? `${log.latencyMs}ms` : '—'}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge size="xs" variant="light" color="gray">
                              {log.callerType || 'unknown'}
                            </Badge>
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
                <Badge size="sm" variant="light" color={selectedAction.executionType === 'openapi_http' ? 'indigo' : 'violet'}>
                  {selectedAction.executionType === 'openapi_http' ? 'HTTP (OpenAPI)' : 'MCP Call'}
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

      {/* ── Edit Modal ── */}
      <Modal
        opened={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit Tool"
        centered
        size="lg"
      >
        <Stack gap="md">
          <TextInput label="Name" required {...form.getInputProps('name')} />
          <Textarea label="Description" rows={2} {...form.getInputProps('description')} />

          {tool.type === 'openapi' && (
            <TextInput
              label="Upstream Base URL"
              placeholder="https://api.example.com"
              {...form.getInputProps('upstreamBaseUrl')}
            />
          )}

          {tool.type === 'mcp' && (
            <>
              <TextInput
                label="MCP Endpoint"
                placeholder="https://mcp-server.example.com/mcp"
                {...form.getInputProps('mcpEndpoint')}
              />
              <Select
                label="Transport"
                data={[
                  { value: 'streamable-http', label: 'Streamable HTTP' },
                  { value: 'sse', label: 'SSE' },
                ]}
                {...form.getInputProps('mcpTransport')}
              />
            </>
          )}

          <Select
            label="Update Authentication"
            description="Leave as 'None' to keep existing auth unchanged"
            data={[
              { value: 'none', label: 'None (keep existing)' },
              { value: 'token', label: 'Bearer Token' },
              { value: 'header', label: 'Custom Header' },
              { value: 'basic', label: 'Basic Auth' },
            ]}
            {...form.getInputProps('authType')}
          />

          {form.values.authType === 'token' && (
            <PasswordInput label="Bearer Token" {...form.getInputProps('authToken')} />
          )}
          {form.values.authType === 'header' && (
            <>
              <TextInput label="Header Name" {...form.getInputProps('authHeaderName')} />
              <PasswordInput label="Header Value" {...form.getInputProps('authHeaderValue')} />
            </>
          )}
          {form.values.authType === 'basic' && (
            <>
              <TextInput label="Username" {...form.getInputProps('authUsername')} />
              <PasswordInput label="Password" {...form.getInputProps('authPassword')} />
            </>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button loading={saving} onClick={handleSave}>Save</Button>
          </Group>
        </Stack>
      </Modal>

      {/* Delete Confirmation */}
      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete Tool"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{tool.name}</strong>?
          Agents referencing this tool will lose access to its actions. This cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={handleDelete}>Delete</Button>
        </Group>
      </Modal>
    </>
  );
}
