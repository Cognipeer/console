'use client';

/**
 * Side-by-side: the same message to two versions of the agent.
 *
 * Built for the question asked right before Publish — "is the draft actually
 * better than what is live?". Each side keeps its own history and runs
 * stateless (`history`, no `conversationId`), so comparing never writes a
 * session into the list or the published agent's traffic.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    Alert,
    Badge,
    Button,
    Drawer,
    Grid,
    Group,
    Loader,
    Paper,
    ScrollArea,
    SegmentedControl,
    Select,
    SimpleGrid,
    Stack,
    Text,
    Textarea,
    Tooltip,
} from '@mantine/core';
import { IconArrowsLeftRight, IconRefresh, IconSend } from '@tabler/icons-react';
import MessageBlock from '@/components/common/ui/MessageBlock';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import { formatDuration, formatNumber } from '@/lib/utils/tracingUtils';
import AgentMarkdown from '../session/AgentMarkdown';
import { formatCost } from '../session/sessionUsage';
import type { PlaygroundStep } from '../session/sessionTypes';
import {
    DEFAULT_RESPONSE_FORMAT,
    compareTotals,
    isResponseFormat,
    readTurnUsage,
    type CompareResponseFormat,
    type CompareTurn as Turn,
} from './compareVersionsStats';

const DRAFT = 'draft';

export interface CompareVersionsDrawerProps {
    opened: boolean;
    onClose: () => void;
    agentId: string;
    publishedVersion: number | null;
    /** Version numbers available to pick (newest first). */
    versions: number[];
    /** Build sections that differ between the saved draft and the published version. */
    changedSections?: string[];
    /** Prefill the composer — e.g. the last message of the session it was opened from. */
    initialMessage?: string;
}

export default function CompareVersionsDrawer({
    opened,
    onClose,
    agentId,
    publishedVersion,
    versions,
    changedSections,
    initialMessage,
}: CompareVersionsDrawerProps) {
    const t = useTranslations('agents.compare');
    const [left, setLeft] = useState<string>(DRAFT);
    const [right, setRight] = useState<string>(publishedVersion ? String(publishedVersion) : String(versions[0] ?? DRAFT));
    const [leftTurns, setLeftTurns] = useState<Turn[]>([]);
    const [rightTurns, setRightTurns] = useState<Turn[]>([]);
    const [input, setInput] = useState('');
    const [running, setRunning] = useState(false);
    // One mode for both columns, kept across version switches and resets, so
    // the two answers are always read in the same form.
    const [responseFormat, setResponseFormat] = useState<CompareResponseFormat>(DEFAULT_RESPONSE_FORMAT);

    const sideLabel = (value: string): string => {
        if (value === DRAFT) return t('draft');
        return Number(value) === publishedVersion
            ? t('publishedVersionOption', { version: value })
            : t('versionOption', { version: value });
    };

    useEffect(() => {
        if (opened && initialMessage && !input) setInput(initialMessage);
        // Only when the drawer opens — not while someone is typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened]);

    useEffect(() => {
        if (publishedVersion) setRight(String(publishedVersion));
    }, [publishedVersion]);

    const options = useMemo(() => [
        { value: DRAFT, label: t('draftOption') },
        ...versions.map((version) => ({
            value: String(version),
            label: version === publishedVersion
                ? t('publishedVersionOption', { version })
                : t('versionOption', { version }),
        })),
    ], [versions, publishedVersion, t]);

    const reset = () => { setLeftTurns([]); setRightTurns([]); };

    const runSide = async (side: string, history: Turn[], message: string): Promise<Turn> => {
        const startedAt = Date.now();
        try {
            const res = await fetch(`/api/agents/${agentId}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    history: history
                        .filter((turn) => turn.role !== 'error')
                        .map((turn) => ({ role: turn.role, content: turn.content })),
                    ...(side !== DRAFT ? { version: Number(side) } : {}),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return { role: 'error', content: String(data.error ?? `HTTP ${res.status}`) };
            return {
                role: 'assistant',
                content: String(data.content ?? ''),
                steps: Array.isArray(data.steps) ? data.steps as PlaygroundStep[] : undefined,
                latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : Date.now() - startedAt,
                ...readTurnUsage(data.usage),
            };
        } catch (error) {
            return { role: 'error', content: error instanceof Error ? error.message : String(error) };
        }
    };

    const send = async () => {
        const message = input.trim();
        if (!message || running) return;
        setRunning(true);
        setInput('');
        const user: Turn = { role: 'user', content: message };
        const leftHistory = leftTurns;
        const rightHistory = rightTurns;
        setLeftTurns([...leftHistory, user]);
        setRightTurns([...rightHistory, user]);
        const [leftAnswer, rightAnswer] = await Promise.all([
            runSide(left, leftHistory, message),
            runSide(right, rightHistory, message),
        ]);
        setLeftTurns([...leftHistory, user, leftAnswer]);
        setRightTurns([...rightHistory, user, rightAnswer]);
        setRunning(false);
    };

    const column = (side: string, onSide: (value: string) => void, turns: Turn[]) => {
        const sum = compareTotals(turns);
        const tokenValue = (value: number | undefined) => (
            value === undefined
                ? <Tooltip label={t('stats.notReported')} withArrow><span>—</span></Tooltip>
                : formatNumber(value)
        );
        return (
            <Paper withBorder radius="md" p="md" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <Group justify="space-between" mb="sm" wrap="nowrap">
                    <Select
                        size="xs"
                        w={220}
                        data={options}
                        value={side}
                        onChange={(value) => { if (value) { onSide(value); reset(); } }}
                        allowDeselect={false}
                        disabled={running}
                    />
                    <Badge variant="light" color={side === DRAFT ? 'orange' : 'teal'}>
                        {sideLabel(side)}
                    </Badge>
                </Group>
                <ScrollArea.Autosize mah="calc(100vh - 360px)" type="auto" offsetScrollbars>
                    <Stack gap="sm">
                        {turns.length === 0 ? (
                            <Text size="sm" c="dimmed">{t('empty')}</Text>
                        ) : turns.map((turn, index) => (
                            turn.role === 'error' ? (
                                <Alert key={index} color="red" variant="light" p="xs">
                                    <Text size="xs">{turn.content}</Text>
                                </Alert>
                            ) : (
                                <Paper key={index} withBorder={turn.role === 'assistant'} radius="md" p="sm" bg={turn.role === 'user' ? 'var(--ds-surface-sunken, var(--mantine-color-gray-0))' : undefined}>
                                    <Stack gap={6}>
                                        {turn.role === 'assistant' && responseFormat === 'markdown' ? (
                                            turn.content.trim() ? (
                                                <Stack gap={6}>
                                                    <Text size="sm" fw={700}>{t('roleAssistant')}</Text>
                                                    <AgentMarkdown text={turn.content} />
                                                </Stack>
                                            ) : null
                                        ) : (
                                            <MessageBlock
                                                messageRole={turn.role}
                                                content={turn.content}
                                                roleLabel={turn.role === 'assistant' ? t('roleAssistant') : t('roleUser')}
                                            />
                                        )}
                                        {turn.steps?.length ? (
                                            <Group gap={4}>
                                                {turn.steps.map((step, stepIndex) => (
                                                    <StatusBadge
                                                        key={stepIndex}
                                                        status={step.status === 'error' || step.error ? 'error' : 'ok'}
                                                        label={step.name}
                                                        withDot
                                                    />
                                                ))}
                                            </Group>
                                        ) : null}
                                        {turn.role === 'assistant' ? (
                                            <Group gap="md">
                                                {turn.latencyMs ? <Text size="xs" c="dimmed">{formatDuration(turn.latencyMs)}</Text> : null}
                                                {turn.totalTokens ? <Text size="xs" c="dimmed">{t('turnTokens', { count: formatNumber(turn.totalTokens) })}</Text> : null}
                                                {turn.costUsd ? <Text size="xs" c="dimmed">{formatCost(turn.costUsd)}</Text> : null}
                                            </Group>
                                        ) : null}
                                    </Stack>
                                </Paper>
                            )
                        ))}
                        {running ? <Group gap="xs"><Loader size="xs" /><Text size="xs" c="dimmed">{t('running')}</Text></Group> : null}
                    </Stack>
                </ScrollArea.Autosize>
                {turns.some((turn) => turn.role === 'assistant') ? (
                    <Grid
                        type="container"
                        breakpoints={STATS_BREAKPOINTS}
                        columns={6}
                        gutter="sm"
                        mt="sm"
                        pt="sm"
                        style={{ borderTop: '1px solid var(--ds-border-soft, var(--mantine-color-gray-2))' }}
                    >
                        {/*
                          * Wide: Latency | Cost | Tool calls on the left half, Tokens on the
                          * right half with its breakdown as a second row directly beneath —
                          * set off by a divider so the two rows read as one group.
                          * Narrow: the three scalar stats share a row and the Tokens group
                          * moves below them, full width, so its breakdown never gets squeezed.
                          */}
                        <Grid.Col span={{ base: 2, sm: 1 }}>
                            <Stat label={t('stats.latency')} value={formatDuration(sum.latencyMs)} />
                        </Grid.Col>
                        <Grid.Col span={{ base: 2, sm: 1 }}>
                            <Stat label={t('stats.cost')} value={sum.cost ? formatCost(sum.cost) : '—'} />
                        </Grid.Col>
                        <Grid.Col span={{ base: 2, sm: 1 }}>
                            <Stat label={t('stats.toolCalls')} value={String(sum.toolCalls)} />
                        </Grid.Col>
                        <Grid.Col span={{ base: 6, sm: 3 }}>
                            <Stack
                                gap={6}
                                pl="sm"
                                style={{ borderLeft: '1px solid var(--ds-border-soft, var(--mantine-color-gray-2))' }}
                            >
                                <Stat label={t('stats.tokens')} value={tokenValue(sum.tokens)} />
                                <SimpleGrid cols={3} spacing="xs">
                                    <Stat label={t('stats.input')} value={tokenValue(sum.inputTokens)} secondary />
                                    <Stat label={t('stats.output')} value={tokenValue(sum.outputTokens)} secondary />
                                    <Stat
                                        label={t('stats.cache')}
                                        hint={t('stats.cacheHint')}
                                        value={tokenValue(sum.cachedInputTokens)}
                                        secondary
                                    />
                                </SimpleGrid>
                            </Stack>
                        </Grid.Col>
                    </Grid>
                ) : null}
            </Paper>
        );
    };

    return (
        <Drawer
            opened={opened}
            onClose={onClose}
            position="right"
            size="90%"
            title={
                <Group gap="xs">
                    <IconArrowsLeftRight size={16} />
                    <Text fw={600}>{t('title')}</Text>
                </Group>
            }
        >
            <Stack gap="md">
                {changedSections && changedSections.length > 0 ? (
                    <Group gap={6}>
                        <Text size="xs" c="dimmed">{t('changedSince', { version: publishedVersion })}</Text>
                        {changedSections.map((section) => (
                            <Badge key={section} size="sm" variant="light" color="orange">{section}</Badge>
                        ))}
                    </Group>
                ) : null}
                <Group justify="space-between" gap="xs">
                    <Text size="xs" c="dimmed">{t('statelessHint')}</Text>
                    <SegmentedControl
                        size="xs"
                        aria-label={t('responseFormat')}
                        value={responseFormat}
                        onChange={(value) => { if (isResponseFormat(value)) setResponseFormat(value); }}
                        data={[
                            { value: 'markdown', label: t('formatMarkdown') },
                            { value: 'plain', label: t('formatPlain') },
                        ]}
                    />
                </Group>
                <SimpleGrid cols={2} spacing="md">
                    {column(left, setLeft, leftTurns)}
                    {column(right, setRight, rightTurns)}
                </SimpleGrid>
                <Group align="flex-end" wrap="nowrap">
                    <Textarea
                        style={{ flex: 1 }}
                        placeholder={t('inputPlaceholder')}
                        value={input}
                        onChange={(event) => setInput(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        autosize
                        minRows={1}
                        maxRows={6}
                        disabled={running}
                    />
                    <Button leftSection={<IconSend size={14} />} onClick={() => void send()} loading={running} disabled={!input.trim()}>
                        {t('send')}
                    </Button>
                    <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={reset} disabled={running}>
                        {t('reset')}
                    </Button>
                </Group>
                {left === right ? (
                    <Text size="xs" c="orange">{t('sameVersion')}</Text>
                ) : null}
            </Stack>
        </Drawer>
    );
}

/** Container widths (the column, not the viewport): each side is half a drawer. */
const STATS_BREAKPOINTS = { xs: '240px', sm: '420px', md: '560px', lg: '720px', xl: '960px' };

function Stat({ label, value, hint, secondary = false }: {
    label: string;
    value: ReactNode;
    /** Explains a label that is easy to misread (e.g. cache is part of input). */
    hint?: string;
    /** A breakdown of the stat above it — drawn smaller so the total still leads. */
    secondary?: boolean;
}) {
    const labelText = <Text size="10px" c="dimmed" tt="uppercase" fw={600} truncate>{label}</Text>;
    return (
        <Stack gap={0} miw={0}>
            {hint ? <Tooltip label={hint} withArrow multiline maw={240}>{labelText}</Tooltip> : labelText}
            <Text size={secondary ? 'xs' : 'sm'} fw={secondary ? 500 : 600} ff="monospace" truncate>{value}</Text>
        </Stack>
    );
}
