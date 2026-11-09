'use client';

/**
 * The right column of an agent's Overview: where the agent runs (API, A2A, triggers and the portals, channels and
 * voice models that use it) and what it uses. Both come from what the page already loads — the agent's own settings
 * and the resource-usage check that used to sit at the bottom of the page.
 */

import { Badge, Button, Group, Paper, Skeleton, Stack, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import ResourceUsagePanel, { type ResourceEdgeView } from '@/components/resources/ResourceUsagePanel';
import { tryTranslate } from '@/components/resources/i18nLookup';
import type { ResourceUsageResponse } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';

/** Referrers that are a place the agent answers in, rather than something built on it. */
export const AGENT_SURFACE_TYPES: ReadonlySet<string> = new Set([
    'portal',
    'channel-deployment',
    'channel-connection',
    'realtime-model',
]);

export function splitAgentUsedBy(usedBy: readonly ResourceEdgeView[]): {
    surfaces: ResourceEdgeView[];
    others: ResourceEdgeView[];
} {
    return {
        surfaces: usedBy.filter((edge) => AGENT_SURFACE_TYPES.has(edge.other.type)),
        others: usedBy.filter((edge) => !AGENT_SURFACE_TYPES.has(edge.other.type)),
    };
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <Group gap={8} wrap="nowrap" align="flex-start">
            <span className="ds-badge" style={{ flexShrink: 0 }}>{label}</span>
            <Text size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</Text>
        </Group>
    );
}

export interface AgentOverviewAsideProps {
    /** null while loading. */
    usage: ResourceUsageResponse | null;
    usageFailed: boolean;
    isConnected: boolean;
    publishedVersion: number | null;
    a2aEnabled: boolean;
    /** null when unknown (still loading, or the list could not be read). */
    triggerCount: number | null;
    onManage: () => void;
}

export default function AgentOverviewAside({
    usage,
    usageFailed,
    isConnected,
    publishedVersion,
    a2aEnabled,
    triggerCount,
    onManage,
}: AgentOverviewAsideProps) {
    const t = useTranslations('agents.overview');
    const tResources = useTranslations('resources');
    const tUsage = useTranslations('common.confirm.usage');
    const typeLabel = (type: string) => tryTranslate(tResources, `types.${type}`) ?? type;
    const { surfaces, others } = splitAgentUsedBy(usage?.usedBy ?? []);

    return (
        <Stack gap="md">
            <Paper withBorder radius="md" p="md" data-testid="agent-where-it-runs">
                <Text fw={600} size="sm" mb="sm">{t('whereItRuns')}</Text>
                <Stack gap={8}>
                    {isConnected ? null : (
                        <>
                            <Line label="API">
                                {publishedVersion ? t('apiPublished', { version: publishedVersion }) : t('apiUnpublished')}
                            </Line>
                            <Line label="A2A">{a2aEnabled ? t('a2aOn') : t('a2aOff')}</Line>
                            {triggerCount === null ? null : (
                                <Line label={t('triggerLabel')}>
                                    {triggerCount === 0
                                        ? t('triggersNone')
                                        : triggerCount === 1
                                            ? t('triggersOne')
                                            : t('triggersMany', { count: triggerCount })}
                                </Line>
                            )}
                        </>
                    )}
                    {usage === null && !usageFailed ? <Skeleton height={20} /> : null}
                    {surfaces.map((edge, index) => (
                        <Line key={`${edge.other.type}:${edge.other.id ?? edge.other.key ?? index}`} label={typeLabel(edge.other.type)}>
                            {edge.other.name ?? edge.other.key ?? '—'}
                            {edge.status !== 'ok' ? (
                                <Badge size="xs" variant="light" color="orange" ml={6}>
                                    {tryTranslate(tResources, `usage.status.${edge.status}`) ?? edge.status}
                                </Badge>
                            ) : null}
                        </Line>
                    ))}
                </Stack>
                <Button
                    mt="sm"
                    size="compact-xs"
                    variant="subtle"
                    rightSection={<IconArrowRight size={12} />}
                    onClick={onManage}
                >
                    {t('manageInShip')}
                </Button>
            </Paper>

            <Paper withBorder radius="md" p="md" data-testid="agent-uses">
                <Text fw={600} size="sm" mb="sm">{t('usesTitle')}</Text>
                {usageFailed ? (
                    <Text size="sm" c="dimmed">{t('loadFailed')}</Text>
                ) : usage === null ? (
                    <Skeleton height={60} />
                ) : (
                    <Stack gap="xs">
                        <ResourceUsagePanel compact uses={usage.uses ?? []} usedBy={others} />
                        {usage.hiddenUsedByCount > 0 ? (
                            <Text size="xs" c="dimmed">{tUsage('hiddenUses', { count: usage.hiddenUsedByCount })}</Text>
                        ) : null}
                    </Stack>
                )}
            </Paper>
        </Stack>
    );
}
