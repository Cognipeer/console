'use client';

/**
 * A context summarization, shown where it happened in the transcript.
 *
 * When a run outgrows its context budget the agent replaces older tool results
 * with a structured summary and keeps working from that. That changes what
 * the agent can see for the rest of the conversation, so it is surfaced as a
 * first-class event rather than left to a trace: how much was compacted, how
 * far the context shrank, and — one click away — exactly what the agent now
 * remembers in place of what was dropped.
 */

import { useState } from 'react';
import { Badge, Box, Collapse, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import {
    IconAlertTriangle,
    IconArrowsMinimize,
    IconBookmark,
    IconChevronDown,
    IconChevronRight,
    IconListCheck,
    IconQuestionMark,
    IconTarget,
    IconTrashX,
} from '@tabler/icons-react';
import { formatDuration } from '@/lib/utils/tracingUtils';
import type { TurnCompaction } from './sessionTypes';
import { formatCompactTokens } from './sessionUsage';
import classes from './AgentSessionView.module.css';

export interface ContextCompactionCardProps {
    compaction: TurnCompaction;
    /** Tool results replaced by this turn's compactions, when known. */
    compactedTools?: Array<{ toolName: string; toolCallId: string }>;
    /** Shown while the run is still going. */
    live?: boolean;
    defaultOpen?: boolean;
}

/**
 * "12.3k → 4.1k (−67%)": how far the context shrank, with the saving as a
 * whole percentage. Undefined when the pass did not report both sizes.
 */
export function compactionShrinkLabel({ tokensBefore, tokensAfter }: TurnCompaction): string | undefined {
    if (tokensBefore === undefined || tokensAfter === undefined) return undefined;
    const shrink = `${formatCompactTokens(tokensBefore)} → ${formatCompactTokens(tokensAfter)}`;
    return tokensBefore > 0
        ? `${shrink} (−${Math.max(0, Math.round((1 - tokensAfter / tokensBefore) * 100))}%)`
        : shrink;
}

export default function ContextCompactionCard({
    compaction,
    compactedTools,
    live = false,
    defaultOpen = false,
}: ContextCompactionCardProps) {
    const [open, setOpen] = useState(defaultOpen);
    const summary = compaction.summary ?? {};
    const hasDetail = Boolean(
        summary.userDirectives?.length || summary.facts?.length || summary.goals?.length
        || summary.openQuestions?.length || summary.discarded?.length
        || compaction.integrityNotes?.length || compactedTools?.length,
    );
    const tone = compaction.failed ? 'orange' : 'indigo';
    const afterRatio = compaction.tokensBefore && compaction.tokensAfter !== undefined
        ? Math.min(1, compaction.tokensAfter / compaction.tokensBefore)
        : undefined;
    const toolCounts = countTools(compactedTools);

    return (
        <Box className={`${classes.compactionCard} ${compaction.failed ? classes.compactionCardWarn : ''}`} mb="sm">
            <UnstyledButton
                className={classes.compactionHeader}
                onClick={() => hasDetail && setOpen((value) => !value)}
                aria-expanded={open}
                disabled={!hasDetail}
            >
                <Group gap={8} wrap="nowrap" align="center">
                    <Box className={classes.compactionIcon} data-tone={tone}>
                        <IconArrowsMinimize size={13} />
                    </Box>
                    <Stack gap={2} className={classes.flexGrow}>
                        <Group gap={6} wrap="wrap">
                            <Text size="xs" fw={600}>
                                {compaction.failed ? 'Context summarized (fallback)' : 'Context summarized'}
                            </Text>
                            {live ? <Badge size="xs" variant="light" color={tone}>just now</Badge> : null}
                            {compaction.messagesCompressed ? (
                                <Text size="10px" c="dimmed">
                                    {compaction.messagesCompressed} tool result{compaction.messagesCompressed === 1 ? '' : 's'} compacted
                                </Text>
                            ) : null}
                            {compaction.durationMs !== undefined ? (
                                <Text size="10px" c="dimmed">· {formatDuration(compaction.durationMs)}</Text>
                            ) : null}
                        </Group>
                        {compaction.tokensBefore !== undefined && compaction.tokensAfter !== undefined ? (
                            <Group gap={8} wrap="nowrap" align="center">
                                <Tooltip
                                    withArrow
                                    label={`Context went from ~${compaction.tokensBefore.toLocaleString()} to ~${compaction.tokensAfter.toLocaleString()} tokens`}
                                >
                                    <Box className={classes.compactionBar}>
                                        <Box
                                            className={classes.compactionBarAfter}
                                            data-tone={tone}
                                            style={{ width: `${Math.max(3, (afterRatio ?? 1) * 100)}%` }}
                                        />
                                    </Box>
                                </Tooltip>
                                <Text size="10px" c="dimmed" className={classes.noWrap}>
                                    {compactionShrinkLabel(compaction)}
                                </Text>
                            </Group>
                        ) : null}
                    </Stack>
                    {hasDetail
                        ? (open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />)
                        : null}
                </Group>
            </UnstyledButton>

            <Collapse in={open}>
                <Stack gap="sm" className={classes.compactionBody}>
                    {compaction.failed ? (
                        <Group gap={6} wrap="nowrap" align="flex-start">
                            <IconAlertTriangle size={13} color="var(--mantine-color-orange-6)" />
                            <Text size="xs" c="dimmed">
                                The summarizer call failed, so a local fallback summary was used. The agent may have
                                lost detail from the compacted results.
                            </Text>
                        </Group>
                    ) : null}

                    <CompactionSection
                        icon={<IconBookmark size={12} />}
                        title="Standing instructions"
                        hint="Kept verbatim — they apply to every later turn"
                        items={summary.userDirectives}
                        emphasis
                    />
                    {summary.facts?.length ? (
                        <Box>
                            <SectionTitle icon={<IconListCheck size={12} />} title="What the agent remembers" count={summary.facts.length} />
                            <Stack gap={2} mt={4}>
                                {summary.facts.map((fact) => (
                                    <Group key={fact.key} gap={6} wrap="nowrap" align="flex-start">
                                        <Text size="xs" ff="monospace" c="dimmed" className={classes.compactionFactKey}>{fact.key}</Text>
                                        <Text size="xs" className={classes.preWrap}>{fact.value}</Text>
                                    </Group>
                                ))}
                            </Stack>
                        </Box>
                    ) : null}
                    <CompactionSection icon={<IconTarget size={12} />} title="Active goals" items={summary.goals} />
                    <CompactionSection icon={<IconQuestionMark size={12} />} title="Open questions" items={summary.openQuestions} />
                    <CompactionSection
                        icon={<IconTrashX size={12} />}
                        title="Dropped as obsolete"
                        items={summary.discarded}
                        muted
                    />

                    {toolCounts.length > 0 ? (
                        <Box>
                            <SectionTitle
                                icon={<IconArrowsMinimize size={12} />}
                                title="Tool results replaced by the summary"
                                count={compactedTools?.length}
                            />
                            <Group gap={4} mt={4}>
                                {toolCounts.map(([name, count]) => (
                                    <Badge key={name} size="xs" variant="outline" color="gray" ff="monospace">
                                        {name}{count > 1 ? ` ×${count}` : ''}
                                    </Badge>
                                ))}
                            </Group>
                            <Text size="10px" c="dimmed" mt={4}>
                                The full results are still in the tool calls above; the agent can page them back in if it needs them.
                            </Text>
                        </Box>
                    ) : null}

                    {compaction.integrityNotes?.length ? (
                        <Box>
                            <SectionTitle icon={<IconAlertTriangle size={12} />} title="Integrity repairs" />
                            <Stack gap={2} mt={4}>
                                {compaction.integrityNotes.map((note) => (
                                    <Text key={note} size="xs" c="orange.7">{note}</Text>
                                ))}
                            </Stack>
                        </Box>
                    ) : null}

                    {compaction.inputTokens || compaction.outputTokens ? (
                        <Text size="10px" c="dimmed">
                            Summarizer call: {compaction.inputTokens ?? 0} in / {compaction.outputTokens ?? 0} out tokens
                            (included in this turn’s usage)
                        </Text>
                    ) : null}
                </Stack>
            </Collapse>
        </Box>
    );
}

function countTools(tools: ContextCompactionCardProps['compactedTools']): Array<[string, number]> {
    const counts = new Map<string, number>();
    for (const tool of tools ?? []) counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
    return [...counts.entries()];
}

function SectionTitle({ icon, title, count, hint }: { icon: React.ReactNode; title: string; count?: number; hint?: string }) {
    return (
        <Group gap={5} wrap="nowrap">
            <Box c="dimmed" className={classes.compactionSectionIcon}>{icon}</Box>
            <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{title}</Text>
            {count !== undefined ? <Text size="10px" c="dimmed">{count}</Text> : null}
            {hint ? <Text size="10px" c="dimmed">· {hint}</Text> : null}
        </Group>
    );
}

function CompactionSection({
    icon,
    title,
    hint,
    items,
    emphasis = false,
    muted = false,
}: {
    icon: React.ReactNode;
    title: string;
    hint?: string;
    items?: string[];
    emphasis?: boolean;
    muted?: boolean;
}) {
    if (!items || items.length === 0) return null;
    return (
        <Box>
            <SectionTitle icon={icon} title={title} count={items.length} hint={hint} />
            <Stack gap={3} mt={4}>
                {items.map((item) => (
                    <Text
                        key={item}
                        size="xs"
                        c={muted ? 'dimmed' : undefined}
                        td={muted ? 'line-through' : undefined}
                        className={emphasis ? classes.compactionDirective : classes.preWrap}
                    >
                        {item}
                    </Text>
                ))}
            </Stack>
        </Box>
    );
}
