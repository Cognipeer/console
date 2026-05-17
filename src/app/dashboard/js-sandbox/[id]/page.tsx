'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  CopyButton,
  Group,
  JsonInput,
  Loader,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
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
  IconCode,
  IconCopy,
  IconPlayerPlay,
  IconRefresh,
} from '@tabler/icons-react';
import DetailShell from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import type {
  JsSandboxExecutionView,
  JsSandboxRuntimeView,
} from '@/lib/services/jsSandbox/types';

interface LibraryDescriptor {
  key: string;
  label: string;
  description: string;
}

interface SettingsForm {
  name: string;
  description: string;
  status: 'active' | 'disabled';
  libraries: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  memoryLimitMb: number;
  maxCodeSizeBytes: number;
  maxResultSizeBytes: number;
  maxLogEntries: number;
}

const DEFAULT_CODE = `const items = input.items ?? [];
console.log('Processing', items.length, 'items');

return items
  .filter((item) => item.status === 'paid')
  .map((item) => ({ id: item.id, total: item.quantity * item.price }));`;

const DEFAULT_INPUT = JSON.stringify({
  items: [
    { id: 'ord_1', status: 'paid', quantity: 2, price: 12 },
    { id: 'ord_2', status: 'draft', quantity: 1, price: 30 },
    { id: 'ord_3', status: 'paid', quantity: 3, price: 8 },
  ],
}, null, 2);

export default function JsSandboxDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const runtimeId = params.id;
  const [runtime, setRuntime] = useState<JsSandboxRuntimeView | null>(null);
  const [executions, setExecutions] = useState<JsSandboxExecutionView[]>([]);
  const [libraries, setLibraries] = useState<LibraryDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') ?? 'playground');
  const [code, setCode] = useState(DEFAULT_CODE);
  const [inputJson, setInputJson] = useState(DEFAULT_INPUT);
  const [timeoutMs, setTimeoutMs] = useState<number | ''>('');
  const [lastExecution, setLastExecution] = useState<JsSandboxExecutionView | null>(null);

  const settingsForm = useForm<SettingsForm>({
    initialValues: {
      name: '',
      description: '',
      status: 'active',
      libraries: [],
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 30_000,
      memoryLimitMb: 64,
      maxCodeSizeBytes: 64 * 1024,
      maxResultSizeBytes: 512 * 1024,
      maxLogEntries: 100,
    },
    validate: {
      name: (value) => (value.trim().length < 2 ? 'Name is required' : null),
      maxTimeoutMs: (value, values) =>
        value < values.defaultTimeoutMs ? 'Max timeout must be greater than default timeout' : null,
    },
  });

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runtimeRes, executionsRes, librariesRes] = await Promise.all([
        fetch(`/api/js-sandbox/runtimes/${encodeURIComponent(runtimeId)}`, { cache: 'no-store' }),
        fetch(`/api/js-sandbox/executions?runtimeId=${encodeURIComponent(runtimeId)}&limit=25`, { cache: 'no-store' }),
        fetch('/api/js-sandbox/libraries', { cache: 'no-store' }),
      ]);
      if (!runtimeRes.ok) throw new Error('Failed to load JS runtime');
      const runtimeBody = (await runtimeRes.json()) as { runtime?: JsSandboxRuntimeView };
      const nextRuntime = runtimeBody.runtime ?? null;
      setRuntime(nextRuntime);
      if (nextRuntime) {
        settingsForm.setValues({
          name: nextRuntime.name,
          description: nextRuntime.description ?? '',
          status: nextRuntime.status,
          libraries: nextRuntime.libraries,
          defaultTimeoutMs: nextRuntime.limits.defaultTimeoutMs,
          maxTimeoutMs: nextRuntime.limits.maxTimeoutMs,
          memoryLimitMb: nextRuntime.limits.memoryLimitMb,
          maxCodeSizeBytes: nextRuntime.limits.maxCodeSizeBytes,
          maxResultSizeBytes: nextRuntime.limits.maxResultSizeBytes,
          maxLogEntries: nextRuntime.limits.maxLogEntries,
        });
        settingsForm.resetDirty();
        setTimeoutMs('');
      }
      if (executionsRes.ok) {
        const executionsBody = (await executionsRes.json()) as { executions?: JsSandboxExecutionView[] };
        setExecutions(executionsBody.executions ?? []);
      }
      if (librariesRes.ok) {
        const librariesBody = (await librariesRes.json()) as { libraries?: LibraryDescriptor[] };
        setLibraries(librariesBody.libraries ?? []);
      }
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to load JS runtime',
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  // Mantine form instance is intentionally not a dependency; `load` repopulates it from the API response.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeId]);

  useEffect(() => {
    load();
  }, [load]);

  const usageSnippet = useMemo(() => {
    const id = runtime?.key ?? runtimeId;
    return `curl -X POST "$CONSOLE_URL/api/client/v1/js-sandbox/execute" \\
  -H "Authorization: Bearer $CONSOLE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsRuntimeId": "${id}",
    "code": "return input.a + input.b",
    "input": { "a": 2, "b": 3 }
  }'`;
  }, [runtime?.key, runtimeId]);

  const sdkSnippet = useMemo(() => {
    const id = runtime?.key ?? runtimeId;
    return `const response = await fetch('/api/client/v1/js-sandbox/execute', {
  method: 'POST',
  headers: {
    authorization: \`Bearer \${process.env.CONSOLE_API_KEY}\`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    jsRuntimeId: '${id}',
    code: 'return libs.math.sum(input.items, "price")',
    input: { items: [{ price: 12 }, { price: 8 }] },
  }),
});

const output = await response.json();`;
  }, [runtime?.key, runtimeId]);

  async function handleExecute() {
    if (!runtime) return;
    setExecuting(true);
    try {
      let input: unknown;
      try {
        input = inputJson.trim() ? JSON.parse(inputJson) : undefined;
      } catch {
        throw new Error('Input must be valid JSON');
      }

      const res = await fetch(`/api/js-sandbox/runtimes/${encodeURIComponent(runtime.id)}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          input,
          timeoutMs: timeoutMs === '' ? undefined : timeoutMs,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Execution failed');
      const execution = body.execution as JsSandboxExecutionView;
      setLastExecution(execution);
      setExecutions((current) => [execution, ...current].slice(0, 25));
      notifications.show({
        color: execution.status === 'success' ? 'teal' : 'orange',
        title: execution.status === 'success' ? 'Execution complete' : 'Execution finished with error',
        message: `${execution.durationMs} ms`,
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to execute code',
      });
    } finally {
      setExecuting(false);
    }
  }

  async function handleSave(values: SettingsForm) {
    if (!runtime) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/js-sandbox/runtimes/${encodeURIComponent(runtime.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: values.name.trim(),
          description: values.description.trim() || undefined,
          status: values.status,
          libraries: values.libraries,
          limits: {
            defaultTimeoutMs: values.defaultTimeoutMs,
            maxTimeoutMs: values.maxTimeoutMs,
            memoryLimitMb: values.memoryLimitMb,
            maxCodeSizeBytes: values.maxCodeSizeBytes,
            maxResultSizeBytes: values.maxResultSizeBytes,
            maxLogEntries: values.maxLogEntries,
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to save runtime');
      setRuntime(body.runtime as JsSandboxRuntimeView);
      settingsForm.resetDirty();
      notifications.show({ color: 'teal', title: 'Saved', message: 'JS runtime updated' });
      await load();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to save runtime',
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Paper withBorder p="xl" radius="lg">
        <Group justify="center">
          <Loader size="sm" />
        </Group>
      </Paper>
    );
  }

  if (!runtime) {
    return (
      <PageContainer>
        <Stack gap="md">
          <PageHeader title="JS runtime not found" actions={<Button component={Link} href="/dashboard/js-sandbox" variant="default">Back</Button>} />
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>The requested JS runtime could not be found.</Alert>
        </Stack>
      </PageContainer>
    );
  }

  const tabs = [
    { id: 'playground', label: 'Playground' },
    { id: 'usage', label: 'Usage' },
    { id: 'executions', label: 'Executions', count: executions.length },
    { id: 'settings', label: 'Settings' },
  ];

  const actions = (
    <Button
      variant="default"
      size="sm"
      leftSection={<IconRefresh size={14} stroke={1.7} />}
      onClick={() => load()}
      loading={refreshing}
    >
      Refresh
    </Button>
  );

  return (
    <DetailShell
      backHref="/dashboard/js-sandbox"
      backLabel="Back to JS sandbox"
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
          <IconCode size={22} stroke={1.7} />
        </div>
      }
      title={
        <>
          <h1 className="ds-h2" style={{ margin: 0, whiteSpace: 'nowrap' }}>
            {runtime.name}
          </h1>
          <StatusBadge
            status={runtime.status === 'active' ? 'ok' : 'paused'}
            label={runtime.status}
          />
          <span className="ds-badge ds-badge-info">{runtime.engine}</span>
        </>
      }
      meta={
        <>
          <span className="ds-mono">{runtime.key}</span>
          <span className="ds-faint">·</span>
          <span>engine: <span className="ds-mono">{runtime.engine}</span></span>
          <span className="ds-faint">·</span>
          <span>{runtime.libraries.length} libraries</span>
          <span className="ds-faint">·</span>
          <span>{runtime.limits.defaultTimeoutMs} ms timeout</span>
        </>
      }
      actions={actions}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Summary label="Status" value={runtime.status} color={runtime.status === 'active' ? 'teal' : 'gray'} />
        <Summary label="Timeout" value={`${runtime.limits.defaultTimeoutMs} ms`} color="indigo" />
        <Summary label="Memory" value={`${runtime.limits.memoryLimitMb} MB`} color="blue" />
        <Summary label="Libraries" value={String(runtime.libraries.length)} color="gray" />
      </SimpleGrid>

      {activeTab === 'playground' ? (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <Stack gap="md">
            <Paper withBorder p="md" radius="lg">
              <Stack gap="sm">
                <Group justify="space-between">
                  <Text fw={600}>Code</Text>
                  <Group gap={6}>
                    {runtime.libraries.map((library: string) => (
                      <Badge key={library} variant="light" color="gray">{library}</Badge>
                    ))}
                  </Group>
                </Group>
                <Textarea
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                  minRows={16}
                  autosize
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                />
                <NumberInput
                  label="Timeout override"
                  description={`Optional. Runtime max is ${runtime.limits.maxTimeoutMs} ms.`}
                  value={timeoutMs}
                  onChange={(value) => setTimeoutMs(typeof value === 'number' ? value : '')}
                  min={100}
                  max={runtime.limits.maxTimeoutMs}
                  step={500}
                  suffix=" ms"
                />
              </Stack>
            </Paper>

            <Paper withBorder p="md" radius="lg">
              <Stack gap="sm">
                <Text fw={600}>Input</Text>
                <JsonInput
                  value={inputJson}
                  onChange={setInputJson}
                  minRows={10}
                  autosize
                  formatOnBlur
                  validationError="Invalid JSON"
                />
                <Group justify="flex-end">
                  <Button
                    leftSection={<IconPlayerPlay size={14} />}
                    onClick={handleExecute}
                    loading={executing}
                    disabled={runtime.status !== 'active'}
                  >
                    Execute
                  </Button>
                </Group>
              </Stack>
            </Paper>
          </Stack>

          <Paper withBorder p="md" radius="lg">
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={600}>Result</Text>
                {lastExecution ? (
                  <Badge variant="light" color={lastExecution.status === 'success' ? 'teal' : 'red'}>
                    {lastExecution.status} · {lastExecution.durationMs} ms
                  </Badge>
                ) : null}
              </Group>
              {!lastExecution ? (
                <Text size="sm" c="dimmed">Run code to inspect result, logs and execution status.</Text>
              ) : (
                <Stack gap="sm">
                  {lastExecution.errorMessage ? (
                    <Alert color="red" icon={<IconAlertTriangle size={16} />}>
                      {lastExecution.errorMessage}
                    </Alert>
                  ) : null}
                  <CodeBlock value={JSON.stringify(lastExecution.result ?? null, null, 2)} />
                  <Text fw={600} size="sm">Logs</Text>
                  <CodeBlock
                    value={[
                      ...(lastExecution.logs?.stdout ?? []).map((line: string) => `[stdout] ${line}`),
                      ...(lastExecution.logs?.stderr ?? []).map((line: string) => `[stderr] ${line}`),
                    ].join('\n') || 'No logs'}
                  />
                </Stack>
              )}
            </Stack>
          </Paper>
        </SimpleGrid>
      ) : null}

      {activeTab === 'usage' ? (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <UsageBlock title="Client API" value={usageSnippet} />
          <UsageBlock title="JavaScript fetch" value={sdkSnippet} />
        </SimpleGrid>
      ) : null}

      {activeTab === 'executions' ? (
        <Paper withBorder p="md" radius="lg">
          {executions.length === 0 ? (
            <Text size="sm" c="dimmed">No executions yet.</Text>
          ) : (
            <Stack gap="xs">
              {executions.map((execution) => (
                <Paper key={execution.id} withBorder p="sm" radius="md">
                  <Group justify="space-between" align="flex-start">
                    <Stack gap={2}>
                      <Group gap={6}>
                        <Badge variant="light" color={execution.status === 'success' ? 'teal' : execution.status === 'timeout' ? 'orange' : 'red'}>
                          {execution.status}
                        </Badge>
                        <Text size="xs" ff="monospace">{execution.executionId}</Text>
                      </Group>
                      <Text size="xs" c="dimmed">
                        {execution.createdAt ? new Date(execution.createdAt).toLocaleString() : ''} · {execution.durationMs} ms
                      </Text>
                    </Stack>
                    <Text size="xs" c="dimmed">{execution.callerType}</Text>
                  </Group>
                  <Code block mt="sm">{execution.codePreview}</Code>
                  {execution.errorMessage ? (
                    <Text size="xs" c="red" mt="xs">{execution.errorMessage}</Text>
                  ) : null}
                </Paper>
              ))}
            </Stack>
          )}
        </Paper>
      ) : null}

      {activeTab === 'settings' ? (
        <Paper withBorder p="md" radius="lg">
          <form onSubmit={settingsForm.onSubmit(handleSave)}>
            <Stack gap="sm">
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label="Name" withAsterisk {...settingsForm.getInputProps('name')} />
                <SegmentedControl
                  data={[
                    { label: 'Active', value: 'active' },
                    { label: 'Disabled', value: 'disabled' },
                  ]}
                  {...settingsForm.getInputProps('status')}
                />
              </SimpleGrid>
              <Textarea label="Description" minRows={2} {...settingsForm.getInputProps('description')} />
              <Checkbox.Group label="Libraries" {...settingsForm.getInputProps('libraries')}>
                <SimpleGrid cols={{ base: 1, sm: 2 }} mt="xs">
                  {libraries.map((library) => (
                    <Checkbox
                      key={library.key}
                      value={library.key}
                      label={library.label}
                      description={library.description}
                    />
                  ))}
                </SimpleGrid>
              </Checkbox.Group>
              <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
                <NumberInput label="Default timeout" suffix=" ms" min={100} max={120_000} step={500} {...settingsForm.getInputProps('defaultTimeoutMs')} />
                <NumberInput label="Max timeout" suffix=" ms" min={100} max={120_000} step={500} {...settingsForm.getInputProps('maxTimeoutMs')} />
                <NumberInput label="Memory limit" suffix=" MB" min={8} max={512} step={8} {...settingsForm.getInputProps('memoryLimitMb')} />
                <NumberInput label="Max code size" suffix=" bytes" min={1_024} max={1024 * 1024} step={1_024} {...settingsForm.getInputProps('maxCodeSizeBytes')} />
                <NumberInput label="Max result size" suffix=" bytes" min={1_024} max={5 * 1024 * 1024} step={1_024} {...settingsForm.getInputProps('maxResultSizeBytes')} />
                <NumberInput label="Max log entries" min={0} max={1_000} step={10} {...settingsForm.getInputProps('maxLogEntries')} />
              </SimpleGrid>
              <Group justify="flex-end">
                <Button type="submit" loading={saving} disabled={!settingsForm.isDirty()}>
                  Save
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>
      ) : null}
    </DetailShell>
  );
}

function Summary({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <Paper withBorder p="md" radius="lg">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
      <Group gap="xs" mt={4}>
        <ThemeIcon variant="light" color={color} size={26} radius="md">
          <IconCode size={14} />
        </ThemeIcon>
        <Text fw={700}>{value}</Text>
      </Group>
    </Paper>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <ScrollArea h={240} type="auto">
      <Code block style={{ whiteSpace: 'pre-wrap' }}>{value}</Code>
    </ScrollArea>
  );
}

function UsageBlock({ title, value }: { title: string; value: string }) {
  return (
    <Paper withBorder p="md" radius="lg">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>{title}</Text>
          <CopyButton value={value}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy'}>
                <ActionIcon variant="subtle" onClick={copy} color={copied ? 'teal' : 'gray'}>
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
        <CodeBlock value={value} />
      </Stack>
    </Paper>
  );
}
