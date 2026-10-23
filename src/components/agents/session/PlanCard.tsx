'use client';

/**
 * The agent's plan in the transcript: the full list when the turn first writes
 * it (`PlanCard`), one line per later version saying what changed
 * (`PlanUpdateRow`), and a dock above the composer that keeps the session's
 * current plan in view ("Plan · 2 / 5 done · Now: …", `PlanDock`). What a status
 * looks like and what a version changed come from `planUi.ts`; this only draws
 * them.
 */

import { useState } from 'react';
import { ActionIcon, Badge, Box, Collapse, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import {
    IconAlertTriangle,
    IconChevronDown,
    IconChevronRight,
    IconChevronUp,
    IconCircleCheck,
    IconCircleDashed,
    IconListCheck,
    IconPlayerPlay,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { planProgress } from '@/lib/shared/agentTurnFlow';
import type { IAgentPlanStep, IAgentTurnPlanSnapshot } from '@/lib/database/provider/types.domain';
import { planStatusView, planStepLabel, type PlanDiffPart, type PlanStatusIcon } from './planUi';
import classes from './AgentSessionView.module.css';

const STATUS_ICONS: Record<PlanStatusIcon, typeof IconCircleDashed> = {
    'circle-dashed': IconCircleDashed,
    'player-play': IconPlayerPlay,
    'circle-check': IconCircleCheck,
    'alert-triangle': IconAlertTriangle,
};

/** The icon of a step's status, in the status's color. */
export function PlanStatusMark({ status, size = 15 }: { status: string | undefined; size?: number }) {
    const view = planStatusView(status);
    const Icon = STATUS_ICONS[view.icon];
    return <Icon size={size} color={`var(--mantine-color-${view.color}-6)`} aria-hidden />;
}

/**
 * The steps of one plan version. `detail` adds what the side panel shows under
 * each: who owns it, when it counts as done and the evidence the agent gave.
 */
export function PlanStepList({ steps, detail = false }: { steps: IAgentPlanStep[]; detail?: boolean }) {
    const t = useTranslations('agents.sessionFlow');
    return (
        <Stack gap={detail ? 6 : 4} data-testid="plan-steps">
            {steps.map((step) => {
                const view = planStatusView(step.status);
                const working = view.status === 'in-progress';
                return (
                    <Box key={String(step.id)} className={classes.planStep} data-status={view.status}>
                        <Group gap={8} wrap="nowrap" align="flex-start">
                            <Box className={classes.planStepIcon}><PlanStatusMark status={step.status} /></Box>
                            <Stack gap={1} className={classes.flexGrow}>
                                <Group gap={6} wrap="wrap">
                                    <Text size="sm" fw={working ? 600 : 400} c={view.status === 'not-started' ? 'dimmed' : undefined}>
                                        {planStepLabel(step)}
                                    </Text>
                                    {working || view.status === 'blocked' ? (
                                        <Badge size="xs" variant="light" color={view.color}>{t(view.labelKey)}</Badge>
                                    ) : null}
                                </Group>
                                {detail && (step.owner || step.exitCriteria) ? (
                                    <Text size="xs" c="dimmed">
                                        {[
                                            step.owner ? t('planOwner', { owner: step.owner }) : null,
                                            step.exitCriteria ? t('planExit', { criteria: step.exitCriteria }) : null,
                                        ].filter(Boolean).join(' · ')}
                                    </Text>
                                ) : null}
                                {detail && step.evidence ? (
                                    <Text size="xs" className={classes.preWrap}>{t('planEvidence', { evidence: step.evidence })}</Text>
                                ) : null}
                            </Stack>
                        </Group>
                    </Box>
                );
            })}
        </Stack>
    );
}

export interface PlanCardProps {
    plan: IAgentTurnPlanSnapshot;
    /** DOM id the "go to" links scroll to. */
    anchorId?: string;
    defaultOpen?: boolean;
}

/** The plan written in full: header with version and progress, then every step. */
export function PlanCard({ plan, anchorId, defaultOpen = true }: PlanCardProps) {
    const t = useTranslations('agents.sessionFlow');
    const [open, setOpen] = useState(defaultOpen);
    const { done, total } = planProgress(plan);
    return (
        <Paper withBorder radius="md" p="sm" id={anchorId} className={`${classes.planCard} ${classes.flowAnchor}`} data-testid="plan-card">
            <Group gap={8} wrap="wrap" mb={open ? 'xs' : 0}>
                <IconListCheck size={15} />
                <Text size="sm" fw={600}>{t('planTitle')}</Text>
                <Badge size="sm" variant="outline" color="gray">
                    {plan.operation === 'write' ? t('planCreated', { version: plan.version }) : t('planVersion', { version: plan.version })}
                </Badge>
                <Badge size="sm" variant="light" color={total > 0 && done === total ? 'teal' : 'gray'}>
                    {t('planProgress', { done, total })}
                </Badge>
                <div className={classes.flexGrow} />
                <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => setOpen((value) => !value)}
                    aria-expanded={open}
                    aria-label={open ? t('planCollapse') : t('planExpand')}
                >
                    {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                </ActionIcon>
            </Group>
            <Collapse in={open}>
                <PlanStepList steps={plan.steps} />
            </Collapse>
        </Paper>
    );
}

export interface PlanUpdateRowProps {
    plan: IAgentTurnPlanSnapshot;
    /** What the version changed (`planChangeParts`); none when nothing did. */
    parts: PlanDiffPart[];
    anchorId?: string;
    defaultOpen?: boolean;
}

/** A later version as one line: "Plan v2 · ✓ 1, 2 done · ▶ 3 started · 2 / 5", opening to that version's list. */
export function PlanUpdateRow({ plan, parts, anchorId, defaultOpen = false }: PlanUpdateRowProps) {
    const t = useTranslations('agents.sessionFlow');
    const [open, setOpen] = useState(defaultOpen);
    const { done, total } = planProgress(plan);
    return (
        <Paper withBorder radius="md" px="sm" py={6} id={anchorId} className={`${classes.planCard} ${classes.flowAnchor}`} data-testid="plan-update">
            <UnstyledButton
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-label={open ? t('planHideVersion', { version: plan.version }) : t('planShowVersion', { version: plan.version })}
                className={classes.planUpdateHeader}
            >
                <Group gap={8} wrap="wrap">
                    <IconListCheck size={14} />
                    <Text size="sm" fw={600}>{t('planUpdate', { version: plan.version })}</Text>
                    {parts.map((part) => (
                        <Badge key={part.kind} size="sm" variant="light" color={part.color}>
                            {part.symbol} {t(part.labelKey, { ids: part.text })}
                        </Badge>
                    ))}
                    <Badge size="sm" variant="outline" color="gray">{t('planCount', { done, total })}</Badge>
                    <div className={classes.flexGrow} />
                    {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                </Group>
            </UnstyledButton>
            <Collapse in={open}>
                <Box mt="xs"><PlanStepList steps={plan.steps} /></Box>
            </Collapse>
        </Paper>
    );
}

/**
 * The session's current plan above the composer: one line while closed, the
 * list above it when open ("▴"). `null` when the session has no plan - nothing
 * is drawn then, so an agent that does not plan never shows the dock.
 */
export function PlanDock({ plan }: { plan: IAgentTurnPlanSnapshot | null | undefined }) {
    const t = useTranslations('agents.sessionFlow');
    const [open, setOpen] = useState(false);
    if (!plan || plan.steps.length === 0) return null;
    const { done, total, current } = planProgress(plan);
    return (
        <Paper withBorder radius="md" className={classes.planDock} data-testid="plan-dock">
            <Collapse in={open}>
                <Box px="sm" pt="sm" pb={4}><PlanStepList steps={plan.steps} /></Box>
            </Collapse>
            <UnstyledButton
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-label={open ? t('planCollapse') : t('planExpand')}
                className={classes.planDockHeader}
            >
                <Group gap={8} wrap="nowrap">
                    <IconListCheck size={15} />
                    <Text size="sm" fw={600}>{t('planTitle')}</Text>
                    <Badge size="sm" variant="light" color={done === total ? 'teal' : 'gray'}>{t('planProgress', { done, total })}</Badge>
                    {current ? (
                        <>
                            <Text size="sm" c="dimmed" className={classes.noWrap}>{t('planNow')}</Text>
                            <Text size="sm" truncate className={classes.flexGrow}>{current.title}</Text>
                        </>
                    ) : (
                        <Text size="sm" c="dimmed" className={classes.flexGrow}>{t('planAllDone')}</Text>
                    )}
                    {open ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
                </Group>
            </UnstyledButton>
        </Paper>
    );
}
