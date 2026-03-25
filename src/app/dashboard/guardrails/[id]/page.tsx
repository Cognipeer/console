'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
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
  Loader,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconCheck,
  IconChartBar,
  IconCode,
  IconCopy,
  IconPlayerPlay,
  IconSettings,
  IconShield,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import GuardrailPolicyEditor from '@/components/guardrails/GuardrailPolicyEditor';
import GuardrailEvaluatePanel from '@/components/guardrails/GuardrailEvaluatePanel';
import GuardrailEvaluationHistory from '@/components/guardrails/GuardrailEvaluationHistory';
import type { GuardrailView } from '@/lib/services/guardrail/constants';
import type { IGuardrailPresetPolicy } from '@/lib/database';
import { defaultDashboardDateFilter } from '@/lib/utils/dashboardDateFilter';

interface ModelOption {
  value: string;
  label: string;
}

const TARGET_OPTIONS = [
  { value: 'input', label: 'Input only' },
  { value: 'output', label: 'Output only' },
  { value: 'both', label: 'Both (input & output)' },
];

const ACTION_OPTIONS = [
  { value: 'block', label: 'Block — reject the request' },
  { value: 'warn', label: 'Warn — pass with a warning' },
  { value: 'flag', label: 'Flag — pass and mark for review' },
];

export default function GuardrailDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab = ['dashboard', 'config', 'test', 'history', 'api'].includes(tabParam ?? '')
    ? (tabParam as 'dashboard' | 'config' | 'test' | 'history' | 'api')
    : 'dashboard';

  const [guardrail, setGuardrail] = useState<GuardrailView | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

  // policy state managed separately to avoid deep form cloning issues
  const [policy, setPolicy] = useState<IGuardrailPresetPolicy | undefined>(undefined);
  const [customPrompt, setCustomPrompt] = useState('');

  const hasMounted = useRef(false);

  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      target: 'both',
      action: 'block',
      modelKey: '',
      enabled: true,
    },
    validate: {
      name: (v) => (v.trim().length < 2 ? 'Name must be at least 2 characters' : null),
    },
  });

  const load = async () => {
    setLoading(true);
    try {
      const [grRes, modelsRes] = await Promise.all([
        fetch(`/api/guardrails/${params.id}`, { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
      ]);

      if (!grRes.ok) {
        if (grRes.status === 404) {
          router.replace('/dashboard/guardrails');
          return;
        }
        throw new Error('Failed to load guardrail');
      }

      const grData = await grRes.json();
      const g: GuardrailView = grData.guardrail;
      setGuardrail(g);

      form.setValues({
        name: g.name,
        description: g.description ?? '',
        target: g.target,
        action: g.action,
        modelKey: g.modelKey ?? '',
        enabled: g.enabled,
      });

      setPolicy(g.policy ?? undefined);
      setCustomPrompt(g.customPrompt ?? '');

      if (modelsRes.ok) {
        const mData = await modelsRes.json();
        setModels(
          (mData.models ?? []).map((m: { key: string; name: string }) => ({
            value: m.key,
            label: m.name,
          })),
        );
      }
    } catch (err) {
      console.error('[guardrail-detail]', err);
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load',
        color: 'red',
      });
    } finally {
      setLoading(false);
      hasMounted.current = true;
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const handleSave = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        ...form.values,
        modelKey: form.values.modelKey || undefined,
      };

      if (guardrail?.type === 'preset') {
        body.policy = policy;
      } else {
        body.customPrompt = customPrompt;
      }

      const res = await fetch(`/api/guardrails/${params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? 'Failed to save');
      }

      const data = await res.json();
      setGuardrail(data.guardrail);
      notifications.show({
        title: 'Saved',
        message: 'Guardrail updated successfully',
        color: 'teal',
      });
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
      const res = await fetch(`/api/guardrails/${params.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Deleted',
        message: `"${guardrail?.name}" was deleted`,
        color: 'red',
      });
      router.push('/dashboard/guardrails');
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  if (loading) {
    return (
      <Center h={300}>
        <Loader size="sm" />
      </Center>
    );
  }

  if (!guardrail) return null;

  const typeColor = guardrail.type === 'preset' ? 'violet' : 'teal';
  const actionColor = { block: 'red', warn: 'orange', flag: 'blue' }[guardrail.action] ?? 'gray';

  return (
    <>
      <PageHeader
        icon={<IconShield size={20} />}
        iconColor={typeColor}
        title={guardrail.name}
        subtitle={guardrail.description || `${guardrail.type} guardrail · ${guardrail.target} · ${guardrail.action}`}
        actions={
          <Group gap="sm">
            <Badge variant="light" color={typeColor}>{guardrail.type}</Badge>
            <Badge variant="light" color={actionColor}>{guardrail.action}</Badge>
            <Badge variant="light" color={guardrail.enabled ? 'teal' : 'gray'}>
              {guardrail.enabled ? 'Active' : 'Disabled'}
            </Badge>
            <Button
              variant="subtle"
              color="red"
              size="xs"
              leftSection={<IconTrash size={14} />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
            <Button
              component={Link}
              href="/dashboard/guardrails"
              variant="default"
              size="xs"
              leftSection={<IconArrowLeft size={14} />}
            >
              Back
            </Button>
          </Group>
        }
      />

      <Tabs value={activeTab} onChange={(v) => setActiveTab(v ?? 'dashboard')} mt="md">
        <Tabs.List mb="md">
          <Tabs.Tab value="dashboard" leftSection={<IconChartBar size={14} />}>
            Dashboard
          </Tabs.Tab>
          <Tabs.Tab value="config" leftSection={<IconSettings size={14} />}>
            Configuration
          </Tabs.Tab>
          <Tabs.Tab value="test" leftSection={<IconPlayerPlay size={14} />}>
            Test
          </Tabs.Tab>
          <Tabs.Tab value="history" leftSection={<IconChartBar size={14} />}>
            Evaluation History
          </Tabs.Tab>
          <Tabs.Tab value="api" leftSection={<IconCode size={14} />}>
            API Usage
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Dashboard tab ── */}
        <Tabs.Panel value="dashboard">
          <Stack gap="md">
            <Group justify="flex-end">
              <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            </Group>

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Paper withBorder radius="md" p="md">
                <Text fw={600} mb="sm">Overview</Text>
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Key</Text>
                    <Code fz="xs">{guardrail.key}</Code>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Type</Text>
                    <Badge variant="light" color={typeColor}>{guardrail.type}</Badge>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Target</Text>
                    <Text size="sm">{guardrail.target}</Text>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Default Action</Text>
                    <Badge variant="light" color={actionColor}>{guardrail.action}</Badge>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Status</Text>
                    <Badge variant="light" color={guardrail.enabled ? 'teal' : 'gray'}>
                      {guardrail.enabled ? 'Active' : 'Disabled'}
                    </Badge>
                  </Group>
                </Stack>
              </Paper>

              <Paper withBorder radius="md" p="md">
                <Text fw={600} mb="sm">Main Information</Text>
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Name</Text>
                    <Text size="sm" fw={500}>{guardrail.name}</Text>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Model</Text>
                    <Text size="sm">{guardrail.modelKey || '—'}</Text>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Created</Text>
                    <Text size="sm">
                      {guardrail.createdAt ? new Date(guardrail.createdAt).toLocaleString() : '—'}
                    </Text>
                  </Group>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" c="dimmed">Updated</Text>
                    <Text size="sm">
                      {guardrail.updatedAt ? new Date(guardrail.updatedAt).toLocaleString() : '—'}
                    </Text>
                  </Group>
                  <Divider my="xs" />
                  <Text size="xs" c="dimmed">Description</Text>
                  <Text size="sm">{guardrail.description || '—'}</Text>
                </Stack>
              </Paper>
            </SimpleGrid>

            <GuardrailEvaluationHistory
              guardrailId={params.id}
              mode="overview"
              dateFilter={dateFilter}
            />
          </Stack>
        </Tabs.Panel>

        {/* ── Configuration tab ── */}
        <Tabs.Panel value="config">
          <Stack gap="md">
            {/* Basic settings */}
            <Paper withBorder radius="md" p="md">
              <Text fw={600} mb="sm">Basic Settings</Text>
              <Stack gap="sm">
                <Group align="flex-start" grow wrap="nowrap">
                  <TextInput
                    label="Name"
                    description="Display name for this guardrail"
                    required
                    {...form.getInputProps('name')}
                  />
                  <TextInput
                    label="Description"
                    description="Optional — shown in lists and API responses"
                    placeholder="e.g. Block PII in user messages"
                    {...form.getInputProps('description')}
                  />
                </Group>

                <Group align="flex-start" grow wrap="nowrap">
                  <Select
                    label="Target"
                    description="Which direction to check"
                    data={TARGET_OPTIONS}
                    {...form.getInputProps('target')}
                  />
                  <Select
                    label="Default Action"
                    description="What happens on a violation"
                    data={ACTION_OPTIONS}
                    {...form.getInputProps('action')}
                  />
                </Group>

                {guardrail.type === 'custom' && (
                  <Select
                    label="Default Model"
                    description="LLM used to evaluate the custom prompt"
                    placeholder="Select a model"
                    clearable
                    data={models}
                    value={form.values.modelKey || null}
                    onChange={(v) => form.setFieldValue('modelKey', v ?? '')}
                  />
                )}

                <Switch
                  label="Enabled"
                  description="Disabled guardrails are skipped during evaluation"
                  checked={form.values.enabled}
                  onChange={(e) => form.setFieldValue('enabled', e.currentTarget.checked)}
                />
              </Stack>
            </Paper>

            {/* Policy editor */}
            <GuardrailPolicyEditor
              type={guardrail.type}
              policy={policy}
              customPrompt={customPrompt}
              modelKey={form.values.modelKey || undefined}
              models={models}
              onChange={({ policy: p, customPrompt: cp, modelKey: mk }) => {
                if (p !== undefined) setPolicy(p);
                if (cp !== undefined) setCustomPrompt(cp);
                if (mk !== undefined) form.setFieldValue('modelKey', mk);
              }}
            />

            <Group justify="flex-end">
              <Button loading={saving} onClick={handleSave} leftSection={guardrail.enabled ? <IconShield size={16}/> : <IconShieldOff size={16}/>}>
                Save Changes
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>

        {/* ── Test tab ── */}
        <Tabs.Panel value="test">
          <GuardrailEvaluatePanel guardrailKey={guardrail.key} guardrailName={guardrail.name} />
        </Tabs.Panel>

        {/* ── Evaluation History tab ── */}
        <Tabs.Panel value="history">
          <GuardrailEvaluationHistory
            guardrailId={params.id}
            mode="logs"
            dateFilter={dateFilter}
          />
        </Tabs.Panel>

        {/* ── API Usage tab ── */}
        <Tabs.Panel value="api">
          <Stack gap="md">
            <Paper withBorder radius="md" p="md">
              <Text fw={600} mb="xs">Guardrail Key</Text>
              <Group gap="sm">
                <Code fz="sm" style={{ flex: 1 }}>{guardrail.key}</Code>
                <CopyButton value={guardrail.key} timeout={2000}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                      <Button
                        size="xs"
                        variant={copied ? 'filled' : 'light'}
                        color={copied ? 'teal' : 'blue'}
                        onClick={copy}
                        leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      >
                        {copied ? 'Copied' : 'Copy key'}
                      </Button>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            </Paper>

            <Paper withBorder radius="md" p="md">
              <Text fw={600} mb="xs">cURL Example</Text>
              <Text size="xs" c="dimmed" mb="sm">
                Replace <Code fz="xs">YOUR_API_TOKEN</Code> with a valid API token from Settings.
              </Text>
              <Box style={{ position: 'relative' }}>
                <CopyButton
                  value={`curl -X POST https://your-cognipeer-host/api/client/v1/guardrails/evaluate \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "guardrail_key": "${guardrail.key}",
    "text": "Hello, my name is John and my SSN is 123-45-6789"
  }'`}
                  timeout={2000}
                >
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy command'} withArrow>
                      <Button
                        size="xs"
                        variant={copied ? 'filled' : 'outline'}
                        color={copied ? 'teal' : 'gray'}
                        leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                        style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
                        onClick={copy}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    </Tooltip>
                  )}
                </CopyButton>
                <Code block fz="xs">
{`curl -X POST https://your-cognipeer-host/api/client/v1/guardrails/evaluate \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "guardrail_key": "${guardrail.key}",
    "text": "Hello, my name is John and my SSN is 123-45-6789"
  }'`}
                </Code>
              </Box>
            </Paper>

            <Paper withBorder radius="md" p="md">
              <Text fw={600} mb="xs">Response Format</Text>
              <Code block fz="xs">
{`{
  "passed": false,
  "guardrail_key": "${guardrail.key}",
  "guardrail_name": "${guardrail.name}",
  "action": "${guardrail.action}",
  "findings": [
    {
      "type": "pii",
      "severity": "high",
      "category": "nationalId",
      "message": "Social Security Number detected",
      "value": "123-45-****"
    }
  ],
  "message": "Content blocked by guardrail \\"${guardrail.name}\\""
}`}
              </Code>
            </Paper>

            <Paper withBorder radius="md" p="md">
              <Text fw={600} mb="xs">JavaScript SDK Example (ESM)</Text>
              <Code block fz="xs">
{`import { ConsoleClient } from '@cognipeer/console-sdk';

const client = new ConsoleClient({
  apiKey: process.env.COGNIPEER_API_TOKEN,
  baseURL: 'https://your-cognipeer-host',
});

const result = await client.guardrails.evaluate({
  guardrail_key: '${guardrail.key}',
  text: userMessage,
});

if (!result.passed) {
  console.log('Blocked:', result.message);
  for (const finding of result.findings) {
    console.log('[' + finding.severity + '] ' + finding.category + ': ' + finding.message);
  }
}`}
              </Code>
            </Paper>

            <Paper withBorder radius="md" p="md">
              <Text fw={600} mb="xs">JavaScript SDK Example (CommonJS)</Text>
              <Code block fz="xs">
{`const { ConsoleClient } = require('@cognipeer/console-sdk');

const client = new ConsoleClient({
  apiKey: process.env.COGNIPEER_API_TOKEN,
  baseURL: 'https://your-cognipeer-host',
});

async function runGuardrailCheck(userMessage) {
  const result = await client.guardrails.evaluate({
    guardrail_key: '${guardrail.key}',
    text: userMessage,
  });

  if (!result.passed) {
    console.log('Blocked:', result.message);
    result.findings.forEach((finding) => {
      console.log('[' + finding.severity + '] ' + finding.category + ': ' + finding.message);
    });
  }
}

runGuardrailCheck('Hello, my SSN is 123-45-6789').catch(console.error);`}
              </Code>
            </Paper>

            <Paper withBorder radius="md" p="md">
              <Text fw={600} mb="xs">Python SDK Example</Text>
              <Code block fz="xs">
{`import httpx

response = httpx.post(
    "https://your-cognipeer-host/api/client/v1/guardrails/evaluate",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
    json={
        "guardrail_key": "${guardrail.key}",
        "text": user_message,
    },
)

result = response.json()
if not result["passed"]:
    print(f"Blocked: {result['message']}")
    for finding in result["findings"]:
        print(f"  - [{finding['severity']}] {finding['message']}")`}
              </Code>
            </Paper>

            <Divider />

            <Paper withBorder radius="md" p="md">
              <Group justify="space-between" mb="xs">
                <Text fw={600}>Configuration JSON</Text>
                <CopyButton value={JSON.stringify(guardrail, null, 2)} timeout={2000}>
                  {({ copied, copy }) => (
                    <Button
                      size="xs"
                      variant="subtle"
                      color={copied ? 'teal' : 'gray'}
                      leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied' : 'Copy JSON'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
              <Code block fz="xs" style={{ maxHeight: 300, overflow: 'auto' }}>
                {JSON.stringify(guardrail, null, 2)}
              </Code>
            </Paper>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {/* Delete confirmation */}
      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete guardrail"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{guardrail.name}</strong>? This cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={handleDelete}>Delete</Button>
        </Group>
      </Modal>
    </>
  );
}
