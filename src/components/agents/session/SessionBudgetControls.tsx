'use client';

/**
 * A session's spend budget in the session view: a meter in the header (spent /
 * budget, with a small editor) and the banner shown once the budget is used up
 * (a new budget, "Increase and continue", "Remove budget").
 *
 * Presentational: it collects an amount and calls back. The session view owns
 * the PATCH and the continuation (`AgentSessionView`).
 */

import { useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Group,
    NumberInput,
    Popover,
    Progress,
    SegmentedControl,
    Stack,
    Text,
    Tooltip,
} from '@mantine/core';
import { IconCoin, IconCoinOff } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { IAgentSessionBudget } from '@/lib/database/provider/types.domain';
import { formatCost } from './sessionUsage';
import {
    suggestedBudget,
    validBudgetAmount,
    type SessionBudgetView,
} from './sessionBudgetUi';

export interface BudgetMeterProps {
    view: SessionBudgetView | null;
    /** A turn is running or a change is in flight. */
    busy: boolean;
    /** A read-only session (API traffic) cannot be given a budget from here. */
    readOnly?: boolean;
    onSave: (budget: IAgentSessionBudget) => void;
    onRemove: () => void;
}

export function BudgetMeter({ view, busy, readOnly, onSave, onRemove }: BudgetMeterProps) {
    const t = useTranslations('agents.budget');
    const [opened, setOpened] = useState(false);
    const [amount, setAmount] = useState<number | string>('');
    const [onReach, setOnReach] = useState<IAgentSessionBudget['onReach']>('pause');

    const open = () => {
        setAmount(view ? view.budget.maxCostUsd : '');
        setOnReach(view?.budget.onReach ?? 'pause');
        setOpened(true);
    };
    const amountOk = validBudgetAmount(amount, view);

    return (
        <Popover opened={opened} onChange={setOpened} position="bottom-start" withArrow shadow="md" width={300}>
            <Popover.Target>
                {view ? (
                    <Tooltip label={t('meterTooltip')} withArrow>
                        <Group gap={6} wrap="nowrap" style={{ cursor: readOnly ? 'default' : 'pointer' }} onClick={readOnly ? undefined : open}>
                            <IconCoin size={11} />
                            <Text size="xs" c={view.exhausted ? 'red' : 'dimmed'}>
                                {formatCost(view.spentUsd)} / {formatCost(view.budget.maxCostUsd)}
                            </Text>
                            <Progress
                                value={view.ratio * 100}
                                w={56}
                                size="xs"
                                color={view.exhausted ? 'red' : view.ratio >= 0.8 ? 'orange' : 'blue'}
                                aria-label={t('meterLabel')}
                            />
                        </Group>
                    </Tooltip>
                ) : readOnly ? <span /> : (
                    <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconCoinOff size={11} />} onClick={open}>
                        {t('setBudget')}
                    </Button>
                )}
            </Popover.Target>
            <Popover.Dropdown>
                <Stack gap="xs">
                    <NumberInput
                        label={t('amountLabel')}
                        value={amount}
                        onChange={setAmount}
                        min={0}
                        decimalScale={4}
                        error={amount !== '' && !amountOk ? t('invalidAmount', { spent: formatCost(view?.spentUsd ?? 0) }) : undefined}
                    />
                    <div>
                        <Text size="xs" fw={500} mb={4}>{t('onReachLabel')}</Text>
                        <SegmentedControl
                            size="xs"
                            fullWidth
                            value={onReach}
                            onChange={(next) => setOnReach(next === 'stop' ? 'stop' : 'pause')}
                            data={[
                                { value: 'pause', label: t('onReachPause') },
                                { value: 'stop', label: t('onReachStop') },
                            ]}
                            orientation="vertical"
                        />
                    </div>
                    <Group justify="space-between">
                        {view ? (
                            <Button
                                size="xs"
                                variant="subtle"
                                color="red"
                                disabled={busy}
                                onClick={() => { setOpened(false); onRemove(); }}
                            >
                                {t('removeBudget')}
                            </Button>
                        ) : <span />}
                        <Button
                            size="xs"
                            disabled={busy || !amountOk}
                            onClick={() => {
                                if (!validBudgetAmount(amount, view)) return;
                                setOpened(false);
                                onSave({ maxCostUsd: amount, onReach });
                            }}
                        >
                            {t('save')}
                        </Button>
                    </Group>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
}

export interface BudgetBannerProps {
    view: SessionBudgetView;
    busy: boolean;
    /** Raise the budget to `amount` (and continue the turn when it can be continued). */
    onIncrease: (amount: number) => void;
    /** Remove the budget (and continue the turn when it can be continued). */
    onRemove: () => void;
}

export function BudgetBanner({ view, busy, onIncrease, onRemove }: BudgetBannerProps) {
    const t = useTranslations('agents.budget');
    const [amount, setAmount] = useState<number | string>(() => suggestedBudget(view));
    const amountOk = validBudgetAmount(amount, view);

    return (
        <Alert
            variant="light"
            color="orange"
            title={(
                <Group gap={6}>
                    <span>{t('bannerTitle')}</span>
                    <Badge size="xs" variant="light" color="orange">
                        {formatCost(view.spentUsd)} / {formatCost(view.budget.maxCostUsd)}
                    </Badge>
                </Group>
            )}
            icon={<IconCoin size={16} />}
            p="sm"
        >
            <Stack gap="xs">
                <Text size="xs">
                    {t(view.continuable ? 'bannerBody' : 'bannerBodyStopped', {
                        spent: formatCost(view.spentUsd),
                        max: formatCost(view.budget.maxCostUsd),
                    })}
                </Text>
                <Group gap="xs" align="flex-end" wrap="wrap">
                    <NumberInput
                        size="xs"
                        w={150}
                        label={t('newBudget')}
                        value={amount}
                        onChange={setAmount}
                        min={0}
                        decimalScale={4}
                        disabled={busy}
                        error={amount !== '' && !amountOk ? t('invalidAmount', { spent: formatCost(view.spentUsd) }) : undefined}
                    />
                    <Button
                        size="xs"
                        loading={busy}
                        disabled={!amountOk}
                        onClick={() => { if (validBudgetAmount(amount, view)) onIncrease(amount); }}
                    >
                        {t(view.continuable ? 'increaseAndContinue' : 'increase')}
                    </Button>
                    <Button size="xs" variant="subtle" color="red" disabled={busy} onClick={onRemove}>
                        {t(view.continuable ? 'removeAndContinue' : 'removeBudget')}
                    </Button>
                </Group>
            </Stack>
        </Alert>
    );
}
