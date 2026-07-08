'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconBell,
  IconBellPlus,
  IconDots,
  IconEdit,
  IconHistory,
  IconTrash,
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconActivity,
  IconExclamationCircle,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import AlertRuleForm from '@/components/alerts/AlertRuleForm';
import { useTranslations } from '@/lib/i18n';

interface AlertRule {
  _id: string;
  name: string;
  description?: string;
  module?: string;
  metric: string;
  condition: { operator: string; threshold: number };
  windowMinutes: number;
  cooldownMinutes: number;
  enabled: boolean;
  scope?: { modelKey?: string; serverKey?: string; guardrailKey?: string; ragModuleKey?: string };
  channels: Array<{ type: string; recipients: string[] }>;
  lastTriggeredAt?: string;
  createdAt: string;
}

const METRIC_LABELS: Record<string, string> = {
  error_rate: 'Error Rate',
  avg_latency_ms: 'Avg Latency',
  p95_latency_ms: 'P95 Latency',
  total_cost: 'Total Cost',
  total_requests: 'Total Requests',
  gpu_cache_usage: 'GPU Cache',
  request_queue_depth: 'Queue Depth',
  guardrail_fail_rate: 'Fail Rate',
  guardrail_avg_latency_ms: 'Avg Latency',
  guardrail_total_evaluations: 'Total Evals',
  rag_avg_latency_ms: 'Avg Latency',
  rag_total_queries: 'Total Queries',
  rag_failed_documents: 'Failed Docs',
  mcp_error_rate: 'Error Rate',
  mcp_avg_latency_ms: 'Avg Latency',
  mcp_total_requests: 'Total Requests',
  evaluation_pass_rate: 'Pass Rate',
  evaluation_avg_score: 'Avg Score',
  analysis_pass_rate: 'Pass Rate',
  analysis_avg_judge_score: 'Avg Judge Score',
  analysis_avg_accuracy: 'Avg Accuracy',
  redteam_attack_success_rate: 'Attack Success Rate',
  redteam_resilience_score: 'Resilience Score',
};

const METRIC_UNITS: Record<string, string> = {
  error_rate: '%',
  avg_latency_ms: 'ms',
  p95_latency_ms: 'ms',
  total_cost: 'USD',
  total_requests: '',
  gpu_cache_usage: '%',
  request_queue_depth: '',
  guardrail_fail_rate: '%',
  guardrail_avg_latency_ms: 'ms',
  guardrail_total_evaluations: '',
  rag_avg_latency_ms: 'ms',
  rag_total_queries: '',
  rag_failed_documents: '',
  mcp_error_rate: '%',
  mcp_avg_latency_ms: 'ms',
  mcp_total_requests: '',
  evaluation_pass_rate: '%',
  evaluation_avg_score: '%',
  analysis_pass_rate: '%',
  analysis_avg_judge_score: '%',
  analysis_avg_accuracy: '%',
  redteam_attack_success_rate: '%',
  redteam_resilience_score: '%',
};

const METRIC_COLORS: Record<string, string> = {
  error_rate: 'red',
  avg_latency_ms: 'orange',
  p95_latency_ms: 'orange',
  total_cost: 'violet',
  total_requests: 'blue',
  gpu_cache_usage: 'teal',
  request_queue_depth: 'cyan',
  guardrail_fail_rate: 'red',
  guardrail_avg_latency_ms: 'orange',
  guardrail_total_evaluations: 'blue',
  rag_avg_latency_ms: 'orange',
  rag_total_queries: 'blue',
  rag_failed_documents: 'red',
  mcp_error_rate: 'red',
  mcp_avg_latency_ms: 'orange',
  mcp_total_requests: 'blue',
  evaluation_pass_rate: 'green',
  evaluation_avg_score: 'teal',
  analysis_pass_rate: 'green',
  analysis_avg_judge_score: 'teal',
  analysis_avg_accuracy: 'teal',
  redteam_attack_success_rate: 'red',
  redteam_resilience_score: 'green',
};

const MODULE_LABELS: Record<string, string> = {
  models: 'Model Hub',
  inference: 'Model Monitoring',
  guardrails: 'Guardrail',
  rag: 'Knowledge Engine',
  mcp: 'MCP Servers',
  evaluation: 'Evaluation',
  analysis: 'Analysis',
  redteam: 'Red Team',
};

const MODULE_COLORS: Record<string, string> = {
  models: 'blue',
  inference: 'teal',
  guardrails: 'grape',
  rag: 'indigo',
  mcp: 'cyan',
  evaluation: 'green',
  analysis: 'lime',
  redteam: 'red',
};

const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  eq: '=',
};

export default function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpened, formControls] = useDisclosure(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);
  const [createPrefill, setCreatePrefill] = useState<Record<string, unknown> | undefined>();
  const [moduleFilter, setModuleFilter] = useState('all');
  const t = useTranslations('alerts');
  const searchParams = useSearchParams();

  // Deep-link support: ?create=1&module=models[&metric=error_rate] opens the
  // create form prefilled (used by dashboard report drill-downs).
  useEffect(() => {
    if (searchParams.get('create') !== '1') return;
    const module = searchParams.get('module');
    const metric = searchParams.get('metric');
    setCreatePrefill({
      ...(module ? { module } : {}),
      ...(metric ? { metric } : {}),
    });
    formControls.open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts/rules');
      if (!res.ok) throw new Error('Failed to fetch alert rules');
      const data = await res.json();
      setRules(data.rules || []);
    } catch (err) {
      notifications.show({
        title: t('error'),
        message: err instanceof Error ? err.message : 'Failed to load alert rules',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleToggle = async (ruleId: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/alerts/rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('Failed to update rule');
      setRules((prev) =>
        prev.map((r) => (r._id === ruleId ? { ...r, enabled } : r)),
      );
    } catch {
      notifications.show({
        title: t('error'),
        message: t('toggleError'),
        color: 'red',
      });
    }
  };

  const handleDelete = async (ruleId: string) => {
    try {
      const res = await fetch(`/api/alerts/rules/${ruleId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete rule');
      setRules((prev) => prev.filter((r) => r._id !== ruleId));
      notifications.show({
        title: t('ruleDeleted'),
        message: t('ruleDeletedMessage'),
        color: 'teal',
      });
    } catch {
      notifications.show({
        title: t('error'),
        message: t('deleteError'),
        color: 'red',
      });
    }
  };

  const handleEdit = (rule: AlertRule) => {
    setEditingRule(rule);
    formControls.open();
  };

  const handleCreate = () => {
    setEditingRule(null);
    formControls.open();
  };

  const enabledCount = rules.filter((r) => r.enabled).length;
  const disabledCount = rules.filter((r) => !r.enabled).length;
  const recentlyFiredCount = rules.filter((r) => {
    if (!r.lastTriggeredAt) return false;
    const elapsed = Date.now() - new Date(r.lastTriggeredAt).getTime();
    return elapsed < 24 * 60 * 60 * 1000; // last 24h
  }).length;

  /** Determine module for a rule (backward compat: infer from metric) */
  const getModule = (rule: AlertRule): string => {
    if (rule.module) return rule.module;
    const modelMetrics = ['error_rate', 'avg_latency_ms', 'p95_latency_ms', 'total_cost', 'total_requests'];
    const inferenceMetrics = ['gpu_cache_usage', 'request_queue_depth'];
    if (modelMetrics.includes(rule.metric)) return 'models';
    if (inferenceMetrics.includes(rule.metric)) return 'inference';
    if (rule.metric.startsWith('guardrail_')) return 'guardrails';
    if (rule.metric.startsWith('rag_')) return 'rag';
    if (rule.metric.startsWith('mcp_')) return 'mcp';
    if (rule.metric.startsWith('evaluation_')) return 'evaluation';
    if (rule.metric.startsWith('analysis_')) return 'analysis';
    if (rule.metric.startsWith('redteam_')) return 'redteam';
    return 'models';
  };

  const filteredRules = moduleFilter === 'all'
    ? rules
    : rules.filter((r) => getModule(r) === moduleFilter);

  if (loading) {
    return (
      <Stack align="center" justify="center" h={400}>
        <Loader size="lg" />
      </Stack>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Alerts"
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            <Button
              component={Link}
              href="/dashboard/alerts/incidents"
              variant="default"
              size="sm"
              color="red"
              leftSection={<IconExclamationCircle size={14} stroke={1.7} />}
            >
              Incidents
            </Button>
            <Button
              component={Link}
              href="/dashboard/alerts/history"
              variant="default"
              size="sm"
              leftSection={<IconHistory size={14} stroke={1.7} />}
            >
              {t('viewHistory')}
            </Button>
            <Button
              color="teal"
              size="sm"
              leftSection={<IconBellPlus size={14} stroke={1.7} />}
              onClick={handleCreate}
            >
              {t('newRule')}
            </Button>
          </>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label={t('activeRules')}
          value={enabledCount}
          icon={<IconCheck size={14} stroke={1.7} />}
        />
        <StatTile
          label={t('disabledRules')}
          value={disabledCount}
          icon={<IconClock size={14} stroke={1.7} />}
        />
        <StatTile
          label={t('firedLast24h')}
          value={recentlyFiredCount}
          icon={<IconAlertTriangle size={14} stroke={1.7} />}
        />
      </div>

      {/* Module Filter */}
      <SegmentedControl
        value={moduleFilter}
        onChange={setModuleFilter}
        data={[
          { label: t('allModules'), value: 'all' },
          { label: 'Model Hub', value: 'models' },
          { label: 'Model Monitoring', value: 'inference' },
          { label: 'Guardrail', value: 'guardrails' },
          { label: 'Knowledge Engine', value: 'rag' },
          { label: 'MCP Servers', value: 'mcp' },
          { label: 'Evaluation', value: 'evaluation' },
          { label: 'Analysis', value: 'analysis' },
          { label: 'Red Team', value: 'redteam' },
        ]}
        size="xs"
      />

      {/* Rules List */}
      {filteredRules.length === 0 ? (
        <Paper p="xl" radius="md" withBorder>
          <Stack align="center" gap="md" py="xl">
            <ThemeIcon size={60} radius="xl" variant="light" color="orange">
              <IconBell size={28} />
            </ThemeIcon>
            <Text size="lg" fw={600}>{t('noRules')}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={400}>
              {t('noRulesDescription')}
            </Text>
            <Button
              leftSection={<IconBellPlus size={16} />}
              onClick={handleCreate}
            >
              {t('createFirstRule')}
            </Button>
          </Stack>
        </Paper>
      ) : (
        <Stack gap="sm">
          {filteredRules.map((rule) => (
            <Paper key={rule._id} p="md" radius="md" withBorder>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="md" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                  <ThemeIcon
                    size={36}
                    radius="md"
                    variant="light"
                    color={METRIC_COLORS[rule.metric] ?? 'gray'}
                  >
                    <IconActivity size={18} />
                  </ThemeIcon>
                  <div style={{ minWidth: 0 }}>
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={600} size="sm" lineClamp={1}>
                        {rule.name}
                      </Text>
                      <Badge
                        size="xs"
                        variant="light"
                        color={MODULE_COLORS[getModule(rule)] ?? 'gray'}
                      >
                        {MODULE_LABELS[getModule(rule)] ?? getModule(rule)}
                      </Badge>
                      <Badge
                        size="xs"
                        variant="light"
                        color={METRIC_COLORS[rule.metric] ?? 'gray'}
                      >
                        {METRIC_LABELS[rule.metric] ?? rule.metric}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" mt={2}>
                      {OPERATOR_SYMBOLS[rule.condition.operator] ?? rule.condition.operator}{' '}
                      {rule.condition.threshold}
                      {METRIC_UNITS[rule.metric] ?? ''} ·{' '}
                      {rule.windowMinutes}min window
                      {rule.scope?.modelKey && ` · model: ${rule.scope.modelKey}`}
                      {rule.scope?.serverKey && ` · server: ${rule.scope.serverKey}`}
                      {rule.scope?.guardrailKey && ` · guardrail: ${rule.scope.guardrailKey}`}
                      {rule.scope?.ragModuleKey && ` · rag: ${rule.scope.ragModuleKey}`}
                    </Text>
                    {rule.lastTriggeredAt && (
                      <Text size="xs" c="orange" mt={2}>
                        Last fired: {new Date(rule.lastTriggeredAt).toLocaleString()}
                      </Text>
                    )}
                  </div>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Tooltip label={rule.enabled ? t('clickToDisable') : t('clickToEnable')}>
                    <Switch
                      size="sm"
                      checked={rule.enabled}
                      onChange={(e) => handleToggle(rule._id, e.currentTarget.checked)}
                    />
                  </Tooltip>
                  <Menu shadow="md" position="bottom-end">
                    <Menu.Target>
                      <ActionIcon variant="subtle" size="sm">
                        <IconDots size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconEdit size={14} />}
                        onClick={() => handleEdit(rule)}
                      >
                        {t('edit')}
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={() => handleDelete(rule._id)}
                      >
                        {t('delete')}
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}

      {/* Create/Edit Modal */}
      <AlertRuleForm
        opened={formOpened}
        onClose={() => {
          formControls.close();
          setEditingRule(null);
        }}
        onSuccess={fetchRules}
        mode={editingRule ? 'edit' : 'create'}
        ruleId={editingRule?._id}
        initialData={
          editingRule ? (editingRule as unknown as Record<string, unknown>) : createPrefill
        }
      />
    </PageContainer>
  );
}
