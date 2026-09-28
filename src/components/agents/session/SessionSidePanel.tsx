'use client';

/**
 * The inspector beside a session transcript.
 *
 * Everything here is derived from the turns the session already stores — no
 * extra fetch, no second source of truth. Tokens, cost and latency are
 * recorded per turn when the turn runs (`agentService.ts#persistSessionTurn`),
 * so a session reopened a week later shows the same numbers it showed live.
 */

import { useMemo } from 'react';
import {
    Badge,
    Box,
    Code,
    CopyButton,
    Group,
    ScrollArea,
    Stack,
    Table,
    Tabs,
    Text,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { formatDuration, formatNumber, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { stepFailed, type ChatMessage, type PlaygroundStep, type TurnCompaction } from './sessionTypes';
import { formatCompactTokens, formatCost, summariseSession } from './sessionUsage';
import ContextCompactionCard, { compactionShrinkLabel } from './ContextCompactionCard';
import {
    collectConfiguredTools,
    countUnnamedToolSurfaces,
    type AgentToolConfig,
    type ToolOrigin,
} from './sessionTools';
import classes from './AgentSessionView.module.css';

export interface SessionSidePanelProps {
    sessionId: string;
    createdAt?: string;
    updatedAt?: string;
    agentName: string;
    agentKey: string;
    /** '' means the session runs the draft config. */
    pinnedVersion: string;
    publishedVersion?: number | null;
    sessionContext?: Record<string, unknown>;
    /** The agent's stored config — what it CAN call, versus what it did. */
    agentConfig?: AgentToolConfig;
    messages: ChatMessage[];
    running: boolean;
    /** Jumps the transcript to the turn an event belongs to. */
    onGoToTurn: (index: number) => void;
}

interface FlatEvent {
    turnIndex: number;
    step: PlaygroundStep;
    stepIndex: number;
}

export default function SessionSidePanel({
    sessionId,
    createdAt,
    updatedAt,
    agentName,
    agentKey,
    pinnedVersion,
    publishedVersion,
    sessionContext,
    agentConfig,
    messages,
    running,
    onGoToTurn,
}: SessionSidePanelProps) {
    const totals = useMemo(() => summariseSession(messages), [messages]);

    const events = useMemo<FlatEvent[]>(() => {
        const flat: FlatEvent[] = [];
        messages.forEach((message, turnIndex) => {
            message.steps?.forEach((step, stepIndex) => flat.push({ turnIndex, step, stepIndex }));
        });
        return flat;
    }, [messages]);

    /**
     * Every tool the agent can call, annotated with how often it did.
     *
     * Configured-first on purpose: a tool that was never bound and a tool that
     * was bound but never chosen look identical in a transcript, and they are
     * opposite problems. A name the run used but the config does not declare
     * still shows up, marked — that is either a control-plane tool the SDK
     * injected (delegation, skills) or a binding that changed after the turn.
     */
    const tools = useMemo(() => {
        const used = new Map<string, { calls: number; failed: number }>();
        events.forEach(({ step }) => {
            const entry = used.get(step.name) ?? { calls: 0, failed: 0 };
            entry.calls += 1;
            if (stepFailed(step)) entry.failed += 1;
            used.set(step.name, entry);
        });

        const configured = collectConfiguredTools(agentConfig);
        const seen = new Set(configured.map((tool) => tool.name));
        const rows = configured.map((tool) => ({
            ...tool,
            calls: used.get(tool.name)?.calls ?? 0,
            failed: used.get(tool.name)?.failed ?? 0,
            declared: true,
        }));

        for (const [name, counts] of used) {
            if (seen.has(name)) continue;
            rows.push({ name, origin: 'runtime' as ToolOrigin, ...counts, declared: false });
        }

        // Used tools first, then the rest alphabetically — the ones that ran
        // are what you came to read; the idle ones answer the second question.
        return rows.sort((a, b) => (b.calls - a.calls) || a.name.localeCompare(b.name));
    }, [events, agentConfig]);

    const unnamedSurfaces = countUnnamedToolSurfaces(agentConfig);

    /**
     * Every summarization in the session, oldest first. The LAST one is what
     * the agent works from now: its summary is the agent's memory of
     * everything before it.
     */
    const compactions = useMemo(() => {
        const flat: Array<{ turnIndex: number; compaction: TurnCompaction }> = [];
        messages.forEach((message, turnIndex) => {
            message.compactions?.forEach((compaction) => flat.push({ turnIndex, compaction }));
        });
        return flat;
    }, [messages]);
    const reclaimedTokens = compactions.reduce(
        (sum, { compaction }) => sum + Math.max(0, (compaction.tokensBefore ?? 0) - (compaction.tokensAfter ?? 0)),
        0,
    );
    const latestCompaction = compactions[compactions.length - 1]?.compaction;

    /** Per-turn cost bars — the shape of the spend, not just its total. */
    const costSeries = useMemo(() => {
        const points = messages
            .map((message, index) => ({ index, cost: message.usage?.costUsd ?? 0 }))
            .filter((point) => point.cost > 0);
        const max = points.reduce((acc, point) => Math.max(acc, point.cost), 0);
        return { points, max };
    }, [messages]);

    return (
        <Tabs
            defaultValue="session"
            className={classes.sidePanel}
            classNames={{ list: classes.sideTabs, tab: classes.sideTab }}
        >
            {/*
              The numbers people glance at while chatting stay visible whatever
              tab is open — the tabs are for the detail behind them.
            */}
            <Box className={classes.sideSummary}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Group gap={6} wrap="nowrap">
                        <span className={running ? classes.liveDot : classes.idleDot} />
                        <Text size="xs" fw={600}>{running ? 'Running' : 'Idle'}</Text>
                    </Group>
                    <Badge size="xs" variant="light" color={pinnedVersion ? 'teal' : 'gray'}>
                        {pinnedVersion
                            ? `v${pinnedVersion}${Number(pinnedVersion) === publishedVersion ? ' · published' : ''}`
                            : 'draft'}
                    </Badge>
                </Group>
                <div className={classes.statGrid}>
                    <SummaryStat
                        label="Cost"
                        value={`${formatCost(totals.costUsd)}${totals.costComplete ? '' : ' +'}`}
                        hint={totals.costComplete ? undefined : 'Some turns are unpriced — their model has no pricing configured.'}
                    />
                    <SummaryStat label="Tokens" value={formatCompactTokens(totals.totalTokens)} hint={`${formatNumber(totals.totalTokens)} total`} />
                    <SummaryStat label="Turns" value={String(totals.turns)} hint={totals.activeMs ? `${formatDuration(totals.activeMs)} active` : undefined} />
                </div>
            </Box>

            <Tabs.List grow>
                <Tabs.Tab value="session">Session</Tabs.Tab>
                <Tabs.Tab value="events">
                    Events{events.length > 0 ? <span className={classes.tabCount}>{events.length}</span> : null}
                </Tabs.Tab>
                <Tabs.Tab value="tools">
                    Tools{tools.length > 0 ? <span className={classes.tabCount}>{tools.length}</span> : null}
                </Tabs.Tab>
                <Tabs.Tab value="context">
                    Context{compactions.length > 0 ? <span className={classes.tabCount}>{compactions.length}</span> : null}
                </Tabs.Tab>
            </Tabs.List>

            <ScrollArea className={classes.sidePanelBody}>
                <Tabs.Panel value="session" p="md">
                    <Stack gap="lg">
                        <Stack gap={0}>
                            <MetaRow label="ID" value={<SessionIdValue id={sessionId} />} />
                            <MetaRow label="Created" value={<TimeValue value={createdAt} />} />
                            <MetaRow label="Updated" value={<TimeValue value={updatedAt} />} />
                            <MetaRow label="Agent" value={<Text size="xs" ff="monospace">{agentKey}</Text>} title={agentName} />
                        </Stack>

                        <Box>
                            <Group justify="space-between" align="baseline" mb={6}>
                                <Text size="xs" fw={700} tt="uppercase" c="dimmed">Cost per turn</Text>
                            </Group>
                            {costSeries.points.length > 0 ? (
                                <Group gap={2} align="flex-end" className={classes.costChart}>
                                    {costSeries.points.map((point) => (
                                        <Tooltip
                                            key={point.index}
                                            label={`Turn ${Math.ceil((point.index + 1) / 2)} · ${formatCost(point.cost)}`}
                                            withArrow
                                        >
                                            <UnstyledButton
                                                onClick={() => onGoToTurn(point.index)}
                                                className={classes.costBar}
                                                style={{ height: `${Math.max(8, (point.cost / costSeries.max) * 100)}%` }}
                                            />
                                        </Tooltip>
                                    ))}
                                </Group>
                            ) : (
                                <Text size="xs" c="dimmed">
                                    {totals.turns > 0
                                        ? 'The model used here has no pricing configured.'
                                        : 'No turns yet.'}
                                </Text>
                            )}
                            {!totals.costComplete && costSeries.points.length > 0 ? (
                                <Text size="10px" c="dimmed" mt={4}>
                                    Some turns are unpriced — their model has no pricing configured.
                                </Text>
                            ) : null}
                        </Box>

                        <Box>
                            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>Usage</Text>
                            <Table withRowBorders={false} verticalSpacing={4} className={classes.usageTable}>
                                <Table.Tbody>
                                    <UsageRow label="Input tokens" value={formatNumber(totals.inputTokens)} />
                                    <UsageRow label="Output tokens" value={formatNumber(totals.outputTokens)} />
                                    <UsageRow
                                        label="Cache read"
                                        value={formatNumber(totals.cachedInputTokens)}
                                        // Cached tokens are a discounted slice of the input
                                        // tokens above, not an extra charge on top.
                                        hint="Part of the input tokens, billed at the cache-read rate."
                                    />
                                    <UsageRow label="Total tokens" value={formatNumber(totals.totalTokens)} strong />
                                    <UsageRow
                                        label="Active time"
                                        value={formatDuration(totals.activeMs)}
                                        hint="Time the agent spent working, summed over turns."
                                    />
                                </Table.Tbody>
                            </Table>
                        </Box>

                        {sessionContext && Object.keys(sessionContext).length > 0 ? (
                            <Box>
                                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>Session context</Text>
                                <Text size="10px" c="dimmed" mb={4}>
                                    Applied to every turn. A per-message override still wins.
                                </Text>
                                <Code block className={classes.sidePanelCode}>
                                    {JSON.stringify(sessionContext, null, 2)}
                                </Code>
                            </Box>
                        ) : null}
                    </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="events" p="md">
                    {events.length === 0 ? (
                        <Text size="xs" c="dimmed">No tool calls in this session yet.</Text>
                    ) : (
                        <Stack gap={4}>
                            {events.map(({ turnIndex, step, stepIndex }) => (
                                <UnstyledButton
                                    key={`${turnIndex}-${stepIndex}`}
                                    onClick={() => onGoToTurn(turnIndex)}
                                    className={classes.eventRow}
                                >
                                    <Group gap="xs" wrap="nowrap">
                                        <Badge
                                            size="xs"
                                            variant="light"
                                            color={stepFailed(step) ? 'red' : 'blue'}
                                            className={classes.eventBadge}
                                        >
                                            {stepIndex + 1}
                                        </Badge>
                                        <Box className={classes.eventName}>
                                            <Text size="xs" ff="monospace" truncate>{step.name}</Text>
                                            <Group gap={4}>
                                                {step.subagent ? (
                                                    <Text size="10px" c="violet.6">via {step.subagent}</Text>
                                                ) : null}
                                                {step.status && step.status !== 'success' ? (
                                                    <Text size="10px" c={stepFailed(step) ? 'red' : 'dimmed'}>
                                                        {step.status}
                                                    </Text>
                                                ) : null}
                                                {step.fromCache ? (
                                                    <Text size="10px" c="dimmed">cached</Text>
                                                ) : null}
                                                {step.summarized ? (
                                                    <Text size="10px" c="orange.7">summarized</Text>
                                                ) : null}
                                            </Group>
                                        </Box>
                                    </Group>
                                </UnstyledButton>
                            ))}
                        </Stack>
                    )}
                </Tabs.Panel>

                <Tabs.Panel value="context" p="md">
                    {compactions.length === 0 ? (
                        <Text size="xs" c="dimmed">
                            The agent has not summarized its context in this session — everything said and every
                            tool result is still in front of it. When a run outgrows its context budget, the
                            summaries it makes show up here.
                        </Text>
                    ) : (
                        <Stack gap="lg">
                            <Group gap="lg">
                                <Box>
                                    <Text size="10px" c="dimmed" tt="uppercase" fw={600}>Summarizations</Text>
                                    <Text size="lg" fw={600}>{compactions.length}</Text>
                                </Box>
                                <Box>
                                    <Text size="10px" c="dimmed" tt="uppercase" fw={600}>Tokens reclaimed</Text>
                                    <Text size="lg" fw={600}>{formatCompactTokens(reclaimedTokens)}</Text>
                                </Box>
                            </Group>

                            {latestCompaction ? (
                                <Box>
                                    <Text size="xs" fw={600} mb={4}>What the agent works from now</Text>
                                    <Text size="10px" c="dimmed" mb="xs">
                                        The latest summary stands in for everything before it.
                                    </Text>
                                    <ContextCompactionCard compaction={latestCompaction} defaultOpen />
                                </Box>
                            ) : null}

                            <Box>
                                <Text size="xs" fw={600} mb={6}>History</Text>
                                <Stack gap={4}>
                                    {compactions.map(({ turnIndex, compaction }, index) => (
                                        <UnstyledButton
                                            key={`${turnIndex}-${index}`}
                                            onClick={() => onGoToTurn(turnIndex)}
                                            className={classes.eventRow}
                                        >
                                            <Group gap="xs" wrap="nowrap">
                                                <Badge
                                                    size="xs"
                                                    variant="light"
                                                    color={compaction.failed ? 'orange' : 'indigo'}
                                                    className={classes.eventBadge}
                                                >
                                                    {index + 1}
                                                </Badge>
                                                <Box className={classes.eventName}>
                                                    <Text size="xs">{compactionShrinkLabel(compaction) ?? 'Context summarized'}</Text>
                                                    <Text size="10px" c="dimmed">
                                                        Turn {Math.floor(turnIndex / 2) + 1}
                                                        {compaction.messagesCompressed ? ` · ${compaction.messagesCompressed} results compacted` : ''}
                                                        {compaction.failed ? ' · fallback' : ''}
                                                    </Text>
                                                </Box>
                                            </Group>
                                        </UnstyledButton>
                                    ))}
                                </Stack>
                            </Box>
                        </Stack>
                    )}
                </Tabs.Panel>

                <Tabs.Panel value="tools" p="md">
                    {tools.length === 0 ? (
                        <Text size="xs" c="dimmed">
                            This agent has no tools bound — it can only answer from the model and its
                            prompt.
                        </Text>
                    ) : (
                        <Stack gap={2}>
                            {tools.map((tool) => (
                                <Group
                                    key={`${tool.origin}:${tool.name}`}
                                    justify="space-between"
                                    wrap="nowrap"
                                    gap="xs"
                                    className={classes.toolRow}
                                >
                                    <Box className={classes.eventName}>
                                        <Text
                                            size="xs"
                                            ff="monospace"
                                            truncate
                                            c={tool.calls > 0 ? undefined : 'dimmed'}
                                        >
                                            {tool.name}
                                        </Text>
                                        <Group gap={4}>
                                            <Text size="10px" c="dimmed">{ORIGIN_LABELS[tool.origin]}</Text>
                                            {tool.sourceKey ? (
                                                <Text size="10px" c="dimmed" truncate>· {tool.sourceKey}</Text>
                                            ) : null}
                                            {tool.failed > 0 ? (
                                                <Text size="10px" c="red">· {tool.failed} failed</Text>
                                            ) : null}
                                        </Group>
                                    </Box>
                                    {tool.calls > 0 ? (
                                        <Badge size="xs" variant="light" className={classes.eventBadge}>
                                            {tool.calls}
                                        </Badge>
                                    ) : (
                                        <Text size="10px" c="dimmed" className={classes.eventBadge}>unused</Text>
                                    )}
                                </Group>
                            ))}
                        </Stack>
                    )}

                    {unnamedSurfaces.subagents > 0 || unnamedSurfaces.skills > 0 ? (
                        <Text size="10px" c="dimmed" mt="sm">
                            {/*
                              Counted, not listed: the SDK names its own control-plane
                              tools from the resolved policy, and inventing those names
                              here would be exactly the plausible-looking lie this panel
                              exists to prevent.
                            */}
                            Plus the SDK&apos;s control-plane tools for{' '}
                            {[
                                unnamedSurfaces.subagents > 0 ? `${unnamedSurfaces.subagents} sub-agent(s)` : null,
                                unnamedSurfaces.skills > 0 ? `${unnamedSurfaces.skills} skill(s)` : null,
                            ].filter(Boolean).join(' and ')}.
                        </Text>
                    ) : null}
                </Tabs.Panel>
            </ScrollArea>
        </Tabs>
    );
}

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    const body = (
        <Box className={classes.stat}>
            <Text size="10px" c="dimmed" tt="uppercase" fw={600} lts="0.05em">{label}</Text>
            <Text size="sm" fw={600} className={classes.statValue}>{value}</Text>
        </Box>
    );
    return hint ? <Tooltip label={hint} withArrow multiline w={220}>{body}</Tooltip> : body;
}

function MetaRow({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
    return (
        <Group justify="space-between" wrap="nowrap" gap="sm" className={classes.metaRow}>
            <Text size="xs" c="dimmed">{label}</Text>
            <Box className={classes.metaValue} title={title}>{value}</Box>
        </Group>
    );
}

function SessionIdValue({ id }: { id: string }) {
    return (
        <CopyButton value={id}>
            {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied' : id} withArrow>
                    <UnstyledButton onClick={copy} className={classes.copyId}>
                        <Group gap={4} wrap="nowrap">
                            <Text size="xs" ff="monospace" truncate>{id}</Text>
                            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                        </Group>
                    </UnstyledButton>
                </Tooltip>
            )}
        </CopyButton>
    );
}

function TimeValue({ value }: { value?: string }) {
    if (!value) return <Text size="xs" c="dimmed">—</Text>;
    return (
        <Tooltip label={new Date(value).toLocaleString()} withArrow>
            <Text size="xs">{formatRelativeTime(value)}</Text>
        </Tooltip>
    );
}

function UsageRow({
    label,
    value,
    strong,
    hint,
}: {
    label: string;
    value: string;
    strong?: boolean;
    hint?: string;
}) {
    const labelNode = <Text size="xs" c={strong ? undefined : 'dimmed'} fw={strong ? 600 : undefined}>{label}</Text>;
    return (
        <Table.Tr>
            <Table.Td>
                {hint ? <Tooltip label={hint} withArrow multiline w={220}>{labelNode}</Tooltip> : labelNode}
            </Table.Td>
            <Table.Td ta="right"><Text size="xs" fw={strong ? 700 : 500}>{value}</Text></Table.Td>
        </Table.Tr>
    );
}

const ORIGIN_LABELS: Record<ToolOrigin, string> = {
    tool: 'tool',
    mcp: 'MCP',
    system: 'built-in',
    knowledge: 'knowledge engine',
    memory: 'memory',
    sandbox: 'sandbox',
    runtime: 'not in config',
};
