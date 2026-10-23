'use client';

/**
 * The Plan tab of the inspector: the session's current plan with what each
 * step is for and what the agent said it found, and the versions the plan went
 * through. A version in the history takes the transcript to where it was
 * written.
 */

import { Badge, Box, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { planProgress } from '@/lib/shared/agentTurnFlow';
import { planPercent, planDiffLabel, type CurrentPlan, type PlanHistoryEntry } from './planUi';
import { PlanStepList } from './PlanCard';
import classes from './AgentSessionView.module.css';

/** "14:02:40" for an ISO time; empty when it does not parse. */
function clockOf(value: string | undefined): string {
    if (!value) return '';
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString();
}

export interface SessionPlanPanelProps {
    current: CurrentPlan;
    /** Every version the stored messages recorded, oldest first. */
    history: PlanHistoryEntry[];
    /** A version was clicked: take the transcript to it. */
    onGoTo: (entry: PlanHistoryEntry) => void;
}

export default function SessionPlanPanel({ current, history, onGoTo }: SessionPlanPanelProps) {
    const t = useTranslations('agents.sessionFlow');
    const { plan } = current;
    const { total } = planProgress(plan);
    const updated = clockOf(plan.at);
    return (
        <Stack gap="md" data-testid="plan-panel">
            <Group gap={8} wrap="wrap">
                <Text size="sm" fw={600}>{t('planCurrent')}</Text>
                <Badge size="sm" variant="outline" color="gray">{t('planVersion', { version: plan.version })}</Badge>
                {total > 0 ? <Badge size="sm" variant="light" color="gray">{t('planPercent', { percent: planPercent(plan) })}</Badge> : null}
                {updated ? <Text size="xs" c="dimmed">{t('planUpdated', { time: updated })}</Text> : null}
            </Group>

            <PlanStepList steps={plan.steps} detail />

            <Box>
                <Text size="sm" fw={600} mb={6}>{t('planHistory')}</Text>
                {history.length === 0 ? (
                    <Text size="xs" c="dimmed">{t('planNoHistory')}</Text>
                ) : (
                    <Stack gap={4}>
                        {history.map((entry) => {
                            const parts = planDiffLabel(entry.change);
                            const time = clockOf(entry.plan.at);
                            return (
                                <UnstyledButton
                                    key={`${entry.messageIndex}-${entry.plan.version}-${entry.plan.at}`}
                                    onClick={() => onGoTo(entry)}
                                    className={classes.eventRow}
                                    aria-label={t('planGoToVersion', { version: entry.plan.version })}
                                >
                                    <Group gap="xs" wrap="nowrap">
                                        <Badge size="xs" variant="light" color="gray" className={classes.eventBadge}>
                                            {t('planVersion', { version: entry.plan.version })}
                                        </Badge>
                                        <Box className={classes.eventName}>
                                            <Text size="xs">
                                                {entry.previous
                                                    ? (parts.length > 0
                                                        ? parts.map((part) => `${part.symbol} ${part.text}`).join(' · ')
                                                        : t('planHistoryNoChange'))
                                                    : t('planHistoryCreated', { count: entry.plan.steps.length })}
                                            </Text>
                                        </Box>
                                        {time ? <Text size="10px" c="dimmed" className={classes.noWrap}>{time}</Text> : null}
                                    </Group>
                                </UnstyledButton>
                            );
                        })}
                    </Stack>
                )}
            </Box>
        </Stack>
    );
}
