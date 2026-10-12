'use client';

/**
 * Feedback — what people said about this agent's answers.
 *
 * Counts, the share of thumbs up, which reasons people gave for a thumbs down,
 * and the latest ratings with a link to the session. The words people wrote are
 * shown only to those who can change the agent (the server decides and says so
 * in `canReadComments`); everyone who can read the agent sees the counts.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    Anchor,
    Badge,
    Button,
    Checkbox,
    Group,
    Paper,
    Progress,
    SegmentedControl,
    Select,
    Skeleton,
    Stack,
    Text,
} from '@mantine/core';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import Link from 'next/link';
import EmptyState from '@/components/common/EmptyState';
import SectionCard from '@/components/common/SectionCard';
import { useTranslations } from '@/lib/i18n';
import type { AgentFeedbackReason, AgentMessageFeedbackTotals } from '@/lib/database/provider/types.domain';
import { formatRelativeTime } from '@/lib/utils/tracingUtils';
import {
    DEFAULT_FEEDBACK_FILTER,
    FEEDBACK_REASON_ORDER,
    FEEDBACK_WINDOWS,
    feedbackQuery,
    formatPositiveRate,
    reasonBars,
    type FeedbackFilterState,
    type FeedbackWindowDays,
    type SessionMessageFeedback,
} from './feedbackUi';

interface FeedbackSummary extends AgentMessageFeedbackTotals {
    total: number;
    positiveRate: number | null;
}

interface FeedbackItem extends SessionMessageFeedback {
    conversationId: string;
    agentVersion: number | null;
}

const PAGE_SIZE = 20;

export default function AgentFeedbackPanel({ agentId }: { agentId: string }) {
    const t = useTranslations('agents.feedback');
    const [filter, setFilter] = useState<FeedbackFilterState>(DEFAULT_FEEDBACK_FILTER);
    const [summary, setSummary] = useState<FeedbackSummary | null>(null);
    const [items, setItems] = useState<FeedbackItem[]>([]);
    const [total, setTotal] = useState(0);
    const [canReadComments, setCanReadComments] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [failed, setFailed] = useState(false);

    const load = useCallback(async (reset: boolean, skip: number) => {
        if (reset) setLoading(true); else setLoadingMore(true);
        try {
            const [summaryRes, listRes] = await Promise.all([
                reset ? fetch(`/api/agents/${agentId}/feedback/summary?${feedbackQuery(filter)}`, { cache: 'no-store' }) : Promise.resolve(null),
                fetch(`/api/agents/${agentId}/feedback?${feedbackQuery(filter, { limit: PAGE_SIZE, skip })}`, { cache: 'no-store' }),
            ]);
            if (!listRes.ok || (summaryRes && !summaryRes.ok)) throw new Error('load failed');
            const list = await listRes.json() as { items: FeedbackItem[]; total: number; canReadComments: boolean };
            if (summaryRes) setSummary((await summaryRes.json() as { summary: FeedbackSummary }).summary);
            setItems((previous) => (reset ? list.items : [...previous, ...list.items]));
            setTotal(list.total);
            setCanReadComments(list.canReadComments);
            setFailed(false);
        } catch {
            setFailed(true);
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
    }, [agentId, filter]);

    useEffect(() => { void load(true, 0); }, [load]);

    const bars = reasonBars(summary?.reasons);
    const reasonLabel = (reason: AgentFeedbackReason) => t(`reason.${reason}`);

    return (
        <Stack gap="md">
            <SectionCard title={t('title')} description={t('description')}>
                <Group gap="md" align="flex-end" wrap="wrap">
                    <SegmentedControl
                        size="xs"
                        value={String(filter.days)}
                        onChange={(value) => setFilter((current) => ({ ...current, days: Number(value) as FeedbackWindowDays }))}
                        data={FEEDBACK_WINDOWS.map((days) => ({ value: String(days), label: t('lastDays', { days }) }))}
                    />
                    <SegmentedControl
                        size="xs"
                        value={filter.rating}
                        onChange={(value) => setFilter((current) => ({ ...current, rating: value as FeedbackFilterState['rating'] }))}
                        data={[
                            { value: 'all', label: t('ratingAll') },
                            { value: 'up', label: t('ratingUp') },
                            { value: 'down', label: t('ratingDown') },
                        ]}
                    />
                    <Select
                        size="xs"
                        w={190}
                        label={t('reasonFilter')}
                        value={filter.reason}
                        allowDeselect={false}
                        onChange={(value) => setFilter((current) => ({ ...current, reason: (value ?? 'all') as FeedbackFilterState['reason'] }))}
                        data={[{ value: 'all', label: t('reasonAll') }, ...FEEDBACK_REASON_ORDER.map((reason) => ({ value: reason, label: reasonLabel(reason) }))]}
                    />
                    {canReadComments ? (
                        <Checkbox
                            size="xs"
                            label={t('onlyWithComment')}
                            checked={filter.onlyWithComment}
                            onChange={(event) => setFilter((current) => ({ ...current, onlyWithComment: event.currentTarget.checked }))}
                        />
                    ) : null}
                </Group>

                {loading ? (
                    <Stack gap="xs"><Skeleton h={64} /><Skeleton h={120} /></Stack>
                ) : failed ? (
                    <Text size="sm" c="red">{t('loadFailed')}</Text>
                ) : (
                    <>
                        <Group gap="md" wrap="wrap">
                            <Stat label={t('statTotal')} value={String(summary?.total ?? 0)} />
                            <Stat label={t('statPositive')} value={formatPositiveRate(summary?.positiveRate)} />
                            <Stat label={t('statUp')} value={String(summary?.up ?? 0)} icon={<IconThumbUp size={14} />} />
                            <Stat label={t('statDown')} value={String(summary?.down ?? 0)} icon={<IconThumbDown size={14} />} />
                            <Stat label={t('statComments')} value={String(summary?.withComment ?? 0)} />
                        </Group>

                        <Stack gap={6}>
                            <Text fw={600} size="sm">{t('reasonsTitle')}</Text>
                            {bars.length === 0 ? (
                                <Text size="sm" c="dimmed">{t('reasonsEmpty')}</Text>
                            ) : bars.map((bar) => (
                                <Group key={bar.reason} gap="sm" wrap="nowrap">
                                    <Text size="sm" w={120}>{reasonLabel(bar.reason)}</Text>
                                    <Progress value={bar.percent} flex={1} size="md" aria-label={reasonLabel(bar.reason)} />
                                    <Text size="sm" w={36} ta="right">{bar.count}</Text>
                                </Group>
                            ))}
                        </Stack>
                    </>
                )}
            </SectionCard>

            <SectionCard title={t('latestTitle')} description={canReadComments ? t('latestDescription') : t('latestNoComments')}>
                {loading ? (
                    <Skeleton h={80} />
                ) : items.length === 0 ? (
                    <EmptyState title={t('empty')} description={t('emptyDescription')} icon={<IconThumbUp size={24} stroke={1.6} />} minHeight={140} />
                ) : (
                    <Stack gap="xs">
                        {items.map((item) => (
                            <Paper key={`${item.conversationId}-${item.messageId}-${item.userId ?? item.updatedAt}`} withBorder radius="md" p="sm">
                                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                                    <Stack gap={4} flex={1}>
                                        <Group gap="xs" wrap="wrap">
                                            <Badge
                                                size="sm"
                                                variant="light"
                                                color={item.rating === 'up' ? 'teal' : 'red'}
                                                leftSection={item.rating === 'up' ? <IconThumbUp size={12} /> : <IconThumbDown size={12} />}
                                            >
                                                {item.rating === 'up' ? t('ratingUp') : t('ratingDown')}
                                            </Badge>
                                            {item.reasons.map((reason) => (
                                                <Badge key={reason} size="sm" variant="outline" color="gray" tt="none">{reasonLabel(reason)}</Badge>
                                            ))}
                                            {item.removed ? <Badge size="sm" variant="light" color="gray">{t('removed')}</Badge> : null}
                                            {item.portalId ? <Badge size="sm" variant="light" color="grape" tt="none">{t('portal')}</Badge> : null}
                                        </Group>
                                        {item.comment ? <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{item.comment}</Text> : null}
                                    </Stack>
                                    <Stack gap={2} align="flex-end">
                                        <Text size="xs" c="dimmed">{formatRelativeTime(item.updatedAt)}</Text>
                                        <Anchor
                                            component={Link}
                                            size="xs"
                                            href={`/dashboard/agents/${agentId}/sessions/${item.conversationId}?message=${item.messageIndex}`}
                                        >
                                            {t('openSession')}
                                        </Anchor>
                                    </Stack>
                                </Group>
                            </Paper>
                        ))}
                        {items.length < total ? (
                            <Group justify="center">
                                <Button size="xs" variant="subtle" loading={loadingMore} onClick={() => void load(false, items.length)}>
                                    {t('loadMore')}
                                </Button>
                            </Group>
                        ) : null}
                    </Stack>
                )}
            </SectionCard>
        </Stack>
    );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
    return (
        <Paper withBorder radius="md" p="sm" miw={120}>
            <Text size="xs" c="dimmed">{label}</Text>
            <Group gap={6} align="center">
                {icon}
                <Text fw={650} size="xl">{value}</Text>
            </Group>
        </Paper>
    );
}
