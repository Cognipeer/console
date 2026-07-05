'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconDeviceFloppy,
  IconEdit,
  IconExternalLink,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconTrash,
  IconWorldSearch,
} from '@tabler/icons-react';
import DetailShell, {
  DetailCard,
  DetailTwoCol,
} from '@/components/common/ui/DetailShell';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import ProviderConfigModal from '@/components/providers/ProviderConfigModal';
import type { ProviderDescriptor } from '@/lib/providers/types';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import type {
  WebSearchAiAnswerSettings,
  WebSearchResult,
} from '@/lib/services/webSearch/types';
import type { IWebSearchRunLog } from '@/lib/database';

const LOGS_FETCH_LIMIT = 200;

type TabId = 'playground' | 'usage' | 'logs' | 'config';

function aiAnswerOf(p: ProviderConfigView | null): WebSearchAiAnswerSettings {
  const raw = (p?.settings as Record<string, unknown> | undefined)?.aiAnswer;
  return raw && typeof raw === 'object' ? (raw as WebSearchAiAnswerSettings) : {};
}

function settingString(p: ProviderConfigView, name: string): string | undefined {
  const value = (p.settings as Record<string, unknown>)?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export default function WebSearchInstancePage() {
  const router = useRouter();
  const params = useParams<{ key: string }>();
  const key = params.key;

  const [tab, setTab] = useState<TabId>('playground');
  const [instance, setInstance] = useState<ProviderConfigView | null>(null);
  const [loading, setLoading] = useState(true);

  // Logs
  const [logs, setLogs] = useState<IWebSearchRunLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logQuery, setLogQuery] = useState('');
  const [logFrom, setLogFrom] = useState('');
  const [logTo, setLogTo] = useState('');
  const [logStatus, setLogStatus] = useState<string>('all');
  const [logDetail, setLogDetail] = useState<IWebSearchRunLog | null>(null);

  // Edit modal
  const [drivers, setDrivers] = useState<ProviderDescriptor[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Playground
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCount, setSearchCount] = useState<number | ''>(10);
  const [withAnswer, setWithAnswer] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<WebSearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // AI answer settings (Configuration tab)
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiModelKey, setAiModelKey] = useState<string | null>(null);
  const [aiInstructions, setAiInstructions] = useState('');
  const [aiSaving, setAiSaving] = useState(false);
  const [models, setModels] = useState<Array<{ value: string; label: string }>>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/websearch/providers/${encodeURIComponent(key)}`, {
        cache: 'no-store',
      });
      if (res.status === 404) {
        notifications.show({ color: 'red', title: 'Web Search', message: 'Instance not found' });
        router.push('/dashboard/websearch');
        return;
      }
      if (!res.ok) throw new Error('Failed to load instance');
      const data = await res.json();
      const provider = (data.provider ?? null) as ProviderConfigView | null;
      setInstance(provider);
      const ai = aiAnswerOf(provider);
      setAiEnabled(ai.enabled === true);
      setAiModelKey(ai.modelKey ?? null);
      setAiInstructions(ai.instructions ?? '');
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setLoading(false);
    }
  }, [key, router]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const searchParams = new URLSearchParams({ limit: String(LOGS_FETCH_LIMIT) });
      if (logFrom) searchParams.set('from', new Date(`${logFrom}T00:00:00`).toISOString());
      if (logTo) searchParams.set('to', new Date(`${logTo}T23:59:59.999`).toISOString());
      const res = await fetch(
        `/api/websearch/providers/${encodeURIComponent(key)}/logs?${searchParams.toString()}`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs ?? []);
      }
    } catch (err) {
      console.error('Failed to load logs', err);
    } finally {
      setLogsLoading(false);
    }
  }, [key, logFrom, logTo]);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models?category=llm', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setModels(
          (data.models ?? []).map((m: { key: string; name?: string }) => ({
            value: m.key,
            label: m.name ? `${m.name} (${m.key})` : m.key,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load models', err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    if (tab === 'config') void loadModels();
  }, [tab, loadModels]);

  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (logStatus !== 'all' && l.status !== logStatus) return false;
      if (logQuery) {
        const q = logQuery.toLowerCase();
        const haystack = [
          l.query,
          l.answer ?? '',
          l.errorMessage ?? '',
          ...(l.results ?? []).flatMap((r) => [r.title, r.url]),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [logs, logQuery, logStatus]);

  const usage = useMemo(() => {
    const success = logs.filter((l) => l.status === 'success');
    const errors = logs.filter((l) => l.status === 'error');
    const latencies = success
      .map((l) => l.latencyMs)
      .filter((v): v is number => typeof v === 'number')
      .sort((a, b) => a - b);
    const avgLatency = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;
    const p95Latency = latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
      : null;
    const now = Date.now();
    const last24h = logs.filter(
      (l) => l.createdAt && now - new Date(l.createdAt).getTime() < 24 * 60 * 60 * 1000,
    ).length;
    const bySource = logs.reduce<Record<string, number>>((acc, l) => {
      const s = l.source ?? 'unknown';
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    const aiAnswered = logs.filter((l) => l.metadata && (l.metadata as Record<string, unknown>).answerModel).length;
    const totalResults = success.reduce((acc, l) => acc + (l.resultCount ?? 0), 0);
    return {
      total: logs.length,
      errors: errors.length,
      successRate: logs.length
        ? `${Math.round((success.length / logs.length) * 100)}%`
        : '—',
      avgLatency: avgLatency !== null ? `${avgLatency} ms` : '—',
      p95Latency: p95Latency !== null ? `${p95Latency} ms` : '—',
      last24h,
      bySource,
      aiAnswered,
      avgResults: success.length ? Math.round(totalResults / success.length) : null,
      lastUsedAt: logs[0]?.createdAt ? new Date(logs[0].createdAt) : null,
    };
  }, [logs]);

  async function runSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch('/api/websearch/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: searchQuery.trim(),
          provider: key,
          count: typeof searchCount === 'number' ? searchCount : undefined,
          includeAnswer: withAnswer,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || 'Search failed');
      setSearchResult(body.result as WebSearchResult);
      void loadLogs();
    } catch (err) {
      setSearchResult(null);
      setSearchError(err instanceof Error ? err.message : 'Search failed');
      void loadLogs();
    } finally {
      setSearching(false);
    }
  }

  const openEdit = async () => {
    setEditOpen(true);
    setDriversLoading(true);
    try {
      const res = await fetch('/api/websearch/providers/drivers', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setDrivers(data.drivers ?? []);
      }
    } finally {
      setDriversLoading(false);
    }
  };

  async function saveAiSettings() {
    if (!instance) return;
    if (aiEnabled && !aiModelKey) {
      notifications.show({
        color: 'red',
        title: 'AI Answer',
        message: 'Select a model before enabling AI answers.',
      });
      return;
    }
    setAiSaving(true);
    try {
      const aiAnswer: WebSearchAiAnswerSettings = {
        enabled: aiEnabled,
        modelKey: aiModelKey ?? undefined,
        instructions: aiInstructions.trim() || undefined,
      };
      const res = await fetch(`/api/providers/${encodeURIComponent(String(instance._id))}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { ...instance.settings, aiAnswer } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to save AI settings');
      }
      notifications.show({ color: 'teal', title: 'AI Answer', message: 'Settings saved' });
      await load();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setAiSaving(false);
    }
  }

  async function confirmDelete() {
    if (!instance) return;
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(String(instance._id))}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ color: 'teal', title: 'Deleted', message: 'Instance removed' });
      router.push('/dashboard/websearch');
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    }
  }

  const logColumns: DataGridColumn<IWebSearchRunLog>[] = [
    {
      key: 'createdAt',
      label: 'Time',
      render: (l) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {l.createdAt ? new Date(l.createdAt).toLocaleString() : '—'}
        </span>
      ),
    },
    {
      key: 'query',
      label: 'Query',
      render: (l) => (
        <span style={{ fontSize: 13 }} title={l.query}>
          {l.query.length > 70 ? `${l.query.slice(0, 70)}…` : l.query}
        </span>
      ),
    },
    {
      key: 'resultCount',
      label: 'Results',
      render: (l) => <span className="ds-badge">{l.resultCount}</span>,
    },
    {
      key: 'answer',
      label: 'Answer',
      render: (l) =>
        l.answer ? (
          <span className="ds-badge ds-badge-ok">
            <IconSparkles size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
            yes
          </span>
        ) : (
          <span className="ds-faint">—</span>
        ),
    },
    {
      key: 'latencyMs',
      label: 'Latency',
      render: (l) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {typeof l.latencyMs === 'number' ? `${l.latencyMs} ms` : '—'}
        </span>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      render: (l) => <span className="ds-faint">{l.source ?? '—'}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (l) =>
        l.status === 'success' ? (
          <span className="ds-badge ds-badge-ok">success</span>
        ) : (
          <span className="ds-badge ds-badge-err" title={l.errorMessage}>
            error
          </span>
        ),
    },
  ];

  if (loading || !instance) {
    return (
      <DetailShell
        backHref="/dashboard/websearch"
        title={loading ? 'Loading…' : 'Instance not found'}
      >
        <div />
      </DetailShell>
    );
  }

  const aiConfigured = aiAnswerOf(instance).enabled === true;

  return (
    <DetailShell
      backHref="/dashboard/websearch"
      icon={<IconWorldSearch size={16} />}
      title={instance.label}
      meta={
        <>
          <Badge size="xs" variant="light">{instance.driver}</Badge>
          <span className="ds-mono ds-faint" style={{ fontSize: 12 }}>{instance.key}</span>
          <StatusBadge status={instance.status === 'active' ? 'active' : 'paused'} />
          {aiConfigured && (
            <Badge size="xs" variant="light" color="grape">
              <IconSparkles size={10} style={{ verticalAlign: -1, marginRight: 2 }} />
              AI answer
            </Badge>
          )}
        </>
      }
      actions={
        <Button
          variant="default"
          size="xs"
          leftSection={<IconEdit size={13} stroke={1.7} />}
          onClick={() => void openEdit()}
        >
          Edit
        </Button>
      }
      tabs={[
        { id: 'playground', label: 'Playground' },
        { id: 'usage', label: 'Usage' },
        { id: 'logs', label: 'Logs' },
        { id: 'config', label: 'Configuration' },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as TabId)}
    >
      {tab === 'playground' ? (
        <DetailCard
          title="Ask this instance"
          description="Runs a live search through this instance; every run is recorded in Logs."
        >
          <Group align="flex-end" gap="sm" wrap="wrap">
            <TextInput
              placeholder="Search the web…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runSearch();
              }}
              style={{ flex: 1, minWidth: 240 }}
              aria-label="Search query"
            />
            <NumberInput
              min={1}
              max={50}
              value={searchCount}
              onChange={(v) => setSearchCount(typeof v === 'number' ? v : '')}
              w={90}
              aria-label="Result count"
            />
            <Switch
              label="AI answer"
              checked={withAnswer}
              onChange={(e) => setWithAnswer(e.currentTarget.checked)}
              size="sm"
              style={{ alignSelf: 'center' }}
            />
            <Button
              leftSection={<IconSearch size={14} stroke={1.7} />}
              onClick={() => void runSearch()}
              loading={searching}
              disabled={!searchQuery.trim()}
            >
              Search
            </Button>
          </Group>
          {withAnswer && !aiConfigured && (
            <div className="ds-faint" style={{ fontSize: 12, marginTop: 6 }}>
              AI answers are not enabled on this instance — the search will fail.
              Enable them under Configuration → AI Answer.
            </div>
          )}

          {searchError && (
            <div className="ds-badge ds-badge-err" style={{ marginTop: 12 }}>
              {searchError}
            </div>
          )}

          {searchResult && (
            <div style={{ marginTop: 14 }}>
              <div className="ds-faint" style={{ fontSize: 12, marginBottom: 8 }}>
                {searchResult.results.length} results · {searchResult.latencyMs} ms
              </div>
              {searchResult.answer && (
                <div className="ds-card" style={{ padding: 12, marginBottom: 10, fontSize: 13 }}>
                  <span className="ds-badge ds-badge-ok" style={{ marginRight: 8 }}>
                    <IconSparkles size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                    {searchResult.answerModel ?? 'answer'}
                  </span>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{searchResult.answer}</span>
                </div>
              )}
              <Stack gap={10}>
                {searchResult.results.map((r) => (
                  <div key={`${r.position}-${r.url}`} className="ds-col" style={{ gap: 2 }}>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      {r.position}. {r.title || r.url}
                      <IconExternalLink
                        size={12}
                        style={{ marginLeft: 4, verticalAlign: -1 }}
                      />
                    </a>
                    <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{r.url}</span>
                    {r.snippet && (
                      <span className="ds-muted" style={{ fontSize: 12 }}>{r.snippet}</span>
                    )}
                  </div>
                ))}
              </Stack>
            </div>
          )}
        </DetailCard>
      ) : null}

      {tab === 'usage' ? (
        <>
          <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
            <StatTile label="Searches (recent)" value={usage.total} />
            <StatTile label="Last 24h" value={usage.last24h} />
            <StatTile label="Success rate" value={usage.successRate} />
            <StatTile label="Errors" value={usage.errors} />
            <StatTile label="Avg latency" value={usage.avgLatency} />
            <StatTile label="p95 latency" value={usage.p95Latency} />
          </div>
          <DetailTwoCol narrowAside>
            <DetailCard
              title="Breakdown"
              description={`Computed over the last ${usage.total} searches.`}
            >
              <div className="ds-col" style={{ gap: 8, fontSize: 13 }}>
                <div className="ds-row-between">
                  <span className="ds-muted">Avg results per search</span>
                  <span className="ds-mono">{usage.avgResults ?? '—'}</span>
                </div>
                <div className="ds-row-between">
                  <span className="ds-muted">AI-answered searches</span>
                  <span className="ds-mono">{usage.aiAnswered}</span>
                </div>
                <div className="ds-row-between">
                  <span className="ds-muted">Last used</span>
                  <span className="ds-mono">
                    {usage.lastUsedAt ? usage.lastUsedAt.toLocaleString() : '—'}
                  </span>
                </div>
                {Object.entries(usage.bySource).map(([source, count]) => (
                  <div key={source} className="ds-row-between">
                    <span className="ds-muted">Via {source}</span>
                    <span className="ds-mono">{count}</span>
                  </div>
                ))}
              </div>
            </DetailCard>
            <DetailCard
              title="About usage data"
              description="Numbers are derived from the recent run logs of this instance."
            >
              <span className="ds-faint" style={{ fontSize: 12 }}>
                Up to the last {LOGS_FETCH_LIMIT} searches are considered. Open the
                Logs tab for individual runs, including returned results and answers.
              </span>
            </DetailCard>
          </DetailTwoCol>
        </>
      ) : null}

      {tab === 'logs' ? (
        <DetailCard
          title="Search logs"
          description="Every search executed on this instance. Click a row to inspect the returned results and answer."
          actions={
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconRefresh size={13} stroke={1.7} />}
              onClick={() => void loadLogs()}
              loading={logsLoading}
            >
              Refresh
            </Button>
          }
          pad="sm"
        >
          <Group gap="sm" wrap="wrap" style={{ marginBottom: 10 }}>
            <TextInput
              placeholder="Search in queries, results, answers…"
              value={logQuery}
              onChange={(e) => setLogQuery(e.currentTarget.value)}
              size="xs"
              style={{ flex: 1, minWidth: 220 }}
              leftSection={<IconSearch size={12} />}
              aria-label="Filter logs"
            />
            <TextInput
              type="date"
              size="xs"
              value={logFrom}
              onChange={(e) => setLogFrom(e.currentTarget.value)}
              aria-label="From date"
              w={140}
            />
            <TextInput
              type="date"
              size="xs"
              value={logTo}
              onChange={(e) => setLogTo(e.currentTarget.value)}
              aria-label="To date"
              w={140}
            />
            <Select
              size="xs"
              data={[
                { value: 'all', label: 'All statuses' },
                { value: 'success', label: 'Success' },
                { value: 'error', label: 'Error' },
              ]}
              value={logStatus}
              onChange={(v) => setLogStatus(v ?? 'all')}
              w={130}
              aria-label="Status filter"
            />
          </Group>
          <DataGrid<IWebSearchRunLog>
            records={filteredLogs}
            loading={logsLoading}
            rowKey={(l) => String(l._id)}
            columns={logColumns}
            onRowClick={(l) => setLogDetail(l)}
            empty={{
              icon: <IconSearch size={26} stroke={1.7} />,
              title: 'No searches match',
              description: 'Adjust the filters, or run a search via the API or the playground.',
            }}
            footerLeft={`Showing ${filteredLogs.length} of ${logs.length} loaded searches`}
          />
        </DetailCard>
      ) : null}

      {tab === 'config' ? (
        <DetailTwoCol narrowAside>
          <div className="ds-col" style={{ gap: 16 }}>
            <DetailCard
              title="AI Answer"
              description="Interpret search results with a model and return a synthesized answer (like Tavily). Requests asking for an answer fail while this is disabled."
              actions={
                <Button
                  size="xs"
                  color="teal"
                  leftSection={<IconDeviceFloppy size={13} stroke={1.7} />}
                  loading={aiSaving}
                  onClick={() => void saveAiSettings()}
                >
                  Save
                </Button>
              }
            >
              <div className="ds-col" style={{ gap: 12 }}>
                <Switch
                  label="Enable AI answers"
                  description="Allows requests with include_answer to interpret results with the model below."
                  checked={aiEnabled}
                  onChange={(e) => setAiEnabled(e.currentTarget.checked)}
                />
                <Select
                  label="Model"
                  placeholder="Select an LLM"
                  data={models}
                  value={aiModelKey}
                  onChange={setAiModelKey}
                  searchable
                  clearable
                  nothingFoundMessage="No LLM models in this project"
                  disabled={!aiEnabled}
                />
                <Textarea
                  label="Extra instructions (optional)"
                  description="Prepended to the interpretation prompt, e.g. tone or output format."
                  autosize
                  minRows={2}
                  value={aiInstructions}
                  onChange={(e) => setAiInstructions(e.currentTarget.value)}
                  disabled={!aiEnabled}
                />
              </div>
            </DetailCard>

            <DetailCard
              title="Configuration"
              description="Engine and search settings for this instance."
              actions={
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<IconEdit size={13} stroke={1.7} />}
                  onClick={() => void openEdit()}
                >
                  Edit configuration
                </Button>
              }
            >
              <div className="ds-col" style={{ gap: 8, fontSize: 13 }}>
                <div className="ds-row-between">
                  <span className="ds-muted">Engine</span>
                  <span className="ds-badge">{instance.driver}</span>
                </div>
                <div className="ds-row-between">
                  <span className="ds-muted">Key</span>
                  <span className="ds-mono">{instance.key}</span>
                </div>
                <div className="ds-row-between">
                  <span className="ds-muted">Status</span>
                  <StatusBadge status={instance.status === 'active' ? 'active' : 'paused'} />
                </div>
                <div className="ds-row-between">
                  <span className="ds-muted">Credentials</span>
                  {instance.hasCredentials ? (
                    <span className="ds-badge ds-badge-ok">configured</span>
                  ) : (
                    <span className="ds-faint">none</span>
                  )}
                </div>
                {settingString(instance, 'baseUrl') && (
                  <div className="ds-row-between">
                    <span className="ds-muted">Base URL</span>
                    <span className="ds-mono">{settingString(instance, 'baseUrl')}</span>
                  </div>
                )}
                {settingString(instance, 'language') && (
                  <div className="ds-row-between">
                    <span className="ds-muted">Language</span>
                    <span className="ds-mono">{settingString(instance, 'language')}</span>
                  </div>
                )}
                {settingString(instance, 'country') && (
                  <div className="ds-row-between">
                    <span className="ds-muted">Country / market</span>
                    <span className="ds-mono">{settingString(instance, 'country')}</span>
                  </div>
                )}
                {settingString(instance, 'safeSearch') && (
                  <div className="ds-row-between">
                    <span className="ds-muted">Safe search</span>
                    <span className="ds-mono">{settingString(instance, 'safeSearch')}</span>
                  </div>
                )}
                {instance.description && (
                  <div className="ds-row-between">
                    <span className="ds-muted">Description</span>
                    <span>{instance.description}</span>
                  </div>
                )}
              </div>
            </DetailCard>
          </div>
          <DetailCard
            title="Danger zone"
            description="Deleting an instance breaks API calls that use its key."
            danger
          >
            <Button
              color="red"
              variant="light"
              size="xs"
              leftSection={<IconTrash size={13} stroke={1.7} />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete instance
            </Button>
          </DetailCard>
        </DetailTwoCol>
      ) : null}

      <ProviderConfigModal
        opened={editOpen}
        onClose={() => setEditOpen(false)}
        mode="edit"
        provider={instance}
        drivers={drivers}
        driversLoading={driversLoading}
        domain="websearch"
        onSubmit={async (options) => {
          const updatePayload: Record<string, unknown> = {
            label: options.values.base.label,
            description: options.values.base.description,
            status: options.values.base.status,
            // The generic form only edits driver settings — preserve aiAnswer.
            settings: { ...options.values.settings, aiAnswer: aiAnswerOf(instance) },
            metadata: options.values.metadata,
          };
          if (Object.keys(options.values.credentials).length > 0) {
            updatePayload.credentials = options.values.credentials;
          }
          const res = await fetch(`/api/providers/${encodeURIComponent(String(instance._id))}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(updatePayload),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok) throw new Error(body?.error || 'Failed to update instance');
          notifications.show({ color: 'teal', title: 'Web Search', message: 'Instance updated' });
          setEditOpen(false);
          await load();
        }}
      />

      <Modal
        opened={logDetail !== null}
        onClose={() => setLogDetail(null)}
        title="Search detail"
        size="lg"
      >
        {logDetail && (
          <Stack gap="sm">
            <div className="ds-row-between" style={{ fontSize: 13 }}>
              <span className="ds-muted">Time</span>
              <span className="ds-mono">
                {logDetail.createdAt ? new Date(logDetail.createdAt).toLocaleString() : '—'}
              </span>
            </div>
            <div style={{ fontSize: 13 }}>
              <span className="ds-muted">Query</span>
              <div style={{ marginTop: 4, fontWeight: 500 }}>{logDetail.query}</div>
            </div>
            <Group gap="xs">
              {logDetail.status === 'success' ? (
                <span className="ds-badge ds-badge-ok">success</span>
              ) : (
                <span className="ds-badge ds-badge-err">error</span>
              )}
              <span className="ds-badge">{logDetail.resultCount} results</span>
              {typeof logDetail.latencyMs === 'number' && (
                <span className="ds-badge">{logDetail.latencyMs} ms</span>
              )}
              {logDetail.source && <span className="ds-badge">{logDetail.source}</span>}
              {(logDetail.metadata as Record<string, unknown> | undefined)?.answerModel ? (
                <span className="ds-badge ds-badge-ok">
                  <IconSparkles size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                  {String((logDetail.metadata as Record<string, unknown>).answerModel)}
                </span>
              ) : null}
            </Group>
            {logDetail.errorMessage && (
              <div className="ds-badge ds-badge-err" style={{ whiteSpace: 'normal' }}>
                {logDetail.errorMessage}
              </div>
            )}
            {logDetail.answer && (
              <div className="ds-card" style={{ padding: 12, fontSize: 13 }}>
                <span className="ds-badge ds-badge-ok" style={{ marginRight: 8 }}>answer</span>
                <span style={{ whiteSpace: 'pre-wrap' }}>{logDetail.answer}</span>
              </div>
            )}
            {(logDetail.results ?? []).length > 0 && (
              <Stack gap={8}>
                <span className="ds-muted" style={{ fontSize: 12 }}>Returned results</span>
                {(logDetail.results ?? []).map((r) => (
                  <div key={`${r.position}-${r.url}`} className="ds-col" style={{ gap: 2 }}>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ fontSize: 13, fontWeight: 500 }}
                    >
                      {r.position}. {r.title || r.url}
                      <IconExternalLink size={12} style={{ marginLeft: 4, verticalAlign: -1 }} />
                    </a>
                    <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{r.url}</span>
                    {r.snippet && (
                      <span className="ds-muted" style={{ fontSize: 12 }}>{r.snippet}</span>
                    )}
                  </div>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </Modal>

      <Modal
        opened={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete instance"
        centered
        size="sm"
      >
        <Stack gap="md">
          <span>
            Delete <strong>{instance.label}</strong>? API calls using key{' '}
            <code>{instance.key}</code> will start failing.
          </span>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button color="red" onClick={confirmDelete}>Delete</Button>
          </Group>
        </Stack>
      </Modal>
    </DetailShell>
  );
}
