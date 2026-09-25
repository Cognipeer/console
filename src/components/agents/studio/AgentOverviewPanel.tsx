'use client';

/**
 * Overview — the landing tab.
 *
 * Answers "is this agent healthy, how much is it used, and how do I call it"
 * in one screen. The numbers come from the agent's TRACES, not its dashboard
 * sessions: every run on every channel — API, OpenAI-compatible, A2A,
 * Assistants, schedules, the playground — writes a trace, whereas a session
 * list only knows about conversations started from this page. Showing the
 * session list here made an agent serving thousands of API calls look idle.
 */

import { useEffect, useMemo, useState } from 'react';
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
import { formatDuration, formatNumber } from '@/lib/utils/tracingUtils';
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
        kind?: 'native' | 'external';
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
    isConnected: boolean;
    sessionCount: number;
    onStartSession: () => void;
    onGoToTab: (tab: string) => void;
}

type WindowDays = '7' | '30';

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
    isConnected,
    sessionCount,
    onStartSession,
    onGoToTab,
}: AgentOverviewPanelProps) {
    const [windowDays, setWindowDays] = useState<WindowDays>('30');
    const [overview, setOverview] = useState<TracingOverview | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const from = new Date(Date.now() - Number(windowDays) * 24 * 60 * 60 * 1000).toISOString();
        fetch(`/api/tracing/agents/${encodeURIComponent(agent.name)}/overview?from=${encodeURIComponent(from)}`, {
            cache: 'no-store',
        })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (!cancelled) setOverview(data); })
            .catch(() => { if (!cancelled) setOverview(null); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [agent.name, windowDays]);

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
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com';
    const quickCurl = `curl ${origin}/api/client/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${agent.key}", "messages": [{"role": "user", "content": "Hello"}]}'`;

    return (
        <Stack gap="lg">
            <Group justify="space-between">
                <Text size="sm" c="dimmed">
                    Every run on every channel — API, OpenAI-compatible, A2A, schedules and sessions.
                </Text>
                <SegmentedControl
                    size="xs"
                    value={windowDays}
                    onChange={(v) => setWindowDays(v as WindowDays)}
                    data={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }]}
                />
            </Group>

            {loading ? (
                <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }} spacing="md">
                    {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={84} radius="md" />)}
                </SimpleGrid>
            ) : (
                <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }} spacing="md">
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

            {!isConnected ? (
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
