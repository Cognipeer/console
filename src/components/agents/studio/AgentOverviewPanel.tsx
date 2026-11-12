'use client';

/**
 * Overview — the landing tab.
 *
 * Answers "is this agent healthy, how much is it used, and how do I call it"
 * in one screen. The numbers come from the agent's TRACES, not its dashboard
 * sessions: every run on every channel — API, OpenAI-compatible, A2A,
 * triggers, the playground — writes a trace, whereas a session
 * list only knows about conversations started from this page. Showing the
 * session list here made an agent serving thousands of API calls look idle.
 */

import { FlowOverviewBadge } from '@/components/enterprise/EnterpriseFlowAgentUi';
import { useMemo, useState } from 'react';
import {
    ActionIcon,
    Badge,
    Box,
    Button,
    Card,
    Code,
    CopyButton,
    Group,
    SegmentedControl,
    SimpleGrid,
    Skeleton,
    Stack,
    Text,
    ThemeIcon,
    Tooltip,
} from '@mantine/core';
import {
    IconActivity,
    IconAlertTriangle,
    IconCheck,
    IconClock,
    IconCode,
    IconCopy,
    IconGitBranch,
    IconMessageCircle,
    IconPlus,
    IconTool,
} from '@tabler/icons-react';
import SectionCard from '@/components/common/SectionCard';
import type { ResourceEdgeView } from '@/components/resources/ResourceUsagePanel';
import { tryTranslate } from '@/components/resources/i18nLookup';
import { useTranslations } from '@/lib/i18n';
import { useAgentTracingOverview } from '@/lib/api/queries/agents';
import type { IAgentVariable } from '@/lib/database/provider/types.domain';
import { formatDuration, formatNumber } from '@/lib/utils/tracingUtils';
import { chatCompletionsCurl, sampleVariables } from '../agentUsageSnippets';
import { formatCompactTokens } from '../session/sessionUsage';
import classes from './AgentOverviewPanel.module.css';

interface OverviewAgent {
    key: string;
    name: string;
    description?: string;
    status: string;
    publishedVersion?: number | null;
    config?: {
        modelKey?: string;
        kind?: 'native' | 'external' | 'flow';
        toolBindings?: Array<{ toolNames?: string[] }>;
        knowledgeEngineKey?: string;
        memory?: { enabled?: boolean };
        subagents?: unknown[];
        skills?: unknown[];
    };
}

/** The slice of `/api/tracing/agents/:name/overview` this panel reads. */
interface TracingOverview {
    analytics: {
        totals: {
            sessionsCount: number;
            totalInputTokens: number;
            totalOutputTokens: number;
            averageDurationMs: number;
        };
        tools: { items: Array<{ toolName: string; totalCalls: number; errorCalls: number }> };
        statuses: Array<{ status: string; count: number }>;
        models: Array<{ model: string; sessionsCount: number }>;
        daily: Array<{ date: string; sessionsCount: number; totalTokens: number }>;
    };
    agent: { latestSessionAt: string | null };
}

export interface AgentOverviewPanelProps {
    agent: OverviewAgent;
    /** The variables a call has to supply: the published snapshot's, the draft's only while nothing is published. */
    variables?: ReadonlyArray<IAgentVariable> | null;
    /** The published snapshot is still being fetched, so the variables are not known yet: the quick start waits. */
    variablesLoading?: boolean;
    isConnected: boolean;
    sessionCount: number;
    onStartSession: () => void;
    onGoToTab: (tab: string) => void;
    /** Saved-but-unpublished sections (their headings), for "Needs attention". Empty when nothing differs. */
    unpublishedSections?: string[];
    /** References of this agent that do not resolve (missing, inactive, another project…), from the usage check. */
    brokenReferences?: ResourceEdgeView[];
}

/** Where in Build a reference of the given type is set, as a deep-link name (see the agent page's tab aliases). */
const REFERENCE_SECTION: Record<string, string> = {
    model: 'basic',
    guardrail: 'guardrails',
    'pii-policy': 'pii',
    'rag-module': 'knowledge',
    tool: 'tools',
    'mcp-server': 'tools',
    prompt: 'prompt',
    'memory-store': 'memory',
    skill: 'skills',
    agent: 'subagents',
    'file-bucket': 'files',
};

interface AttentionItem {
    key: string;
    tone: 'warn' | 'error';
    title: string;
    hint?: string;
    action: string;
    onAction: () => void;
}

/**
 * The few things on this page that ask for a decision, gathered at the top: changes not published yet, tools that
 * fail, runs that ended in an error, references that no longer resolve. Only signals the page already loads — no new
 * checks. Nothing to show, no card.
 */
function AttentionCard({ items, title }: { items: AttentionItem[]; title: string }) {
    if (items.length === 0) return null;
    return (
        <Card withBorder padding="md" radius="md" className={classes.attention} data-testid="agent-attention">
            <Group gap={8} mb="xs">
                <IconAlertTriangle size={16} className={classes.attentionIcon} />
                <Text fw={600} size="sm">{title}</Text>
                <Badge size="xs" variant="light" color="orange">{items.length}</Badge>
            </Group>
            <Stack gap={0}>
                {items.map((item) => (
                    <Group key={item.key} justify="space-between" wrap="nowrap" gap="md" className={classes.attentionRow}>
                        <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
                            <span className={classes.attentionDot} data-tone={item.tone} aria-hidden="true" />
                            <Stack gap={0} style={{ minWidth: 0 }}>
                                <Text size="sm" fw={500} truncate>{item.title}</Text>
                                {item.hint ? <Text size="xs" c="dimmed" truncate>{item.hint}</Text> : null}
                            </Stack>
                        </Group>
                        <Button size="compact-xs" variant="default" onClick={item.onAction} style={{ flexShrink: 0 }}>
                            {item.action}
                        </Button>
                    </Group>
                ))}
            </Stack>
        </Card>
    );
}

type WindowDays = '7' | '30';

/** Stat tiles by the width of the column they sit in (Overview has a right column), not by the window's. */
const STAT_COLS = { base: 1, '420px': 2, '620px': 3, '960px': 5 };

function StatCard({
    icon,
    label,
    value,
    hint,
    onClick,
}: {
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
    hint?: React.ReactNode;
    onClick?: () => void;
}) {
    return (
        <Card withBorder padding="md" radius="md" onClick={onClick} className={onClick ? classes.clickable : undefined}>
            <Group gap="sm" wrap="nowrap" align="flex-start">
                <ThemeIcon size={34} radius="md" variant="light" color="gray">{icon}</ThemeIcon>
                <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="xs" c="dimmed">{label}</Text>
                    <Text size="lg" fw={700} className={classes.num}>{value}</Text>
                    {hint ? <Text size="10px" c="dimmed">{hint}</Text> : null}
                </Stack>
            </Group>
        </Card>
    );
}

/** Every day in the window, zero-filled — a missing day is a quiet day, not a gap. */
function fillDays(daily: TracingOverview['analytics']['daily'], days: number) {
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const out: Array<{ date: string; runs: number; tokens: number }> = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
        const d = new Date();
        d.setDate(d.getDate() - offset);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const hit = byDate.get(key);
        out.push({ date: key, runs: hit?.sessionsCount ?? 0, tokens: hit?.totalTokens ?? 0 });
    }
    return out;
}

export default function AgentOverviewPanel({
    agent,
    variables,
    variablesLoading,
    isConnected,
    sessionCount,
    onStartSession,
    onGoToTab,
    unpublishedSections = [],
    brokenReferences = [],
}: AgentOverviewPanelProps) {
    const t = useTranslations('agents.overview.attention');
    const tResources = useTranslations('resources');
    const [windowDays, setWindowDays] = useState<WindowDays>('30');
    const overviewQuery = useAgentTracingOverview<TracingOverview>(agent.name, Number(windowDays));
    const overview = overviewQuery.data ?? null;
    const loading = overviewQuery.isPending;

    const totals = overview?.analytics.totals;
    const runs = totals?.sessionsCount ?? 0;
    const failed = (overview?.analytics.statuses ?? [])
        .filter((s) => s.status === 'error' || s.status === 'failed')
        .reduce((sum, s) => sum + s.count, 0);
    const successRate = runs > 0 ? (runs - failed) / runs : null;
    const days = useMemo(
        () => fillDays(overview?.analytics.daily ?? [], Number(windowDays)),
        [overview, windowDays],
    );
    const peak = Math.max(1, ...days.map((d) => d.runs));
    const tools = (overview?.analytics.tools.items ?? []).slice(0, 6);
    const models = (overview?.analytics.models ?? []).slice(0, 4);

    const boundTools = (agent.config?.toolBindings ?? []).reduce((sum, b) => sum + (b.toolNames?.length ?? 0), 0);

    const attention: AttentionItem[] = [];
    if (!isConnected && agent.config?.kind !== 'flow' && !agent.publishedVersion) {
        attention.push({
            key: 'never-published',
            tone: 'warn',
            title: t('neverPublished'),
            hint: t('neverPublishedHint'),
            action: t('review'),
            onAction: () => onGoToTab('versions'),
        });
    } else if (unpublishedSections.length > 0) {
        attention.push({
            key: 'unpublished',
            tone: 'warn',
            title: unpublishedSections.length === 1
                ? t('unpublishedOne')
                : t('unpublishedMany', { count: unpublishedSections.length }),
            hint: unpublishedSections.join(', '),
            action: t('review'),
            onAction: () => onGoToTab('versions'),
        });
    }
    if (!loading) {
        (overview?.analytics.tools.items ?? [])
            .filter((tool) => tool.errorCalls > 0)
            .sort((a, b) => b.errorCalls - a.errorCalls)
            .slice(0, 3)
            .forEach((tool) => attention.push({
                key: `tool:${tool.toolName}`,
                tone: 'error',
                title: tool.errorCalls === 1
                    ? t('toolFailedOnce', { tool: tool.toolName })
                    : t('toolFailed', { tool: tool.toolName, count: tool.errorCalls }),
                hint: t('lastDays', { days: windowDays }),
                action: t('openTools'),
                onAction: () => onGoToTab('tools'),
            }));
        if (failed > 0) {
            attention.push({
                key: 'runs-failed',
                tone: 'error',
                title: failed === 1 ? t('runsFailedOne') : t('runsFailedMany', { count: failed }),
                hint: t('lastDays', { days: windowDays }),
                action: t('openSessions'),
                onAction: () => onGoToTab('sessions'),
            });
        }
    }
    brokenReferences.forEach((edge, index) => {
        const type = tryTranslate(tResources, `types.${edge.other.type}`) ?? edge.other.type;
        attention.push({
            key: `ref:${edge.other.type}:${edge.other.key ?? edge.other.id ?? index}:${edge.field}`,
            tone: edge.severity === 'error' ? 'error' : 'warn',
            title: t('reference', {
                type,
                name: edge.other.name ?? edge.other.key ?? edge.other.id ?? '—',
                status: tryTranslate(tResources, `usage.status.${edge.status}`) ?? edge.status,
            }),
            action: t('openBuild'),
            onAction: () => onGoToTab(REFERENCE_SECTION[edge.other.type] ?? 'settings'),
        });
    });
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com';
    // The same call the Usage tab shows (`agent:<key>`, the variables the agent declares), here answered as one JSON.
    const quickCurl = chatCompletionsCurl({
        baseUrl: `${origin}/api/client/v1`,
        agentKey: agent.key,
        variables: sampleVariables(variables),
        stream: false,
    });

    return (
        <Stack gap="lg">
            <AttentionCard items={attention} title={t('title')} />
            <Group justify="space-between">
                <Text size="sm" c="dimmed">
                    Every run on every channel — API, OpenAI-compatible, A2A, triggers and sessions.
                </Text>
                <SegmentedControl
                    size="xs"
                    value={windowDays}
                    onChange={(v) => setWindowDays(v as WindowDays)}
                    data={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }]}
                />
            </Group>

            {loading ? (
                <SimpleGrid type="container" cols={STAT_COLS} spacing="md">
                    {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={84} radius="md" />)}
                </SimpleGrid>
            ) : (
                <SimpleGrid type="container" cols={STAT_COLS} spacing="md">
                    <StatCard
                        icon={<IconActivity size={17} />}
                        label="Runs"
                        value={formatNumber(runs)}
                        hint={`last ${windowDays} days`}
                        onClick={() => onGoToTab('sessions')}
                    />
                    <StatCard
                        icon={failed > 0 ? <IconAlertTriangle size={17} /> : <IconCheck size={17} />}
                        label="Success rate"
                        value={successRate === null ? '—' : `${(successRate * 100).toFixed(successRate === 1 ? 0 : 1)}%`}
                        hint={failed > 0 ? `${failed} failed` : runs > 0 ? 'no failures' : undefined}
                        onClick={() => onGoToTab('sessions')}
                    />
                    <StatCard
                        icon={<IconClock size={17} />}
                        label="Avg duration"
                        value={runs > 0 ? formatDuration(totals?.averageDurationMs ?? 0) : '—'}
                        hint="per run"
                    />
                    <StatCard
                        icon={<IconCode size={17} />}
                        label="Tokens"
                        value={runs > 0
                            ? `${formatCompactTokens(totals?.totalInputTokens ?? 0)} / ${formatCompactTokens(totals?.totalOutputTokens ?? 0)}`
                            : '—'}
                        hint="input / output"
                    />
                    <StatCard
                        icon={<IconGitBranch size={17} />}
                        label="Published"
                        value={isConnected ? 'remote' : agent.publishedVersion ? `v${agent.publishedVersion}` : 'never'}
                        hint={!isConnected && !agent.publishedVersion ? 'API channels cannot reach it yet' : agent.status}
                        onClick={() => onGoToTab('versions')}
                    />
                </SimpleGrid>
            )}

            <SectionCard title="Activity" description={`Runs per day, last ${windowDays} days.`}>
                {loading ? (
                    <Skeleton height={96} />
                ) : runs === 0 ? (
                    <Text size="sm" c="dimmed">No runs in this window yet.</Text>
                ) : (
                    <Group gap={3} align="flex-end" wrap="nowrap" className={classes.bars}>
                        {days.map((day) => (
                            <Tooltip
                                key={day.date}
                                withArrow
                                label={`${day.date} · ${day.runs} run${day.runs === 1 ? '' : 's'} · ${formatCompactTokens(day.tokens)} tokens`}
                            >
                                <Box
                                    className={classes.bar}
                                    data-empty={day.runs === 0 || undefined}
                                    style={{ height: `${Math.max(4, (day.runs / peak) * 100)}%` }}
                                />
                            </Tooltip>
                        ))}
                    </Group>
                )}
            </SectionCard>

            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                <SectionCard
                    title="Quick start"
                    description="Try it here, or call it from any OpenAI client."
                    actions={
                        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={onStartSession}>
                            Start session
                        </Button>
                    }
                >
                    <Stack gap="xs">
                        {variablesLoading ? (
                            <Skeleton height={96} />
                        ) : (
                            <Box className={classes.snippet}>
                                <Code block className={classes.snippetCode}>{quickCurl}</Code>
                                <CopyButton value={quickCurl}>
                                    {({ copied, copy }) => (
                                        <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                                            <ActionIcon size="sm" variant="subtle" className={classes.copy} onClick={copy}>
                                                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                                            </ActionIcon>
                                        </Tooltip>
                                    )}
                                </CopyButton>
                            </Box>
                        )}
                        <Group gap="xs">
                            <Button size="compact-xs" variant="subtle" onClick={() => onGoToTab('usage')}>
                                All channels & SDK examples
                            </Button>
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                leftSection={<IconMessageCircle size={12} />}
                                onClick={() => onGoToTab('sessions')}
                            >
                                {sessionCount} session{sessionCount === 1 ? '' : 's'}
                            </Button>
                        </Group>
                    </Stack>
                </SectionCard>

                <SectionCard
                    title="Tools in use"
                    description={`Runs that called each tool, last ${windowDays} days.`}
                    actions={
                        <Button size="compact-xs" variant="subtle" onClick={() => onGoToTab('settings')}>
                            {boundTools} bound
                        </Button>
                    }
                >
                    {loading ? (
                        <Skeleton height={96} />
                    ) : tools.length === 0 ? (
                        <Text size="sm" c="dimmed">
                            {boundTools > 0 ? 'Bound tools have not been called in this window.' : 'No tools bound.'}
                        </Text>
                    ) : (
                        <Stack gap={6}>
                            {tools.map((tool) => (
                                <Group key={tool.toolName} justify="space-between" wrap="nowrap">
                                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                                        <IconTool size={13} className={classes.dim} />
                                        <Text size="sm" ff="monospace" truncate>{tool.toolName}</Text>
                                    </Group>
                                    <Group gap={6} wrap="nowrap">
                                        {tool.errorCalls > 0 ? (
                                            <Badge size="xs" variant="light" color="red">{tool.errorCalls} failed</Badge>
                                        ) : null}
                                        <Text size="xs" c="dimmed" className={classes.num}>{formatNumber(tool.totalCalls)}</Text>
                                    </Group>
                                </Group>
                            ))}
                        </Stack>
                    )}
                    {models.length > 0 ? (
                        <Group gap={6} mt="md">
                            <Text size="xs" c="dimmed">Models:</Text>
                            {models.map((m) => (
                                <Badge key={m.model} size="xs" variant="outline" color="gray">{m.model}</Badge>
                            ))}
                        </Group>
                    ) : null}
                </SectionCard>
            </SimpleGrid>

            {agent.config?.kind === 'flow' ? (
                <FlowOverviewBadge />
            ) : !isConnected ? (
                <Group gap="xs">
                    {agent.config?.knowledgeEngineKey ? <Badge variant="outline" color="blue">knowledge engine</Badge> : null}
                    {agent.config?.memory?.enabled ? <Badge variant="outline" color="grape">memory</Badge> : null}
                    {agent.config?.subagents?.length ? (
                        <Badge variant="outline" color="violet">{agent.config.subagents.length} sub-agents</Badge>
                    ) : null}
                    {agent.config?.skills?.length ? (
                        <Badge variant="outline" color="teal">{agent.config.skills.length} skills</Badge>
                    ) : null}
                </Group>
            ) : (
                <Badge variant="light" color="violet">Connected agent — configuration lives on the remote endpoint</Badge>
            )}
        </Stack>
    );
}
