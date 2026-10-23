'use client';

/**
 * A sub-agent's work, grouped under the delegation call that started it: who
 * it is, how it ended, and (opened) the task it was given, the steps it took,
 * its own context summaries and what it answered. `SubagentGroup` draws one
 * run; `ParallelSubagents` the several one `spawn_subagents_parallel` call
 * started. Both draw a `SubagentRunView`, so a run looks the same while it
 * runs, when the turn ends and after a reload.
 *
 * A group is closed once it is done (its header carries "Result: …") or went
 * on in the next message ("Continued below"), and open while it works, waits
 * for a person or failed. `expanded` takes that choice over (so "Show in
 * group" can open one); without it the group keeps its own.
 */

import { useState } from 'react';
import { Badge, Box, Collapse, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import {
    IconAlertTriangle,
    IconArrowDown,
    IconCheck,
    IconChevronDown,
    IconChevronRight,
    IconCircleDashed,
    IconGitFork,
    IconPlayerPause,
    IconPlayerStop,
    IconX,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { formatDuration } from '@/lib/utils/tracingUtils';
import CompactionDivider from './CompactionDivider';
import { StepCard, StepPayload } from './StepCards';
import type { PlaygroundStep } from './sessionTypes';
import { formatCompactTokens } from './sessionUsage';
import {
    parallelGroupView,
    subagentStartsOpen,
    subagentStatusStyle,
    type ParallelGroupView,
    type SubagentRow,
    type SubagentRunView,
    type SubagentStatusKind,
    type SubagentStepRow,
} from './subagentUi';
import { compactionDividerView } from './turnFlowUi';
import classes from './AgentSessionView.module.css';

/** The mark of a run's status: a spinner while it works, a glyph for how it ended. */
function StatusMark({ kind }: { kind: SubagentStatusKind }) {
    switch (kind) {
        case 'running': return <Loader size={10} color="blue" />;
        case 'done': return <IconCheck size={11} />;
        case 'failed': return <IconX size={11} />;
        case 'paused': return <IconPlayerPause size={11} />;
        case 'blocked': return <IconAlertTriangle size={11} />;
        case 'cancelled': return <IconPlayerStop size={11} />;
        case 'continued': return <IconArrowDown size={11} />;
        default: return <IconCircleDashed size={11} />;
    }
}

/** The status chip of a header: "✓ Done", "⏸ Waiting for approval", … */
function StatusBadge({ kind }: { kind: SubagentStatusKind }) {
    const t = useTranslations('agents.sessionFlow');
    const style = subagentStatusStyle(kind);
    return (
        <Badge size="sm" variant="light" color={style.color} leftSection={<StatusMark kind={kind} />} data-status={kind}>
            {t(style.labelKey)}
        </Badge>
    );
}

/** "4 steps · 6.1s · 2.1k tok" */
function runFigures(view: SubagentRunView, t: (key: string, values?: Record<string, string | number>) => string): string {
    const parts: string[] = [];
    if (!view.stepsNotRecorded) parts.push(view.stepCount === 1 ? t('subagentStepsOne') : t('subagentSteps', { count: view.stepCount }));
    if (view.durationMs !== undefined) parts.push(formatDuration(view.durationMs));
    if (view.tokens !== undefined) parts.push(t('subagentTokens', { tokens: formatCompactTokens(view.tokens) }));
    return parts.join(' · ');
}

/** One tool call of the sub-agent: a line, opening to its arguments and result when the stored run kept them. */
function SubagentStepLine({ row }: { row: SubagentStepRow }) {
    const t = useTranslations('agents.sessionFlow');
    const [open, setOpen] = useState(false);
    const hasPayload = row.args !== undefined || row.output !== undefined || Boolean(row.error);
    const line = (
        <Group gap={8} wrap="nowrap" justify="space-between" className={classes.subagentStepLine} data-status={row.status}>
            <Group gap={8} wrap="nowrap" className={classes.eventName}>
                {row.status === 'running' ? <Loader size={10} color="gray" /> : row.status === 'error'
                    ? <IconX size={12} color="var(--mantine-color-red-6)" />
                    : <IconCheck size={12} color="var(--mantine-color-teal-6)" />}
                <Text size="sm" ff="monospace" fw={500}>{row.name}</Text>
                {row.detail ? <Text size="sm" c="dimmed" truncate>{row.detail}</Text> : null}
            </Group>
            <Group gap={6} wrap="nowrap">
                {row.truncated ? <Text size="10px" c="dimmed">{t('subagentStepCut')}</Text> : null}
                {row.status === 'error' && !hasPayload ? <Text size="xs" c="red">{t('subagentStepFailed')}</Text> : null}
                {row.durationMs !== undefined ? <Text size="xs" c="dimmed">{formatDuration(row.durationMs)}</Text> : null}
                {hasPayload ? (open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />) : null}
            </Group>
        </Group>
    );
    return (
        <Box className={classes.subagentStep} data-testid="subagent-step">
            {hasPayload ? (
                <UnstyledButton onClick={() => setOpen((value) => !value)} aria-expanded={open} className={classes.subagentStepButton}>
                    {line}
                </UnstyledButton>
            ) : line}
            {hasPayload ? (
                <Collapse in={open}>
                    <Box mt={4} pl="xs">
                        {row.args !== undefined ? <StepPayload label={t('stepArgs')} value={row.args} /> : null}
                        {row.error ? (
                            <Box mb={4}>
                                <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{t('stepError')}</Text>
                                <Text size="xs" c="red" className={classes.preWrap}>{row.error}</Text>
                            </Box>
                        ) : null}
                        {row.output !== undefined ? <StepPayload label={t('stepResult')} value={row.output} /> : null}
                    </Box>
                </Collapse>
            ) : null}
        </Box>
    );
}

function RowView({ row }: { row: SubagentRow }) {
    if (row.kind === 'step') return <SubagentStepLine row={row} />;
    return (
        <CompactionDivider
            compaction={row.compaction}
            view={compactionDividerView(row.compaction)}
        />
    );
}

export interface SubagentGroupProps {
    view: SubagentRunView;
    /** The delegation tool that started it ("delegate_to"), shown as a chip. */
    toolName?: string;
    /** DOM id "Show in group" scrolls to. */
    anchorId?: string;
    /** Controls whether the group is open; absent = by its status (see the file header). */
    expanded?: boolean;
    onExpandedChange?: (open: boolean) => void;
    /** A turn stored before runs were recorded: its delegation call, shown in full under "steps not recorded". */
    legacyStep?: PlaygroundStep;
    /** Where that call falls among the turn's calls, from 0 (its card's number is this plus one): the number the Events tab gives it. */
    legacyIndex?: number;
    /** Drawn inside a parallel container: no frame of its own tone. */
    nested?: boolean;
}

/** One sub-agent run. */
export function SubagentGroup({ view, toolName, anchorId, expanded, onExpandedChange, legacyStep, legacyIndex = 0, nested = false }: SubagentGroupProps) {
    const t = useTranslations('agents.sessionFlow');
    const [chosen, setChosen] = useState<boolean | null>(null);
    const open = expanded ?? chosen ?? subagentStartsOpen(view.statusKind);
    const toggle = () => {
        const next = !open;
        setChosen(next);
        onExpandedChange?.(next);
    };
    const kind = [
        view.modeLabelKey ? t(view.modeLabelKey) : null,
        view.targetText ?? null,
    ].filter(Boolean).join(' · ');
    const figures = runFigures(view, t);

    return (
        <Box
            id={anchorId}
            className={`${classes.subagentGroup} ${classes.flowAnchor}`}
            data-testid="subagent-group"
            data-status={view.statusKind}
            data-nested={nested ? 'true' : undefined}
        >
            <UnstyledButton
                onClick={toggle}
                aria-expanded={open}
                aria-label={open ? t('subagentCollapse', { name: view.name }) : t('subagentExpand', { name: view.name })}
                className={classes.subagentHeader}
            >
                <Group gap={8} wrap="wrap">
                    {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    <span className={classes.subagentAvatar} aria-hidden>{view.initial}</span>
                    <Text size="sm" fw={600}>{view.name}</Text>
                    {kind ? <Badge size="sm" variant="outline" color="gray">{kind}</Badge> : null}
                    {toolName ? <Badge size="sm" variant="outline" color="gray" ff="monospace" tt="none">{toolName}</Badge> : null}
                    {view.resumed ? <Badge size="sm" variant="light" color="violet">{t('subagentContinued')}</Badge> : null}
                    <StatusBadge kind={view.statusKind} />
                    {view.stepsNotRecorded ? (
                        <Text size="xs" c="dimmed">{t('subagentNotRecorded')}</Text>
                    ) : figures ? (
                        <Text size="xs" c="dimmed">{figures}</Text>
                    ) : null}
                </Group>
            </UnstyledButton>

            {!open && view.result ? (
                <Text size="sm" c="dimmed" className={classes.subagentResultLine} lineClamp={1}>
                    {t('subagentResult')}: {view.result}
                </Text>
            ) : null}

            <Collapse in={open}>
                <Stack gap={6} className={classes.subagentRail}>
                    {view.input ? (
                        <Text size="sm" className={classes.preWrap}>
                            <Text component="span" size="sm" c="dimmed">{t('subagentTask')}: </Text>
                            {view.input}
                        </Text>
                    ) : null}

                    {view.stepsNotRecorded ? (
                        <>
                            <Text size="xs" c="dimmed">{t('subagentNotRecordedHint')}</Text>
                            {legacyStep ? <StepCard step={legacyStep} index={legacyIndex} /> : null}
                        </>
                    ) : (
                        <>
                            {view.rows.map((row) => <RowView key={row.key} row={row} />)}
                            {view.rows.length === 0 && view.statusKind === 'running' ? (
                                <Text size="xs" c="dimmed">{t('subagentNoSteps')}</Text>
                            ) : null}
                            {view.stepsDropped > 0 ? (
                                <Text size="xs" c="dimmed">{t('subagentStepsDropped', { count: view.stepsDropped })}</Text>
                            ) : null}
                            {view.resultFull ? (
                                <Box>
                                    <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{t('subagentResult')}</Text>
                                    <Text size="sm" className={classes.preWrap}>{view.resultFull}</Text>
                                </Box>
                            ) : null}
                            {view.error ? (
                                <Box>
                                    <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{t('subagentError')}</Text>
                                    <Text size="sm" c="red" className={classes.preWrap}>{view.error}</Text>
                                </Box>
                            ) : null}
                        </>
                    )}
                </Stack>
            </Collapse>
        </Box>
    );
}

export interface ParallelSubagentsProps {
    runs: SubagentRunView[];
    /** The header figures; worked out from `runs` when absent. */
    group?: ParallelGroupView;
    toolName?: string;
    anchorId?: string;
    /** Controls whether the container shows its runs; absent = it does. */
    expanded?: boolean;
    onExpandedChange?: (open: boolean) => void;
    /** Per-run control of the group inside (by run id): "Show in group" opens the run an approval belongs to. */
    runExpanded?: Readonly<Record<string, boolean>>;
    onRunExpandedChange?: (runId: string, open: boolean) => void;
}

/** The sub-agents one `spawn_subagents_parallel` call started: a header with the group's progress and one row per run. */
export function ParallelSubagents({
    runs,
    group,
    toolName,
    anchorId,
    expanded,
    onExpandedChange,
    runExpanded,
    onRunExpandedChange,
}: ParallelSubagentsProps) {
    const t = useTranslations('agents.sessionFlow');
    const [chosen, setChosen] = useState<boolean | null>(null);
    const open = expanded ?? chosen ?? true;
    const view = group ?? parallelGroupView(runs);
    const toggle = () => {
        const next = !open;
        setChosen(next);
        onExpandedChange?.(next);
    };
    const progress = t('parallelDone', { done: view.done, count: view.count });
    return (
        <Box
            id={anchorId}
            className={`${classes.subagentGroup} ${classes.flowAnchor}`}
            data-testid="parallel-subagents"
            data-status={view.statusKind}
        >
            <UnstyledButton
                onClick={toggle}
                aria-expanded={open}
                aria-label={open ? t('parallelCollapse') : t('parallelExpand')}
                className={classes.subagentHeader}
            >
                <Group gap={8} wrap="wrap">
                    {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    <IconGitFork size={15} />
                    <Text size="sm" fw={600}>{t('parallelTitle', { count: view.count })}</Text>
                    {toolName ? <Badge size="sm" variant="outline" color="gray" ff="monospace" tt="none">{toolName}</Badge> : null}
                    <Badge size="sm" variant="light" color={view.statusKind === 'running' ? 'blue' : view.statusKind === 'failed' ? 'red' : 'gray'}>
                        {progress}
                    </Badge>
                    {view.durationMs !== undefined ? <Text size="xs" c="dimmed">{formatDuration(view.durationMs)}</Text> : null}
                    {view.approvals > 0 ? (
                        <Badge size="sm" variant="light" color="orange" leftSection={<IconPlayerPause size={11} />}>
                            {view.approvals === 1 ? t('approvalCountOne') : t('approvalCount', { count: view.approvals })}
                        </Badge>
                    ) : null}
                </Group>
            </UnstyledButton>
            <Collapse in={open}>
                <Stack gap={6} mt={6}>
                    {runs.map((run) => (
                        <SubagentGroup
                            key={run.id}
                            view={run}
                            nested
                            expanded={runExpanded?.[run.id]}
                            onExpandedChange={onRunExpandedChange ? (next) => onRunExpandedChange(run.id, next) : undefined}
                        />
                    ))}
                </Stack>
            </Collapse>
        </Box>
    );
}
