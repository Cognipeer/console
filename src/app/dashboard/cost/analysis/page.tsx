'use client';

/**
 * Cost → Analysis — the deterministic optimization workbench.
 *
 * Two dimensions of the SAME structure:
 *   - Agents: analyse one agent's live traces (volume, per-call profile,
 *     system-prompt lint, repeated-tool-call waste, recurring errors)
 *   - Models: the model-dimension twin — window totals over sessions that
 *     used the model, per-call metrics narrowed to that model's ai_calls,
 *     plus which agents drive the model
 * Every metric is model-free and reproducible; cross-links jump into
 * observability (tracing) and the model matrix (parity).
 *
 * Data:
 *   GET /api/tracing/agents                      (agent picker)
 *   GET /api/tracing/dashboard                   (model picker)
 *   GET /api/tracing/agents/:name/overview       (agent analysis)
 *   GET /api/tracing/models/:name/overview       (model analysis)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Loader,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  IconBoxModel,
  IconChartHistogram,
  IconExternalLink,
  IconFlask,
  IconInfoCircle,
  IconRobot,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import { DetailCard } from '@/components/common/ui/DetailShell';

// ── Shared response shapes ─────────────────────────────────────────────────

interface WindowTotals {
  sessionsCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalTokens: number;
  averageTokensPerSession: number;
}

interface Insights {
  sampledSessions: number;
  perCall: {
    aiCalls: number;
    toolCalls: number;
    avgAiCallsPerSession: number;
    avgToolCallsPerSession: number;
    avgInputTokensPerAiCall: number | null;
  };
  toolMenu: {
    coveragePct: number;
    avgMenuSize: number | null;
    maxMenuSize: number | null;
    distinctTools: number;
    available: boolean;
  };
  /** Argument-schema complexity of the tool menu — what decides whether a
   *  smaller model can actually drive this agent. */
  toolComplexity?: {
    toolsAnalyzed: number;
    avgParams: number;
    maxParams: number;
    maxDepth: number;
    advancedSchemaTools: number;
    avgRequiredParams: number;
    score: number;
    band: 'simple' | 'moderate' | 'complex';
  };
  /** Language mix of the sampled traffic. */
  language?: {
    primary: string;
    primaryShare: number;
    nonEnglishShare: number;
    classified: number;
    samples: number;
  };
  promptProfile: {
    found: boolean;
    sourceSessionId?: string;
    capturedAt?: string;
    preview?: string;
    lint?: {
      chars: number;
      lines: number;
      estTokens: number;
      passed: number;
      warned: number;
      failed: number;
      checks: Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
    };
  };
  errorPatterns: Array<{ message: string; count: number; lastSeen: string | null }>;
  waste: {
    repeatedToolCalls: {
      callsAnalyzed: number;
      wastedCalls: number;
      topOffenders: Array<{
        tool: string;
        maxRepeatsInOneSession: number;
        sessionsAffected: number;
        totalWasted: number;
        argsPreview: string;
      }>;
    };
  };
}

interface StatusRow {
  status: string;
  count: number;
}

interface AgentOverviewResponse {
  analytics: {
    totals: WindowTotals;
    statuses: StatusRow[];
    insights?: Insights | null;
  };
}

interface ModelOverviewResponse {
  model: {
    name: string;
    sessionsCount: number;
    agentsCount: number;
  };
  analytics: {
    totals: WindowTotals;
    statuses: StatusRow[];
    agents: Array<{ name: string; sessionsCount: number }>;
    insights?: Insights | null;
  };
}

interface PickerOption {
  value: string;
  label: string;
}

const RANGES: Array<{ value: string; label: string; days: number }> = [
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '14', label: 'Last 14 days', days: 14 },
  { value: '30', label: 'Last 30 days', days: 30 },
];

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString();
}

function rangeFrom(range: string): string {
  const days = RANGES.find((r) => r.value === range)?.days ?? 14;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ── Shared cards (identical structure for both dimensions) ─────────────────

function WindowTotalsTiles({
  totals,
  statuses,
  scopeNote,
}: {
  totals: WindowTotals;
  statuses: StatusRow[];
  scopeNote?: string;
}) {
  const errorSessions = statuses
    .filter((s) => s.status === 'error' || s.status === 'failed')
    .reduce((sum, s) => sum + s.count, 0);
  const cacheHit = totals.totalInputTokens > 0
    ? totals.totalCachedInputTokens / totals.totalInputTokens
    : null;
  return (
    <div className="ds-stat-grid">
      <StatTile
        label={scopeNote ? `Sessions (${scopeNote})` : 'Sessions'}
        value={fmt(totals.sessionsCount)}
        delta={`${fmt(errorSessions)} errored (${totals.sessionsCount > 0 ? ((errorSessions / totals.sessionsCount) * 100).toFixed(1) : '0'}%)`}
      />
      <StatTile
        label="Total tokens"
        value={fmt(totals.totalTokens)}
        delta={`avg ${fmt(Math.round(totals.averageTokensPerSession))} / session`}
      />
      <StatTile
        label="Cache hit"
        value={cacheHit != null ? `${(cacheHit * 100).toFixed(1)}%` : '—'}
        delta={`${fmt(totals.totalCachedInputTokens)} cached of ${fmt(totals.totalInputTokens)} input`}
      />
      <StatTile
        label="Output share"
        value={
          totals.totalTokens > 0
            ? `${((totals.totalOutputTokens / totals.totalTokens) * 100).toFixed(1)}%`
            : '—'
        }
        delta="input-heavy loops = cache & prompt-size wins"
      />
    </div>
  );
}

function InsightTiles({ insights, modelScoped }: { insights: Insights; modelScoped?: boolean }) {
  return (
    <DetailCard
      title="Deterministic insights"
      description={`Computed from the ${insights.sampledSessions} most recent sessions' events${modelScoped ? " — AI-call metrics count only this model's calls" : ''} — no model involved, fully reproducible.`}
    >
      <div className="ds-stat-grid">
        <StatTile
          label="Tool menu / call"
          value={insights.toolMenu.available ? `${insights.toolMenu.avgMenuSize ?? '—'} tools` : 'not traced'}
          delta={
            insights.toolMenu.available
              ? `max ${insights.toolMenu.maxMenuSize} · ${insights.toolMenu.distinctTools} distinct · ${insights.toolMenu.coveragePct}% of AI calls`
              : 'upgrade agent-sdk to 0.9.2+ to record per-turn menus'
          }
        />
        <StatTile
          label="Tool schema complexity"
          value={
            insights.toolComplexity && insights.toolComplexity.toolsAnalyzed > 0
              ? insights.toolComplexity.band
              : 'not traced'
          }
          delta={
            insights.toolComplexity && insights.toolComplexity.toolsAnalyzed > 0
              ? `${insights.toolComplexity.toolsAnalyzed} schemas · depth ${insights.toolComplexity.maxDepth} · ${insights.toolComplexity.avgParams} params avg · ${insights.toolComplexity.advancedSchemaTools} advanced`
              : 'no readable argument schemas in the sample'
          }
        />
        <StatTile
          label="Traffic language"
          value={
            insights.language && insights.language.classified > 0
              ? insights.language.primary
              : 'undetermined'
          }
          delta={
            insights.language && insights.language.classified > 0
              ? `${Math.round(insights.language.primaryShare * 100)}% of ${insights.language.classified} classified samples · ${Math.round(insights.language.nonEnglishShare * 100)}% non-English`
              : 'samples too short or ambiguous to classify'
          }
        />
        <StatTile
          label="AI calls / session"
          value={insights.perCall.avgAiCallsPerSession.toFixed(1)}
          delta={`${fmt(insights.perCall.aiCalls)} in sample`}
        />
        <StatTile
          label="Tool calls / session"
          value={insights.perCall.avgToolCallsPerSession.toFixed(1)}
          delta={`${fmt(insights.perCall.toolCalls)} in sample`}
        />
        <StatTile
          label="Input tokens / AI call"
          value={fmt(insights.perCall.avgInputTokensPerAiCall)}
          delta="context replayed on every turn"
        />
        <StatTile
          label="System prompt"
          value={
            insights.promptProfile.found && insights.promptProfile.lint
              ? `~${fmt(insights.promptProfile.lint.estTokens)} tok`
              : 'not found'
          }
          delta={
            insights.promptProfile.found && insights.promptProfile.lint
              ? `${fmt(insights.promptProfile.lint.chars)} chars · ${insights.promptProfile.lint.lines} lines`
              : 'no system message in recent traces'
          }
        />
      </div>
    </DetailCard>
  );
}

function statusColor(status: 'pass' | 'warn' | 'fail'): string {
  return status === 'pass' ? 'teal' : status === 'warn' ? 'yellow' : 'red';
}

function PromptChecksCard({ profile }: { profile: Insights['promptProfile'] }) {
  if (!profile.found || !profile.lint) return null;
  const lint = profile.lint;
  return (
    <DetailCard
      title="System prompt checks"
      description="Deterministic lint over the live system prompt extracted from the freshest trace."
      actions={
        <Group gap={6}>
          <Badge size="sm" color="teal" variant="light">{lint.passed} pass</Badge>
          {lint.warned > 0 ? (
            <Badge size="sm" color="yellow" variant="light">{lint.warned} warn</Badge>
          ) : null}
          {lint.failed > 0 ? (
            <Badge size="sm" color="red" variant="light">{lint.failed} fail</Badge>
          ) : null}
        </Group>
      }
    >
      <Table.ScrollContainer minWidth={560}>
        <Table striped withTableBorder verticalSpacing={8}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={80}>Result</Table.Th>
              <Table.Th w={240}>Check</Table.Th>
              <Table.Th>Evidence</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {lint.checks.map((check) => (
              <Table.Tr key={check.id}>
                <Table.Td>
                  <Badge size="sm" variant="light" color={statusColor(check.status)}>
                    {check.status.toUpperCase()}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" fw={600}>{check.label}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {check.detail}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {profile.sourceSessionId ? (
        <Text size="xs" c="dimmed" mt={8}>
          Source: session{' '}
          <Anchor
            size="xs"
            href={`/dashboard/tracing/sessions/${profile.sourceSessionId}`}
            className="ds-mono"
          >
            {profile.sourceSessionId.slice(0, 24)}…
          </Anchor>
          {profile.capturedAt ? ` · ${new Date(profile.capturedAt).toLocaleString()}` : ''}
        </Text>
      ) : null}
    </DetailCard>
  );
}

function RepeatedCallsCard({ waste }: { waste?: Insights['waste']['repeatedToolCalls'] }) {
  return (
    <DetailCard
      title="Repeated tool calls"
      description="Identical (tool + arguments) calls repeated within a single session — every repeat re-pays the tool latency AND another model turn."
      actions={
        waste && waste.wastedCalls > 0 ? (
          <Badge size="sm" color="orange" variant="light">
            {waste.wastedCalls} wasted of {waste.callsAnalyzed} analysed
          </Badge>
        ) : (
          <Badge size="sm" color="teal" variant="light">none detected</Badge>
        )
      }
    >
      {waste && waste.topOffenders.length > 0 ? (
        <Table.ScrollContainer minWidth={680}>
          <Table striped withTableBorder verticalSpacing={8}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={220}>Tool</Table.Th>
                <Table.Th w={110} ta="right">Wasted calls</Table.Th>
                <Table.Th w={140} ta="right">Max / session</Table.Th>
                <Table.Th w={90} ta="right">Sessions</Table.Th>
                <Table.Th>Arguments</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {waste.topOffenders.map((o, i) => (
                <Table.Tr key={`${o.tool}-${i}`}>
                  <Table.Td>
                    <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>{o.tool}</Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" ff="monospace">{o.totalWasted}</Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" ff="monospace">{o.maxRepeatsInOneSession}×</Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" ff="monospace">{o.sessionsAffected}</Text>
                  </Table.Td>
                  <Table.Td style={{ maxWidth: 380 }}>
                    <Text size="xs" className="ds-mono" lineClamp={2} style={{ overflowWrap: 'anywhere' }}>
                      {o.argsPreview}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <Text size="sm" c="dimmed">
          No identical repeated calls in the sample
          {waste ? ` (${waste.callsAnalyzed} calls with readable arguments analysed).` : '.'}
        </Text>
      )}
    </DetailCard>
  );
}

function RecurringErrorsCard({ patterns }: { patterns: Insights['errorPatterns'] }) {
  if (patterns.length === 0) return null;
  return (
    <DetailCard
      title="Recurring errors"
      description="Most frequent error messages on the sessions in the selected range."
    >
      <Table.ScrollContainer minWidth={560}>
        <Table striped withTableBorder verticalSpacing={8}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Message</Table.Th>
              <Table.Th w={90} ta="right">Count</Table.Th>
              <Table.Th w={120}>Last seen</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {patterns.map((pattern) => (
              <Table.Tr key={pattern.message}>
                <Table.Td>
                  <Text size="xs" className="ds-mono" style={{ overflowWrap: 'anywhere' }}>
                    {pattern.message}
                  </Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Badge size="sm" color="red" variant="light">{pattern.count}×</Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {pattern.lastSeen ? new Date(pattern.lastSeen).toLocaleDateString() : '—'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </DetailCard>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function CostAnalysisPage() {
  const [dimension, setDimension] = useState<'agents' | 'models'>('agents');
  const [range, setRange] = useState('14');

  // Agent dimension state
  const [agents, setAgents] = useState<PickerOption[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentData, setAgentData] = useState<AgentOverviewResponse | null>(null);

  // Model dimension state
  const [models, setModels] = useState<PickerOption[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelData, setModelData] = useState<ModelOverviewResponse | null>(null);

  const [loading, setLoading] = useState(false);

  // Agent picker — lightweight directory endpoint.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/tracing/agents', { cache: 'no-store' });
        if (!res.ok) return;
        const payload = (await res.json()) as {
          agents?: Array<{ name: string; sessionsCount: number }>;
        };
        const options = (payload.agents ?? [])
          .filter((a) => a.name)
          .map((a) => ({
            value: a.name,
            label: `${a.name} (${a.sessionsCount.toLocaleString()} sessions)`,
          }));
        setAgents(options);
        if (options.length > 0) setAgent((current) => current ?? options[0].value);
      } finally {
        setAgentsLoading(false);
      }
    })();
  }, []);

  // Model picker — lazily from the tracing dashboard aggregate.
  useEffect(() => {
    if (dimension !== 'models' || modelsLoaded || modelsLoading) return;
    setModelsLoading(true);
    void (async () => {
      try {
        const res = await fetch('/api/tracing/dashboard', { cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        const list = (payload.analytics?.models ?? []) as Array<{
          model?: string;
          sessionsCount?: number;
        }>;
        const options = list
          .filter((m) => m.model)
          .map((m) => ({
            value: m.model as string,
            label: `${m.model} (${(m.sessionsCount ?? 0).toLocaleString()} sessions)`,
          }));
        setModels(options);
        if (options.length > 0) setModel((current) => current ?? options[0].value);
      } finally {
        setModelsLoading(false);
        setModelsLoaded(true);
      }
    })();
  }, [dimension, modelsLoaded, modelsLoading]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const target = dimension === 'agents' ? agent : model;
    if (!target) return;
    setLoading(true);
    try {
      const from = rangeFrom(range);
      const path = dimension === 'agents'
        ? `/api/tracing/agents/${encodeURIComponent(target)}/overview`
        : `/api/tracing/models/${encodeURIComponent(target)}/overview`;
      const res = await fetch(`${path}?from=${encodeURIComponent(from)}`, {
        cache: 'no-store',
        signal,
      });
      if (res.ok) {
        const payload = await res.json();
        if (dimension === 'agents') setAgentData(payload as AgentOverviewResponse);
        else setModelData(payload as ModelOverviewResponse);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [dimension, agent, model, range]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const active = dimension === 'agents' ? agent : model;
  const analytics = dimension === 'agents' ? agentData?.analytics : modelData?.analytics;
  const insights = analytics?.insights ?? null;
  const modelAgents = useMemo(
    () => (dimension === 'models' ? modelData?.analytics.agents ?? [] : []),
    [dimension, modelData],
  );
  const pickerLoading = dimension === 'agents' ? agentsLoading : modelsLoading;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Cost"
        title="Analysis"
        subtitle="Deterministic, reproducible metrics from live traces — analyse an agent or a model, then jump into optimization"
        actions={
          active ? (
            <Group gap="xs">
              {dimension === 'agents' ? (
                <Button
                  component="a"
                  href={`/dashboard/tracing/agents/${encodeURIComponent(active)}`}
                  variant="default"
                  size="sm"
                  leftSection={<IconExternalLink size={14} />}
                >
                  Full observability
                </Button>
              ) : null}
              <Button
                component="a"
                href="/dashboard/cost/parity"
                size="sm"
                leftSection={<IconFlask size={14} />}
              >
                Run model matrix
              </Button>
            </Group>
          ) : undefined
        }
      />

      <Group gap="sm" mb="lg" wrap="wrap">
        <SegmentedControl
          value={dimension}
          onChange={(value) => setDimension(value as 'agents' | 'models')}
          data={[
            { value: 'agents', label: 'Agents' },
            { value: 'models', label: 'Models' },
          ]}
        />
        {dimension === 'agents' ? (
          <Select
            w={340}
            placeholder={agentsLoading ? 'Loading agents…' : 'Select an agent'}
            data={agents}
            value={agent}
            onChange={setAgent}
            searchable
            leftSection={<IconRobot size={15} />}
          />
        ) : (
          <Select
            w={340}
            placeholder={modelsLoading ? 'Loading models…' : 'Select a model'}
            data={models}
            value={model}
            onChange={setModel}
            searchable
            leftSection={<IconBoxModel size={15} />}
          />
        )}
        <Select
          w={150}
          data={RANGES.map(({ value, label }) => ({ value, label }))}
          value={range}
          onChange={(v) => v && setRange(v)}
        />
        {loading ? <Loader size="sm" /> : null}
      </Group>

      {!active && !pickerLoading ? (
        <Alert color="blue" icon={<IconInfoCircle size={16} />}>
          {dimension === 'agents'
            ? 'No traced agents found — agent traffic appears here once tracing sessions are ingested.'
            : 'No traced models found — model usage appears here once tracing sessions are ingested.'}
        </Alert>
      ) : null}

      {active && analytics ? (
        <Stack gap="lg">
          <WindowTotalsTiles
            totals={analytics.totals}
            statuses={analytics.statuses}
            scopeNote={dimension === 'models' ? 'using this model' : undefined}
          />

          {insights ? (
            <>
              <InsightTiles insights={insights} modelScoped={dimension === 'models'} />

              {dimension === 'models' && modelAgents.length > 0 ? (
                <DetailCard
                  title="Agents using this model"
                  description="Sessions in the selected window that ran this model, by owning agent — jump into an agent to see its full analysis."
                >
                  <Table.ScrollContainer minWidth={480}>
                    <Table striped withTableBorder verticalSpacing={8}>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Agent</Table.Th>
                          <Table.Th w={110} ta="right">Sessions</Table.Th>
                          <Table.Th w={170} ta="right">Share</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {modelAgents.map((row) => (
                          <Table.Tr key={row.name}>
                            <Table.Td>
                              <Anchor
                                size="sm"
                                fw={600}
                                href={`/dashboard/tracing/agents/${encodeURIComponent(row.name)}`}
                              >
                                {row.name}
                              </Anchor>
                            </Table.Td>
                            <Table.Td ta="right">
                              <Text size="sm" ff="monospace">{fmt(row.sessionsCount)}</Text>
                            </Table.Td>
                            <Table.Td ta="right">
                              <Text size="sm" ff="monospace">
                                {analytics.totals.sessionsCount > 0
                                  ? `${((row.sessionsCount / analytics.totals.sessionsCount) * 100).toFixed(1)}%`
                                  : '—'}
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                </DetailCard>
              ) : null}

              <PromptChecksCard profile={insights.promptProfile} />
              <RepeatedCallsCard waste={insights.waste.repeatedToolCalls} />
              <RecurringErrorsCard patterns={insights.errorPatterns} />
            </>
          ) : null}
        </Stack>
      ) : null}
    </PageContainer>
  );
}
