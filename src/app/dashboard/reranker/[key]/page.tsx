'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  NumberInput,
  Select,
  Switch,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowsSort,
  IconDeviceFloppy,
  IconPlayerPlay,
} from '@tabler/icons-react';
import DetailShell, {
  DetailCard,
  DetailTwoCol,
} from '@/components/common/ui/DetailShell';

interface RerankerView {
  _id: string;
  key: string;
  name: string;
  description?: string;
  strategy: 'dedicated-model' | 'llm-judge' | 'llm-listwise' | 'heuristic' | 'fusion';
  config: {
    modelKey?: string;
    topN?: number;
    scoreThreshold?: number;
    batchSize?: number;
    temperature?: number;
    promptTemplate?: string;
    scoreNormalization?: 'none' | 'minmax';
  };
  status: 'active' | 'disabled';
  totalRuns?: number;
  avgLatencyMs?: number;
  lastUsedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface RunResultItem {
  index: number;
  id?: string;
  score: number;
  originalScore?: number;
  content: string;
}

interface RunResult {
  rerankerKey: string;
  strategy: string;
  modelKey?: string;
  results: RunResultItem[];
  latencyMs: number;
  inputCount: number;
  outputCount: number;
}

interface ModelOption {
  key: string;
  name: string;
}

const STRATEGY_LABEL: Record<string, string> = {
  'dedicated-model': 'Dedicated rerank model',
  'llm-judge': 'LLM judge',
  'llm-listwise': 'LLM listwise',
  heuristic: 'Heuristic',
  fusion: 'Fusion',
};

function modelCategoryFor(strategy: string): string {
  if (strategy === 'dedicated-model') return 'rerank';
  if (strategy === 'llm-judge' || strategy === 'llm-listwise') return 'llm';
  return '';
}

export default function RerankerDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = use(params);

  const [reranker, setReranker] = useState<RerankerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [tab, setTab] = useState<'config' | 'playground' | 'runs'>('config');

  // Playground state
  const [pgQuery, setPgQuery] = useState('What is RAG?');
  const [pgDocs, setPgDocs] = useState(
    [
      'Retrieval-augmented generation (RAG) lets LLMs answer questions over private data.',
      'Cats are mammals known for purring and hunting small prey.',
      'In RAG pipelines, embeddings turn text into vectors for semantic search.',
      'The Eiffel Tower is located in Paris.',
    ].join('\n---\n'),
  );
  const [pgTopN, setPgTopN] = useState<number | ''>(3);
  const [pgRunning, setPgRunning] = useState(false);
  const [pgResult, setPgResult] = useState<RunResult | null>(null);

  // Runs tab
  const [runs, setRuns] = useState<
    Array<{
      _id: string;
      query: string;
      inputCount: number;
      outputCount: number;
      latencyMs?: number;
      status: string;
      errorMessage?: string;
      createdAt?: string;
    }>
  >([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/reranker/${encodeURIComponent(key)}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load reranker');
      const data = await res.json();
      setReranker(data.reranker);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to load reranker',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
    }
  }, [key]);

  const loadModels = useCallback(
    async (category: string) => {
      if (!category) {
        setModels([]);
        return;
      }
      const res = await fetch(`/api/models?category=${category}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setModels(
          (data.models ?? []).map((m: Record<string, string>) => ({
            key: m.key,
            name: m.name,
          })),
        );
      }
    },
    [],
  );

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/reranker/${encodeURIComponent(key)}/runs?limit=50`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        setRuns(data.logs ?? []);
      }
    } catch (err) {
      console.error('Failed to load runs', err);
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reranker) void loadModels(modelCategoryFor(reranker.strategy));
  }, [reranker, loadModels]);

  useEffect(() => {
    if (tab === 'runs') void loadRuns();
  }, [tab, loadRuns]);

  const handleSave = async () => {
    if (!reranker) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/reranker/${encodeURIComponent(reranker.key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: reranker.name,
          description: reranker.description,
          strategy: reranker.strategy,
          config: reranker.config,
          status: reranker.status,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to save');
      }
      const data = await res.json();
      setReranker(data.reranker);
      notifications.show({ color: 'green', title: 'Saved', message: 'Reranker updated.' });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Save failed',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async () => {
    if (!reranker) return;
    setPgRunning(true);
    setPgResult(null);
    try {
      const docs = pgDocs
        .split(/\n---\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((content) => ({ content }));
      if (docs.length === 0) {
        throw new Error('Add at least one document (separate documents with `---` on its own line).');
      }
      const res = await fetch(`/api/reranker/${encodeURIComponent(reranker.key)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: pgQuery,
          documents: docs,
          topN: pgTopN === '' ? undefined : Number(pgTopN),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Run failed');
      }
      const data = await res.json();
      setPgResult(data.result);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Run failed',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setPgRunning(false);
    }
  };

  const updateConfig = (patch: Partial<RerankerView['config']>) => {
    if (!reranker) return;
    setReranker({ ...reranker, config: { ...reranker.config, ...patch } });
  };

  const needsModel = reranker && reranker.strategy !== 'heuristic' && reranker.strategy !== 'fusion';

  const meta = useMemo(() => {
    if (!reranker) return null;
    return (
      <>
        <span className="ds-faint ds-mono" style={{ fontSize: 12 }}>
          {reranker.key}
        </span>
        <Badge size="xs" variant="light">
          {STRATEGY_LABEL[reranker.strategy] ?? reranker.strategy}
        </Badge>
        {reranker.config?.modelKey ? (
          <Badge size="xs" variant="light" color="grape">
            {reranker.config.modelKey}
          </Badge>
        ) : null}
      </>
    );
  }, [reranker]);

  if (loading || !reranker) {
    return (
      <DetailShell
        backHref="/dashboard/reranker"
        title={loading ? 'Loading…' : 'Reranker not found'}
      >
        <div />
      </DetailShell>
    );
  }

  return (
    <DetailShell
      backHref="/dashboard/reranker"
      icon={<IconArrowsSort size={16} />}
      title={reranker.name}
      meta={meta}
      actions={
        <Button
          color="teal"
          size="sm"
          leftSection={<IconDeviceFloppy size={14} />}
          loading={saving}
          onClick={handleSave}
        >
          Save changes
        </Button>
      }
      tabs={[
        { id: 'config', label: 'Configuration' },
        { id: 'playground', label: 'Playground' },
        { id: 'runs', label: 'Runs' },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as typeof tab)}
    >
      {tab === 'config' ? (
        <DetailTwoCol>
          <div>
            <DetailCard
              title="Identity"
              description="How this reranker is identified."
            >
              <div className="ds-col" style={{ gap: 12 }}>
                <TextInput
                  label="Name"
                  value={reranker.name}
                  onChange={(e) => setReranker({ ...reranker, name: e.currentTarget.value })}
                />
                <Textarea
                  label="Description"
                  autosize
                  minRows={2}
                  value={reranker.description ?? ''}
                  onChange={(e) =>
                    setReranker({ ...reranker, description: e.currentTarget.value })
                  }
                />
                <Switch
                  label="Active"
                  checked={reranker.status === 'active'}
                  onChange={(e) =>
                    setReranker({
                      ...reranker,
                      status: e.currentTarget.checked ? 'active' : 'disabled',
                    })
                  }
                />
              </div>
            </DetailCard>

            <div style={{ marginTop: 12 }}>
              <DetailCard
                title="Strategy"
                description="Strategy can be switched, but make sure the backing model category matches."
              >
                <div className="ds-col" style={{ gap: 12 }}>
                  <Select
                    label="Strategy"
                    data={[
                      { value: 'dedicated-model', label: 'Dedicated rerank model' },
                      { value: 'llm-judge', label: 'LLM judge' },
                      { value: 'llm-listwise', label: 'LLM listwise' },
                      { value: 'heuristic', label: 'Heuristic (no model)' },
                    ]}
                    value={reranker.strategy}
                    onChange={(v) =>
                      v
                        && setReranker({
                          ...reranker,
                          strategy: v as RerankerView['strategy'],
                          config: { ...reranker.config, modelKey: undefined },
                        })
                    }
                  />
                  {needsModel ? (
                    <Select
                      label="Backing model"
                      placeholder="Select a model"
                      data={models.map((m) => ({ value: m.key, label: m.name }))}
                      value={reranker.config.modelKey ?? null}
                      onChange={(v) => updateConfig({ modelKey: v ?? undefined })}
                      searchable
                    />
                  ) : null}
                </div>
              </DetailCard>
            </div>
          </div>

          <div>
            <DetailCard
              title="Parameters"
              description="Defaults applied when this reranker runs."
            >
              <div className="ds-col" style={{ gap: 12 }}>
                <NumberInput
                  label="Default topN"
                  min={1}
                  max={1000}
                  value={reranker.config.topN ?? ''}
                  onChange={(v) =>
                    updateConfig({ topN: typeof v === 'number' ? v : undefined })
                  }
                />
                <NumberInput
                  label="Score threshold"
                  min={0}
                  max={1}
                  step={0.05}
                  decimalScale={3}
                  value={reranker.config.scoreThreshold ?? ''}
                  onChange={(v) =>
                    updateConfig({ scoreThreshold: typeof v === 'number' ? v : undefined })
                  }
                />
                {reranker.strategy === 'llm-judge' ? (
                  <NumberInput
                    label="Batch size"
                    min={1}
                    max={32}
                    value={reranker.config.batchSize ?? ''}
                    onChange={(v) =>
                      updateConfig({ batchSize: typeof v === 'number' ? v : undefined })
                    }
                  />
                ) : null}
                {(reranker.strategy === 'llm-judge' || reranker.strategy === 'llm-listwise') ? (
                  <>
                    <NumberInput
                      label="Temperature"
                      min={0}
                      max={2}
                      step={0.1}
                      decimalScale={2}
                      value={reranker.config.temperature ?? ''}
                      onChange={(v) =>
                        updateConfig({ temperature: typeof v === 'number' ? v : undefined })
                      }
                    />
                    <Textarea
                      label="Prompt template"
                      description="Use {{query}} and {{document}} placeholders."
                      autosize
                      minRows={4}
                      value={reranker.config.promptTemplate ?? ''}
                      onChange={(e) =>
                        updateConfig({ promptTemplate: e.currentTarget.value || undefined })
                      }
                    />
                  </>
                ) : null}
                <Select
                  label="Score normalization"
                  data={[
                    { value: 'none', label: 'None' },
                    { value: 'minmax', label: 'Min–max → [0, 1]' },
                  ]}
                  value={reranker.config.scoreNormalization ?? 'none'}
                  onChange={(v) =>
                    updateConfig({ scoreNormalization: (v as 'none' | 'minmax') ?? 'none' })
                  }
                />
              </div>
            </DetailCard>
          </div>
        </DetailTwoCol>
      ) : null}

      {tab === 'playground' ? (
        <DetailTwoCol>
          <div>
            <DetailCard title="Input">
              <div className="ds-col" style={{ gap: 12 }}>
                <TextInput
                  label="Query"
                  value={pgQuery}
                  onChange={(e) => setPgQuery(e.currentTarget.value)}
                />
                <Textarea
                  label="Documents"
                  description="Separate documents with a line containing only `---`."
                  autosize
                  minRows={10}
                  value={pgDocs}
                  onChange={(e) => setPgDocs(e.currentTarget.value)}
                />
                <NumberInput
                  label="topN"
                  min={1}
                  max={100}
                  value={pgTopN}
                  onChange={(v) => setPgTopN(typeof v === 'number' ? v : '')}
                />
                <Button
                  leftSection={<IconPlayerPlay size={14} />}
                  onClick={handleRun}
                  loading={pgRunning}
                  color="teal"
                >
                  Run reranker
                </Button>
              </div>
            </DetailCard>
          </div>

          <div>
            <DetailCard
              title="Results"
              description={
                pgResult
                  ? `${pgResult.outputCount}/${pgResult.inputCount} returned · ${pgResult.latencyMs}ms`
                  : 'Run the reranker to see results here.'
              }
            >
              {pgResult ? (
                <div className="ds-col" style={{ gap: 8 }}>
                  {pgResult.results.map((r, i) => (
                    <div
                      key={`${r.index}-${i}`}
                      style={{
                        padding: 10,
                        borderRadius: 8,
                        background: 'var(--ds-surface-2, rgba(0,0,0,0.03))',
                        display: 'flex',
                        gap: 12,
                      }}
                    >
                      <div
                        style={{
                          minWidth: 64,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-end',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 600 }}>
                          {r.score.toFixed(3)}
                        </span>
                        {typeof r.originalScore === 'number' ? (
                          <span className="ds-faint" style={{ fontSize: 11 }}>
                            was {r.originalScore.toFixed(3)}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ flex: 1, fontSize: 13, whiteSpace: 'pre-wrap' }}>
                        {r.content}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ds-muted" style={{ fontSize: 13 }}>
                  No run yet.
                </div>
              )}
            </DetailCard>
          </div>
        </DetailTwoCol>
      ) : null}

      {tab === 'runs' ? (
        <DetailCard title="Recent runs" description="Last 50 runs (any source).">
          {runs.length === 0 ? (
            <div className="ds-muted" style={{ fontSize: 13 }}>
              No runs recorded yet.
            </div>
          ) : (
            <div className="ds-col" style={{ gap: 6 }}>
              {runs.map((r) => (
                <div
                  key={r._id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto auto',
                    gap: 12,
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'var(--ds-surface-2, rgba(0,0,0,0.03))',
                    fontSize: 12.5,
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={r.query}
                  >
                    {r.query}
                  </div>
                  <span className="ds-mono ds-faint">
                    {r.inputCount} → {r.outputCount}
                  </span>
                  <span className="ds-mono">
                    {typeof r.latencyMs === 'number' ? `${r.latencyMs}ms` : '—'}
                  </span>
                  <Badge size="xs" color={r.status === 'success' ? 'teal' : 'red'}>
                    {r.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </DetailCard>
      ) : null}
    </DetailShell>
  );
}
