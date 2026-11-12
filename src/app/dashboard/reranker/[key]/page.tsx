'use client';

import { use, useEffect, useMemo, useState } from 'react';
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
import { errorMessage } from '@/lib/api/client';
import { NO_MODEL_OPTIONS, useModelOptions } from '@/lib/api/queries/models';
import {
  useReranker,
  useRerankerRuns,
  useRunReranker,
  useUpdateReranker,
  type RerankerView,
  type RerankerRunResult as RunResult,
} from '@/lib/api/queries/reranker';
import { ResourceUsageSection } from '@/components/common/confirm';
import DetailShell, {
  DetailCard,
  DetailTwoCol,
} from '@/components/common/ui/DetailShell';

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

  const { data: serverReranker, isPending: loading } = useReranker(key);
  // The editable copy: it starts from the server's reranker and is replaced when a save returns.
  const [reranker, setReranker] = useState<RerankerView | null>(null);
  const updateReranker = useUpdateReranker();
  const runReranker = useRunReranker();
  const saving = updateReranker.isPending;
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
  const pgRunning = runReranker.isPending;
  const [pgResult, setPgResult] = useState<RunResult | null>(null);

  const { data: runs = [] } = useRerankerRuns(key, tab === 'runs');
  const models = useModelOptions(reranker ? modelCategoryFor(reranker.strategy) : '').data ?? NO_MODEL_OPTIONS;

  useEffect(() => {
    if (serverReranker) setReranker(serverReranker);
  }, [serverReranker]);

  const handleSave = async () => {
    if (!reranker) return;
    try {
      const saved = await updateReranker.mutateAsync({
        key: reranker.key,
        name: reranker.name,
        description: reranker.description,
        strategy: reranker.strategy,
        config: reranker.config,
        status: reranker.status,
      });
      setReranker(saved);
      notifications.show({ color: 'green', title: 'Saved', message: 'Reranker updated.' });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Save failed',
        message: errorMessage(error, 'Unexpected error'),
      });
    }
  };

  const handleRun = async () => {
    if (!reranker) return;
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
      const result = await runReranker.mutateAsync({
        key: reranker.key,
        query: pgQuery,
        documents: docs,
        topN: pgTopN === '' ? undefined : Number(pgTopN),
      });
      setPgResult(result);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Run failed',
        message: errorMessage(error, 'Unexpected error'),
      });
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
      <DetailCard>
        <ResourceUsageSection type="reranker" id={reranker._id} />
      </DetailCard>
    </DetailShell>
  );
}
