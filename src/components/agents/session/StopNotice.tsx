'use client';

/**
 * A run that ended without a final answer, said above the text it left behind.
 */

import { Alert, Text } from '@mantine/core';
import { IconHandStop } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { budgetStopAmounts, isBudgetStop } from './sessionBudgetUi';
import type { ChatMessage } from './sessionTypes';

/**
 * A run that ended without a final answer. Says why, and what the text below
 * it is — the agent's progress up to the stop, not its answer.
 *
 * A stop on the SESSION budget says so (the SDK's generic `limit` would send
 * the reader to the per-turn limit in Configure) and points at the budget banner
 * only while that banner is still there.
 */
export default function StopNotice({
    message,
    budgetBannerShown,
    budgetStops = false,
}: {
    message: ChatMessage;
    budgetBannerShown: boolean;
    /** The session budget stops the session instead of pausing it: raising it reopens the composer, it does not carry the turn on. */
    budgetStops?: boolean;
}) {
    const ts = useTranslations('agents.stopNotice');
    if (!message.stopReason) return null;
    const hasText = Boolean(message.content?.trim());
    const budgetStop = isBudgetStop(message);
    const amounts = budgetStop ? budgetStopAmounts(message.stopDetail) : undefined;
    const title = budgetStop
        ? `${ts('budget')}${amounts ? ` (${amounts})` : ''}`
        : `${ts(message.stopReason)}${message.stopDetail ? ` — ${message.stopDetail}` : ''}`;
    const hint = budgetStop
        ? (budgetBannerShown ? ts(budgetStops ? 'budgetHintStopped' : 'budgetHint') : '')
        : (message.stopReason === 'limit' ? ts('limitHint') : '');
    return (
        <Alert
            variant="light"
            color={message.stopReason === 'limit' ? 'orange' : message.stopReason === 'error' ? 'red' : 'gray'}
            icon={<IconHandStop size={14} />}
            mb="xs"
            p="xs"
        >
            <Text size="xs" fw={600}>{title}</Text>
            <Text size="xs" c="dimmed">
                {[hasText ? ts('partialText') : ts('noText'), hint].filter(Boolean).join(' ')}
            </Text>
        </Alert>
    );
}
