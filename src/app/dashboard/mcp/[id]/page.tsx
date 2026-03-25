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
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconApi,
  IconArrowLeft,
  IconCheck,
  IconChartBar,
  IconCode,
  IconCopy,
  IconList,
  IconPlugConnected,
  IconTrash,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import type { McpServerView, McpRequestLogView } from '@/lib/services/mcp';

const AUTH_LABELS: Record<string, string> = {
  none: 'None',
  token: 'Bearer Token',
  header: 'Custom Header',
  basic: 'Basic Auth',
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
  const initialTab = ['overview', 'usage', 'tools', 'logs'].includes(tabParam ?? '')
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

      form.setValues({
        name: data.server.name || '',
        description: data.server.description || '',
        upstreamBaseUrl: data.server.upstreamBaseUrl || '',
        authType: data.server.upstreamAuth?.type || 'none',
        authToken: '',
        authHeaderName: data.server.upstreamAuth?.headerName || '',
        authHeaderValue: '',
        authUsername: data.server.upstreamAuth?.username || '',
        authPassword: '',
        openApiSpec: data.server.openApiSpec || '',
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
      const update: Record<string, unknown> = {
        name: values.name,
        description: values.description || undefined,
        upstreamBaseUrl: values.upstreamBaseUrl || undefined,
      };

      // Only update auth if values were touched
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

      // Update spec if changed
      if (values.openApiSpec && values.openApiSpec !== server?.openApiSpec) {
        update.openApiSpec = values.openApiSpec;
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

  return (
    <>
      <PageHeader
        icon={<IconApi size={20} />}
        title={server.name}
        subtitle={server.description || `Key: ${server.key}`}
        actions={
          <Group gap="sm">
            <Button
              variant="default"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
              onClick={() => router.push('/dashboard/mcp')}
            >
              Back
            </Button>
            <Button
              variant="default"
              size="xs"
              onClick={() => setEditOpen(true)}
            >
              Edit
            </Button>
            <Button
              color="red"
              variant="light"
              size="xs"
              leftSection={<IconTrash size={14} />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          </Group>
        }
      />

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v || 'overview')}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview" leftSection={<IconChartBar size={14} />}>
            Overview
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconPlugConnected size={14} />}>
            Usage
          </Tabs.Tab>
          <Tabs.Tab value="tools" leftSection={<IconCode size={14} />}>
            Tools ({server.tools?.length ?? 0})
          </Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<IconList size={14} />}>
            Request Logs
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
                color={server.status === 'active' ? 'teal' : 'gray'}
                mt="xs"
              >
                {server.status === 'active' ? 'Active' : 'Disabled'}
              </Badge>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Tools</Text>
              <Text fw={700} size="xl" mt="xs">{server.tools?.length ?? 0}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Authentication</Text>
              <Text fw={500} size="sm" mt="xs">
                {AUTH_LABELS[server.upstreamAuth?.type] ?? 'None'}
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
          <Paper withBorder radius="md" p={0} style={{ overflow: 'hidden' }}>
            {!server.tools?.length ? (
              <Center p="xl">
                <Text c="dimmed">No tools found in the specification</Text>
              </Center>
            ) : (
              <Table horizontalSpacing="md" verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Method</Table.Th>
                    <Table.Th>Path</Table.Th>
                    <Table.Th>Description</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {server.tools.map((tool) => (
                    <Table.Tr key={tool.name}>
                      <Table.Td>
                        <Code>{tool.name}</Code>
                      </Table.Td>
                      <Table.Td>
                        <Badge size="sm" variant="light" color="blue">
                          {tool.httpMethod}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace">{tool.httpPath}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" lineClamp={1}>
                          {tool.description || '—'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Paper>
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

      <Modal
        opened={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit MCP Server"
        centered
        size="lg"
      >
        <Stack gap="md">
          <TextInput
            label="Name"
            required
            {...form.getInputProps('name')}
          />

          <Textarea
            label="Description"
            rows={2}
            {...form.getInputProps('description')}
          />

          <TextInput
            label="Upstream Base URL"
            placeholder="https://api.example.com"
            {...form.getInputProps('upstreamBaseUrl')}
          />

          <Select
            label="Authentication Type"
            data={[
              { value: 'none', label: 'No authentication' },
              { value: 'token', label: 'Bearer Token' },
              { value: 'header', label: 'Custom Header' },
              { value: 'basic', label: 'Basic Auth' },
            ]}
            {...form.getInputProps('authType')}
          />

          {form.values.authType === 'token' && (
            <PasswordInput
              label="Bearer Token"
              description="Leave empty to keep the current token"
              {...form.getInputProps('authToken')}
            />
          )}

          {form.values.authType === 'header' && (
            <>
              <TextInput
                label="Header Name"
                {...form.getInputProps('authHeaderName')}
              />
              <PasswordInput
                label="Header Value"
                description="Leave empty to keep the current value"
                {...form.getInputProps('authHeaderValue')}
              />
            </>
          )}

          {form.values.authType === 'basic' && (
            <>
              <TextInput
                label="Username"
                {...form.getInputProps('authUsername')}
              />
              <PasswordInput
                label="Password"
                description="Leave empty to keep the current password"
                {...form.getInputProps('authPassword')}
              />
            </>
          )}

          <Box>
            <JsonInput
              label="OpenAPI Specification"
              description="Edit the JSON spec to update available tools"
              minRows={8}
              maxRows={16}
              autosize
              formatOnBlur
              {...form.getInputProps('openApiSpec')}
            />
          </Box>

          <Group justify="flex-end" mt="sm">
            <Button variant="default" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button loading={saving} onClick={handleSave}>
              Save Changes
            </Button>
          </Group>
        </Stack>
      </Modal>

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
