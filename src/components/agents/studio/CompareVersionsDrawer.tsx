'use client';

/**
 * Side-by-side: the same message to two versions of the agent.
 *
 * Built for the question asked right before Publish — "is the draft actually
 * better than what is live?". Each side keeps its own history and runs
 * stateless (`history`, no `conversationId`), so comparing never writes a
 * session into the list or the published agent's traffic.
 */

import { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Drawer,
    Group,
    Loader,
    Paper,
    ScrollArea,
    Select,
    SimpleGrid,
    Stack,
    Text,
    Textarea,
} from '@mantine/core';
import { IconArrowsLeftRight, IconRefresh, IconSend } from '@tabler/icons-react';
import MessageBlock from '@/components/common/ui/MessageBlock';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { formatDuration, formatNumber } from '@/lib/utils/tracingUtils';
import { formatCost } from '../session/sessionUsage';
import type { PlaygroundStep } from '../session/sessionTypes';

interface Turn {
    role: 'user' | 'assistant' | 'error';
    content: string;
    steps?: PlaygroundStep[];
    latencyMs?: number;
    totalTokens?: number;
    costUsd?: number;
}

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

function sideLabel(value: string, publishedVersion: number | null): string {
    if (value === DRAFT) return 'Draft';
    return `v${value}${Number(value) === publishedVersion ? ' · published' : ''}`;
}

function totals(turns: Turn[]) {
    const answers = turns.filter((turn) => turn.role === 'assistant');
    return {
        latencyMs: answers.reduce((sum, turn) => sum + (turn.latencyMs ?? 0), 0),
        tokens: answers.reduce((sum, turn) => sum + (turn.totalTokens ?? 0), 0),
        cost: answers.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
        toolCalls: answers.reduce((sum, turn) => sum + (turn.steps?.length ?? 0), 0),
    };
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
    const [left, setLeft] = useState<string>(DRAFT);
    const [right, setRight] = useState<string>(publishedVersion ? String(publishedVersion) : String(versions[0] ?? DRAFT));
    const [leftTurns, setLeftTurns] = useState<Turn[]>([]);
    const [rightTurns, setRightTurns] = useState<Turn[]>([]);
    const [input, setInput] = useState('');
    const [running, setRunning] = useState(false);

    useEffect(() => {
        if (opened && initialMessage && !input) setInput(initialMessage);
        // Only when the drawer opens — not while someone is typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened]);

    useEffect(() => {
        if (publishedVersion) setRight(String(publishedVersion));
    }, [publishedVersion]);

    const options = useMemo(() => [
        { value: DRAFT, label: 'Draft (current config)' },
        ...versions.map((version) => ({ value: String(version), label: sideLabel(String(version), publishedVersion) })),
    ], [versions, publishedVersion]);

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
                totalTokens: data.usage?.totalTokens,
                costUsd: data.usage?.costUsd,
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
        const sum = totals(turns);
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
                        {sideLabel(side, publishedVersion)}
                    </Badge>
                </Group>
                <ScrollArea.Autosize mah="calc(100vh - 360px)" type="auto">
                    <Stack gap="sm">
                        {turns.length === 0 ? (
                            <Text size="sm" c="dimmed">Send a message to compare.</Text>
                        ) : turns.map((turn, index) => (
                            turn.role === 'error' ? (
                                <Alert key={index} color="red" variant="light" p="xs">
                                    <Text size="xs">{turn.content}</Text>
                                </Alert>
                            ) : (
                                <Paper key={index} withBorder={turn.role === 'assistant'} radius="md" p="sm" bg={turn.role === 'user' ? 'var(--ds-surface-sunken, var(--mantine-color-gray-0))' : undefined}>
                                    <Stack gap={6}>
                                        <MessageBlock messageRole={turn.role} content={turn.content} />
                                        {(turn.steps ?? []).length > 0 ? (
                                            <Group gap={4}>
                                                {(turn.steps ?? []).map((step, stepIndex) => (
                                                    <Group key={stepIndex} gap={4} wrap="nowrap">
                                                        <StatusBadge
                                                            status={step.status === 'error' || step.error ? 'error' : 'ok'}
                                                            label={step.name}
                                                            withDot
                                                        />
                                                    </Group>
                                                ))}
                                            </Group>
                                        ) : null}
                                        {turn.role === 'assistant' ? (
                                            <Group gap="md">
                                                {turn.latencyMs ? <Text size="xs" c="dimmed">{formatDuration(turn.latencyMs)}</Text> : null}
                                                {turn.totalTokens ? <Text size="xs" c="dimmed">{formatNumber(turn.totalTokens)} tokens</Text> : null}
                                                {turn.costUsd ? <Text size="xs" c="dimmed">{formatCost(turn.costUsd)}</Text> : null}
                                            </Group>
                                        ) : null}
                                    </Stack>
                                </Paper>
                            )
                        ))}
                        {running ? <Group gap="xs"><Loader size="xs" /><Text size="xs" c="dimmed">Running…</Text></Group> : null}
                    </Stack>
                </ScrollArea.Autosize>
                {turns.some((turn) => turn.role === 'assistant') ? (
                    <SimpleGrid cols={4} mt="sm" pt="sm" style={{ borderTop: '1px solid var(--ds-border-soft, var(--mantine-color-gray-2))' }}>
                        <Stat label="Latency" value={formatDuration(sum.latencyMs)} />
                        <Stat label="Tokens" value={sum.tokens ? formatNumber(sum.tokens) : '—'} />
                        <Stat label="Cost" value={sum.cost ? formatCost(sum.cost) : '—'} />
                        <Stat label="Tool calls" value={String(sum.toolCalls)} />
                    </SimpleGrid>
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
                    <Text fw={600}>Compare versions</Text>
                </Group>
            }
        >
            <Stack gap="md">
                {changedSections && changedSections.length > 0 ? (
                    <Group gap={6}>
                        <Text size="xs" c="dimmed">Changed in draft since v{publishedVersion}:</Text>
                        {changedSections.map((section) => (
                            <Badge key={section} size="sm" variant="light" color="orange">{section}</Badge>
                        ))}
                    </Group>
                ) : null}
                <Text size="xs" c="dimmed">
                    Each side keeps its own history and runs without creating a session.
                </Text>
                <SimpleGrid cols={2} spacing="md">
                    {column(left, setLeft, leftTurns)}
                    {column(right, setRight, rightTurns)}
                </SimpleGrid>
                <Group align="flex-end" wrap="nowrap">
                    <Textarea
                        style={{ flex: 1 }}
                        placeholder="Send the same message to both…"
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
                        Send to both
                    </Button>
                    <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={reset} disabled={running}>
                        Reset
                    </Button>
                </Group>
                {left === right ? (
                    <Text size="xs" c="orange">Both sides run the same version.</Text>
                ) : null}
            </Stack>
        </Drawer>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <Stack gap={0}>
            <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
            <Text size="sm" fw={600} ff="monospace">{value}</Text>
        </Stack>
    );
}
