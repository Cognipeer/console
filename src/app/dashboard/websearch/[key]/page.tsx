'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Fieldset,
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
  IconPlus,
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
import { useTranslations } from '@/lib/i18n';
import { useDeleteResource, ResourceUsageSection } from '@/components/common/confirm';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import WebSearchInstanceCreate from '@/components/websearch/WebSearchInstanceCreate';
import WebSearchInstanceFormModal from '@/components/websearch/WebSearchInstanceFormModal';
import { ConnectionCard, SearchOptionsCard } from '@/components/websearch/WebSearchInstanceCards';
import {
  canManageWebSearch,
  isUnavailable,
  providerOfRow,
  type WebSearchListRow,
} from '@/components/websearch/webSearchModel';
import type { WebSearchInstanceView } from '@/lib/services/webSearch/webSearchInstanceView';
import type {
  WebSearchAiAnswerSettings,
  WebSearchCacheSettings,
  WebSearchResult,
  WebSearchResultItem,
} from '@/lib/services/webSearch/types';
import type { IWebSearchRunLog } from '@/lib/database';

const LOGS_FETCH_LIMIT = 200;

type TabId = 'playground' | 'usage' | 'logs' | 'config';

type WithSettings = { settings?: Record<string, unknown> } | null;

function aiAnswerOf(p: WithSettings): WebSearchAiAnswerSettings {
  const raw = p?.settings?.aiAnswer;
  return raw && typeof raw === 'object' ? (raw as WebSearchAiAnswerSettings) : {};
}

function cacheOf(p: WithSettings): WebSearchCacheSettings {
  const raw = p?.settings?.cache;
  return raw && typeof raw === 'object' ? (raw as WebSearchCacheSettings) : { enabled: false };
}

/**
 * What the page is about: an instance, or a provider that has no instance yet (the compatible read answers for it;
 * searches through its key use the provider's own settings).
 */
type Loaded =
  | { kind: 'instance'; instance: WebSearchInstanceView }
  | { kind: 'provider'; provider: WebSearchListRow };

async function fetchLoaded(key: string): Promise<Loaded | null> {
  const res = await fetch(`/api/websearch/instances/${encodeURIComponent(key)}`, { cache: 'no-store' });
  if (res.ok) return { kind: 'instance', instance: ((await res.json()) as { instance: WebSearchInstanceView }).instance };
  if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
  const compat = await fetch(`/api/websearch/providers/${encodeURIComponent(key)}`, { cache: 'no-store' });
  if (compat.status === 404) return null;
  if (!compat.ok) throw new Error(`HTTP ${compat.status}`);
  const body = (await compat.json()) as { provider: WebSearchListRow; instance?: WebSearchInstanceView };
  return body.instance ? { kind: 'instance', instance: body.instance } : { kind: 'provider', provider: body.provider };
}

/** Cache outcome recorded on a run log (metadata.cache). */
function cacheStatusOf(log: IWebSearchRunLog): 'hit' | 'miss' | 'error' | undefined {
  const status = (log.metadata?.cache as { status?: string } | undefined)?.status;
  return status === 'hit' || status === 'miss' || status === 'error' ? status : undefined;
}

const CACHE_BADGE: Record<'hit' | 'miss' | 'error', { className: string; label: string }> = {
  hit: { className: 'ds-badge ds-badge-ok', label: 'cache hit' },
  miss: { className: 'ds-badge', label: 'cache miss' },
  error: { className: 'ds-badge ds-badge-warn', label: 'cache error' },
};

/** One search's result rows — the playground and the log detail show the same list. */
function ResultLinks({
  results,
}: {
  results: Array<Pick<WebSearchResultItem, 'position' | 'url' | 'title' | 'snippet'>>;
}) {
  return (
    <>
      {results.map((r) => (
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
    </>
  );
}

export default function WebSearchInstancePage() {
  const router = useRouter();
  const t = useTranslations('webSearch.detail');
  const tScope = useTranslations('webSearch.scope');
  const tNoInstance = useTranslations('webSearch.noInstance');
  const tPlatform = useTranslations('webSearch.platform');
  const tConfirm = useTranslations('common.confirm');
  const deleteResource = useDeleteResource();
  const canManage = canManageWebSearch(useDashboardUser()?.role);
  const params = useParams<{ key: string }>()!;
  const key = params.key;

  const [tab, setTab] = useState<TabId>('playground');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const instance = loaded?.kind === 'instance' ? loaded.instance : null;
  // A platform instance is the deployment's: it is searched and inspected here, never changed.
  const canEdit = canManage && instance !== null && !instance.platform;

  // Logs
  const [logs, setLogs] = useState<IWebSearchRunLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logQuery, setLogQuery] = useState('');
  const [logFrom, setLogFrom] = useState('');
  const [logTo, setLogTo] = useState('');
  const [logStatus, setLogStatus] = useState<string>('all');
  const [logDetail, setLogDetail] = useState<IWebSearchRunLog | null>(null);

  // The instance form: edit this instance, or create one on a provider that has none yet.
  const [editOpen, setEditOpen] = useState(false);
  const [editResetKey, setEditResetKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

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

  // Semantic cache settings (Configuration tab)
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheVectorProvider, setCacheVectorProvider] = useState<string | null>(null);
  const [cacheVectorIndex, setCacheVectorIndex] = useState<string | null>(null);
  const [cacheEmbeddingModel, setCacheEmbeddingModel] = useState<string | null>(null);
  const [cacheThreshold, setCacheThreshold] = useState<number | string>(0.8);
  const [cacheSaving, setCacheSaving] = useState(false);
  const [vectorProviders, setVectorProviders] = useState<Array<{ value: string; label: string }>>([]);
  const [vectorIndexes, setVectorIndexes] = useState<Array<{ value: string; label: string }>>([]);
  const [embeddingModels, setEmbeddingModels] = useState<Array<{ value: string; label: string }>>([]);

  const load = useCallback(async () => {
    try {
      const next = await fetchLoaded(key);
      if (!next) {
        notifications.show({ color: 'red', title: t('notFound'), message: key });
        router.push('/dashboard/websearch');
        return;
      }
      setLoaded(next);
      const own = next.kind === 'instance' ? next.instance : null;
      const ai = aiAnswerOf(own);
      setAiEnabled(ai.enabled === true);
      setAiModelKey(ai.modelKey ?? null);
      setAiInstructions(ai.instructions ?? '');
      const cache = cacheOf(own);
      setCacheEnabled(cache.enabled === true);
      setCacheVectorProvider(cache.vectorProviderKey ?? null);
      setCacheVectorIndex(cache.vectorIndexKey ?? null);
      setCacheEmbeddingModel(cache.embeddingModelKey ?? null);
      setCacheThreshold(cache.similarityThreshold ?? 0.8);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: t('loadFailed'),
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [key, router, t]);

  // An instance's runs are read through its own route; a provider without an instance through the compatible one.
  const loadedKind = loaded?.kind ?? null;
  const loadLogs = useCallback(async () => {
    if (!loadedKind) return;
    setLogsLoading(true);
    try {
      const searchParams = new URLSearchParams({ limit: String(LOGS_FETCH_LIMIT) });
      if (logFrom) searchParams.set('from', new Date(`${logFrom}T00:00:00`).toISOString());
      if (logTo) searchParams.set('to', new Date(`${logTo}T23:59:59.999`).toISOString());
      const base = loadedKind === 'instance' ? '/api/websearch/instances' : '/api/websearch/providers';
      const res = await fetch(
        `${base}/${encodeURIComponent(key)}/logs?${searchParams.toString()}`,
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
  }, [key, logFrom, logTo, loadedKind]);

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

  const loadCacheOptions = useCallback(async () => {
    try {
      const [providersRes, embeddingRes] = await Promise.all([
        fetch('/api/vector/providers', { cache: 'no-store' }),
        fetch('/api/models?category=embedding', { cache: 'no-store' }),
      ]);
      if (providersRes.ok) {
        const data = await providersRes.json();
        setVectorProviders(
          (data.providers ?? []).map((p: { key: string; label?: string }) => ({
            value: p.key,
            label: p.label ? `${p.label} (${p.key})` : p.key,
          })),
        );
      }
      if (embeddingRes.ok) {
        const data = await embeddingRes.json();
        setEmbeddingModels(
          (data.models ?? []).map((m: { key: string; name?: string }) => ({
            value: m.key,
            label: m.name ? `${m.name} (${m.key})` : m.key,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load cache options', err);
    }
  }, []);

  const loadCacheIndexes = useCallback(async (providerKey: string | null) => {
    if (!providerKey) {
      setVectorIndexes([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/vector/indexes?providerKey=${encodeURIComponent(providerKey)}`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const data = await res.json();
        setVectorIndexes(
          (data.indexes ?? []).map((idx: { key: string; name?: string }) => ({
            value: idx.key,
            label: idx.name ? `${idx.name} (${idx.key})` : idx.key,
          })),
        );
      } else {
        setVectorIndexes([]);
      }
    } catch (err) {
      console.error('Failed to load vector indexes', err);
      setVectorIndexes([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === 'config') void loadCacheOptions();
  }, [tab, loadCacheOptions]);

  useEffect(() => {
    if (tab === 'config') void loadCacheIndexes(cacheVectorProvider);
  }, [tab, cacheVectorProvider, loadCacheIndexes]);

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
    const aiAnswered = logs.filter((l) => l.metadata?.answerModel).length;
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
          // A provider without an instance is searched through its own key.
          ...(instance ? { instance: key } : { provider: key }),
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

  const openEdit = () => {
    setEditResetKey((current) => current + 1);
    setEditOpen(true);
  };

  /** The settings replace the stored ones: every setting the change leaves alone is sent as it is. */
  async function patchInstanceSettings(change: Record<string, unknown>, fallback: string) {
    if (!instance) return;
    const res = await fetch(`/api/websearch/instances/${encodeURIComponent(instance.key)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { ...instance.settings, ...change } }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || fallback);
    }
  }

  async function saveCacheSettings() {
    if (!instance) return;
    const threshold = typeof cacheThreshold === 'number' ? cacheThreshold : Number(cacheThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      notifications.show({
        color: 'red',
        title: 'Cache',
        message: 'Similarity threshold must be between 0 and 1.',
      });
      return;
    }
    if (cacheEnabled && (!cacheVectorProvider || !cacheVectorIndex || !cacheEmbeddingModel)) {
      notifications.show({
        color: 'red',
        title: 'Cache',
        message: 'Select a vector provider, a vector index and an embedding model before enabling the cache.',
      });
      return;
    }
    setCacheSaving(true);
    try {
      const cache: WebSearchCacheSettings = {
        enabled: cacheEnabled,
        vectorProviderKey: cacheVectorProvider ?? undefined,
        vectorIndexKey: cacheVectorIndex ?? undefined,
        embeddingModelKey: cacheEmbeddingModel ?? undefined,
        similarityThreshold: threshold,
      };
      await patchInstanceSettings({ cache }, 'Failed to save cache settings');
      notifications.show({ color: 'teal', title: 'Cache', message: 'Settings saved' });
      await load();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setCacheSaving(false);
    }
  }

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
      await patchInstanceSettings({ aiAnswer }, 'Failed to save AI settings');
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

  // Deletes the instance only: the provider it searches through stays.
  async function confirmDelete() {
    if (!instance) return;
    try {
      const deleted = await deleteResource({
        noun: tConfirm('nouns.websearchInstance'),
        name: instance.name,
        type: 'websearch-instance',
        id: String(instance._id),
        extraWarning: tConfirm('extras.websearchKeyFails'),
        action: async () => {
          const res = await fetch(`/api/websearch/instances/${encodeURIComponent(instance.key)}`, {
            method: 'DELETE',
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            throw new Error(body?.error || t('deleteFailed'));
          }
        },
      });
      if (!deleted) return;
      notifications.show({ color: 'teal', title: t('deleted'), message: instance.name });
      router.push('/dashboard/websearch');
    } catch (err) {
      notifications.show({
        color: 'red',
        title: t('deleteFailed'),
        message: err instanceof Error ? err.message : String(err),
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
      key: 'cache',
      label: 'Cache',
      render: (l) => {
        const status = cacheStatusOf(l);
        return status ? (
          <span className={CACHE_BADGE[status].className}>{status}</span>
        ) : (
          <span className="ds-faint">—</span>
        );
      },
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

  if (loading || !loaded) {
    return (
      <DetailShell
        backHref="/dashboard/websearch"
        title={loading ? t('loading') : t('notFound')}
      >
        <div />
      </DetailShell>
    );
  }

  // The header reads the same for an instance and for a provider that has no instance yet.
  const view = loaded.kind === 'instance'
    ? {
      name: loaded.instance.name,
      status: loaded.instance.status,
      platform: loaded.instance.platform,
      providerKey: loaded.instance.providerKey,
      provider: loaded.instance.provider,
    }
    : {
      name: loaded.provider.label,
      status: loaded.provider.status,
      platform: loaded.provider.platform === true,
      providerKey: loaded.provider.key,
      provider: providerOfRow(loaded.provider),
    };
  const aiConfigured = aiAnswerOf(instance).enabled === true;

  return (
    <DetailShell
      backHref="/dashboard/websearch"
      icon={<IconWorldSearch size={16} />}
      title={view.name}
      meta={
        <>
          {view.provider ? <Badge size="xs" variant="light">{view.provider.driver}</Badge> : null}
          <span className="ds-mono ds-faint" style={{ fontSize: 12 }}>{key}</span>
          <StatusBadge status={view.status === 'active' ? 'active' : 'paused'} />
          {view.platform ? <span className="ds-badge ds-badge-info">{tPlatform('badge')}</span> : null}
          {loaded.kind === 'provider' ? (
            <span className="ds-badge ds-badge-warn" title={tNoInstance('hint')}>{tNoInstance('badge')}</span>
          ) : null}
          {isUnavailable(view) ? (
            <span className="ds-badge ds-badge-warn" title={tPlatform('unavailableHint')}>{tPlatform('unavailable')}</span>
          ) : null}
          {aiConfigured && (
            <Badge size="xs" variant="light" color="grape">
              <IconSparkles size={10} style={{ verticalAlign: -1, marginRight: 2 }} />
              AI answer
            </Badge>
          )}
        </>
      }
      actions={canEdit ? (
        <Button
          variant="default"
          size="xs"
          leftSection={<IconEdit size={13} stroke={1.7} />}
          onClick={openEdit}
        >
          {t('edit')}
        </Button>
      ) : undefined}
      tabs={[
        { id: 'playground', label: 'Playground' },
        { id: 'usage', label: 'Usage' },
        { id: 'logs', label: 'Logs' },
        { id: 'config', label: 'Configuration' },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as TabId)}
    >
      {instance?.platform ? (
        <Alert variant="light" color="blue" title={tPlatform('badge')} mb="md">
          {tPlatform('readOnly')}
        </Alert>
      ) : null}
      {loaded.kind === 'provider' ? (
        <Alert variant="light" color="yellow" title={tNoInstance('title')} mb="md">
          <div className="ds-col" style={{ gap: 8 }}>
            <span>{tNoInstance('text')}</span>
            {canManage ? (
              <Button
                size="xs"
                color="teal"
                leftSection={<IconPlus size={13} stroke={1.7} />}
                onClick={() => setCreateOpen(true)}
                style={{ alignSelf: 'flex-start' }}
              >
                {tNoInstance('action')}
              </Button>
            ) : null}
          </div>
        </Alert>
      ) : null}

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
          {/* Only an own instance shows its settings: a platform one's are not known here. */}
          {withAnswer && !aiConfigured && instance && !instance.platform && (
            <div className="ds-faint" style={{ fontSize: 12, marginTop: 6 }}>
              AI answers are not enabled on this instance — results will come back without
              an AI answer. Enable them under Configuration → AI Answer.
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
                {searchResult.cache && (
                  <span
                    className={CACHE_BADGE[searchResult.cache.status].className}
                    style={{ marginLeft: 8 }}
                  >
                    {CACHE_BADGE[searchResult.cache.status].label}
                    {searchResult.cached && typeof searchResult.cache.similarity === 'number'
                      ? ` · ${searchResult.cache.similarity.toFixed(3)}`
                      : ''}
                  </span>
                )}
              </div>
              {searchResult.warnings?.map((warning) => (
                <div key={warning} className="ds-badge ds-badge-warn" style={{ marginBottom: 8, whiteSpace: 'normal' }}>
                  {warning}
                </div>
              ))}
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
                <ResultLinks results={searchResult.results} />
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
            {instance ? (
              <SearchOptionsCard
                provider={instance.provider}
                settings={instance.settings}
                setByPlatform={instance.platform}
                onEdit={canEdit ? openEdit : undefined}
              />
            ) : null}
            {/* A platform instance's settings belong to the deployment (the reply leaves them out); a provider without
                an instance has none. */}
            {instance && !instance.platform ? (
              <>
                <DetailCard
                  title="AI Answer"
                  description="Interpret search results with a model and return a synthesized answer (like Tavily). Requests asking for an answer fail while this is disabled."
                  actions={canEdit ? (
                    <Button
                      size="xs"
                      color="teal"
                      leftSection={<IconDeviceFloppy size={13} stroke={1.7} />}
                      loading={aiSaving}
                      onClick={() => void saveAiSettings()}
                    >
                      Save
                    </Button>
                  ) : undefined}
                >
                  <Fieldset variant="unstyled" disabled={!canEdit} className="ds-col" style={{ gap: 12 }}>
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
                  </Fieldset>
                </DetailCard>

                <DetailCard
                  title="Semantic cache"
                  description="Reuse results of similar earlier queries instead of calling the search engine. Entries are isolated per project and instance and depend on the result options (count, offset, language, country, safe search)."
                  actions={canEdit ? (
                    <Button
                      size="xs"
                      color="teal"
                      leftSection={<IconDeviceFloppy size={13} stroke={1.7} />}
                      loading={cacheSaving}
                      onClick={() => void saveCacheSettings()}
                    >
                      Save
                    </Button>
                  ) : undefined}
                >
                  <Fieldset variant="unstyled" disabled={!canEdit} className="ds-col" style={{ gap: 12 }}>
                    <Switch
                      label="Cache enabled"
                      description="Embeds each query and searches the selected vector index before calling the search engine."
                      checked={cacheEnabled}
                      onChange={(e) => setCacheEnabled(e.currentTarget.checked)}
                    />
                    <Select
                      label="Vector provider"
                      placeholder="Select a vector provider"
                      data={vectorProviders}
                      value={cacheVectorProvider}
                      onChange={(value) => {
                        setCacheVectorProvider(value);
                        setCacheVectorIndex(null);
                      }}
                      searchable
                      clearable
                      nothingFoundMessage="No vector providers in this project"
                      disabled={!cacheEnabled}
                    />
                    <Select
                      label="Vector index"
                      placeholder="Select an index"
                      description="Use an index whose dimension matches the embedding model."
                      data={vectorIndexes}
                      value={cacheVectorIndex}
                      onChange={setCacheVectorIndex}
                      searchable
                      clearable
                      nothingFoundMessage="No indexes for this provider"
                      disabled={!cacheEnabled || !cacheVectorProvider}
                    />
                    <Select
                      label="Embedding model"
                      placeholder="Select an embedding model"
                      data={embeddingModels}
                      value={cacheEmbeddingModel}
                      onChange={setCacheEmbeddingModel}
                      searchable
                      clearable
                      nothingFoundMessage="No embedding models in this project"
                      disabled={!cacheEnabled}
                    />
                    <NumberInput
                      label="Similarity threshold"
                      description="0 to 1. A cached query is reused when its similarity is at least this value."
                      min={0}
                      max={1}
                      step={0.05}
                      decimalScale={2}
                      value={cacheThreshold}
                      onChange={setCacheThreshold}
                      disabled={!cacheEnabled}
                    />
                  </Fieldset>
                </DetailCard>
              </>
            ) : null}

            <ConnectionCard
              providerKey={view.providerKey}
              provider={view.provider}
              canOpenProvider={canManage}
              scope={instance ? tScope(instance.tenantWide ? 'tenant' : 'project') : undefined}
            />
          </div>
          <div className="ds-col" style={{ gap: 16 }}>
            <DetailCard>
              {loaded.kind === 'instance' ? (
                <ResourceUsageSection type="websearch-instance" id={String(loaded.instance._id)} />
              ) : (
                <ResourceUsageSection type="provider" id={String(loaded.provider._id)} />
              )}
            </DetailCard>
            {canEdit ? (
              <DetailCard title={t('dangerTitle')} description={t('dangerDescription')} danger>
                <Button
                  color="red"
                  variant="light"
                  size="xs"
                  leftSection={<IconTrash size={13} stroke={1.7} />}
                  onClick={() => void confirmDelete()}
                >
                  {t('deleteInstance')}
                </Button>
              </DetailCard>
            ) : null}
          </div>
        </DetailTwoCol>
      ) : null}

      {instance && canEdit ? (
        <WebSearchInstanceFormModal
          opened={editOpen}
          onClose={() => setEditOpen(false)}
          mode="edit"
          instance={instance}
          resetKey={editResetKey}
          onSaved={() => {
            setEditOpen(false);
            void load();
          }}
        />
      ) : null}

      {loaded.kind === 'provider' && canManage ? (
        <WebSearchInstanceCreate
          opened={createOpen}
          onClose={() => setCreateOpen(false)}
          initialProviderKey={loaded.provider.key}
          onCreated={(created) => {
            setCreateOpen(false);
            // An instance that took this provider's key is now what this page shows.
            if (created.key === key) void load();
            else router.push(`/dashboard/websearch/${encodeURIComponent(created.key)}`);
          }}
        />
      ) : null}

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
              {cacheStatusOf(logDetail) && (
                <span className={CACHE_BADGE[cacheStatusOf(logDetail)!].className}>
                  {CACHE_BADGE[cacheStatusOf(logDetail)!].label}
                </span>
              )}
              {logDetail.metadata?.answerModel ? (
                <span className="ds-badge ds-badge-ok">
                  <IconSparkles size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
                  {String(logDetail.metadata.answerModel)}
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
                <ResultLinks results={logDetail.results ?? []} />
              </Stack>
            )}
          </Stack>
        )}
      </Modal>
    </DetailShell>
  );
}
