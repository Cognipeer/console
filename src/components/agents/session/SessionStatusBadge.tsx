'use client';

/**
 * The badge for what a session is doing: running, waiting for a person, paused
 * on its spend budget, or idle. One component for the session header and the
 * Sessions drawer, so the two say the same thing about the same session.
 */

import { Badge, Tooltip } from '@mantine/core';
import { IconCoin, IconHandStop } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { SessionStatusKind } from './sessionActivityUi';

export interface SessionStatusBadgeProps {
    status: SessionStatusKind;
    size?: 'xs' | 'sm';
    /**
     * The session waits for a person but the server says THIS viewer may not answer it: the badge then says it waits
     * for an approver instead of claiming it waits for the viewer.
     */
    waitingElsewhere?: boolean;
}

export default function SessionStatusBadge({ status, size = 'sm', waitingElsewhere = false }: SessionStatusBadgeProps) {
    const t = useTranslations('agents.hitl');
    const tb = useTranslations('agents.budget');
    const ts = useTranslations('agents.sessionAccess');
    const icon = size === 'xs' ? 10 : 11;

    if (status === 'running') {
        return <Badge size={size} variant="light" color="blue">{t('running')}</Badge>;
    }
    if (status === 'waiting') {
        return (
            <Tooltip label={waitingElsewhere ? ts('waitingElsewhereTooltip') : t('waitingTooltip')} withArrow>
                <Badge size={size} variant="light" color="orange" leftSection={<IconHandStop size={icon} />}>
                    {waitingElsewhere ? ts('waitingElsewhereBadge') : t('waitingBadge')}
                </Badge>
            </Tooltip>
        );
    }
    if (status === 'budget_paused') {
        return (
            <Tooltip label={tb('pausedTooltip')} withArrow>
                <Badge size={size} variant="light" color="orange" leftSection={<IconCoin size={icon} />}>
                    {tb('pausedBadge')}
                </Badge>
            </Tooltip>
        );
    }
    return <Badge size={size} variant="light" color="gray">{t('idle')}</Badge>;
}
