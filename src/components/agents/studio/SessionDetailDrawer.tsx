'use client';

/**
 * A session, read — not resumed.
 *
 * Clicking a session used to drop you straight into the chat, which is the
 * wrong default for most of what the list holds: API, A2A and scheduled runs
 * are real traffic you want to inspect, not continue. So a click opens the
 * same request inspector Model Hub uses for a log (`LlmRequestDetailModal`):
 * the conversation as one ordered stream — each tool call grouped with its
 * result — beside a Properties rail. Only a session a person started from the
 * console to try the agent offers Continue.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Code, Group, Text } from '@mantine/core';
import { IconPlayerPlay } from '@tabler/icons-react';
import LlmRequestDetailModal, {
    type LlmRequestDetailData,
    type LlmRequestItem,
} from '@/components/common/llm/LlmRequestDetail';
import FunctionsList from '@/components/common/ui/FunctionsList';
import TokenStats from '@/components/common/ui/TokenStats';
import { type PropertyRow } from '@/components/common/ui/PropertiesPanel';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { formatCost } from '../session/sessionUsage';
import type { ChatMessage } from '../session/sessionTypes';
import { isContinuableSession, messageCountOf, SessionSourceBadge, sessionSourceLabel, type SessionListItem } from './SessionList';

interface SessionRecord {
    _id: string;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    createdBy?: string;
    messages?: ChatMessage[];
    metadata?: Record<string, unknown>;
}

export interface SessionDetailDrawerProps {
    agentId: string;
    /** The row that was clicked; null closes the inspector. */
    session: SessionListItem | null;
    onClose: () => void;
    onContinue: (sessionId: string) => void;
}

/**
 * The stored transcript as the inspector's ordered stream: a divider per turn,
 * the user message, the turn's tool calls (call + result grouped by step id),
 * then the answer.
 */
function toItems(messages: ChatMessage[]): LlmRequestItem[] {
    const items: LlmRequestItem[] = [];
    let turn = 0;
    messages.forEach((message, index) => {
        if (message.role === 'user') {
            turn += 1;
            const at = (message as { timestamp?: string }).timestamp;
            items.push({
                itemType: 'divider',
                label: `Turn ${turn}${at ? ` · ${new Date(at).toLocaleTimeString()}` : ''}`,
            });
            items.push({ itemType: 'message', role: 'user', content: message.content });
            return;
        }
        (message.steps ?? []).forEach((step, stepIndex) => {
            const turnId = step.id ?? `${index}-${stepIndex}`;
            items.push({ itemType: 'call', turnId, name: step.name, args: step.args });
            items.push({
                itemType: 'result',
                turnId,
                name: step.name,
                content: step.error ? { error: step.error } : (step.rawOutput ?? step.output),
            });
        });
        items.push({ itemType: 'message', role: message.role, content: message.content });
    });
    return items;
}

export default function SessionDetailDrawer({ agentId, session, onClose, onContinue }: SessionDetailDrawerProps) {
    const [record, setRecord] = useState<SessionRecord | null>(null);
    const [error, setError] = useState<string | null>(null);
    const sessionId = session?._id;

    useEffect(() => {
        if (!sessionId) return;
        let cancelled = false;
        setRecord(null);
        setError(null);
        fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { cache: 'no-store' })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!cancelled) setRecord(data.session as SessionRecord);
            })
            .catch((err: unknown) => {
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            });
        return () => { cancelled = true; };
    }, [agentId, sessionId]);

    const data = useMemo<LlmRequestDetailData | null>(() => {
        if (!session) return null;
        const messages = record?.messages ?? [];
        const continuable = isContinuableSession(session.source);
        const toolNames = [...new Set(messages.flatMap((m) => (m.steps ?? []).map((step) => step.name)))];
        const failedSteps = messages.flatMap((m) => m.steps ?? []).filter((step) => step.status === 'error' || step.error).length;

        const properties: PropertyRow[] = [
            { key: 'created', label: 'Created', value: <Text size="sm">{session.createdAt ? new Date(session.createdAt).toLocaleString() : '—'}</Text> },
            { key: 'updated', label: 'Last activity', value: <Text size="sm">{formatRelativeTime(session.updatedAt ?? session.createdAt)}</Text> },
            { key: 'id', label: 'Session ID', value: <Code style={{ fontSize: 11, wordBreak: 'break-all' }}>{session._id}</Code> },
            { key: 'source', label: 'Source', value: <Text size="sm">{sessionSourceLabel(session.source)}</Text> },
            { key: 'turns', label: 'Turns', value: <Text size="sm">{session.turns ?? 0} · {messageCountOf(session)} messages</Text> },
            {
                key: 'tokens',
                label: 'Tokens',
                value: <TokenStats total={session.totalTokens} input={session.inputTokens} output={session.outputTokens} />,
            },
            {
                key: 'cost',
                label: 'Cost',
                value: <Text size="sm">{session.costUsd ? formatCost(session.costUsd) : '—'}{session.costUsd && session.costComplete === false ? ' +' : ''}</Text>,
            },
            {
                key: 'active',
                label: 'Active time',
                value: <Text size="sm">{session.activeMs ? formatDuration(session.activeMs) : '—'}</Text>,
            },
            { key: 'functions', label: 'Tools used', value: <FunctionsList names={toolNames} emptyLabel="No tool calls" /> },
            {
                key: 'context',
                label: 'Session context',
                value: session.hasContext ? <Badge size="xs" variant="light">set</Badge> : <Text size="sm" c="dimmed">none</Text>,
            },
        ];

        const badges = (
            <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="wrap">
                    <SessionSourceBadge source={session.source} />
                    <span className="ds-badge ds-badge-info">{session.turns ?? 0} turn{session.turns === 1 ? '' : 's'}</span>
                    {session.activeMs ? <span className="ds-badge">{formatDuration(session.activeMs)}</span> : null}
                    {toolNames.length > 0 ? <span className="ds-badge">{toolNames.length} tools</span> : null}
                    {failedSteps > 0 ? <span className="ds-badge ds-badge-err">{failedSteps} failed calls</span> : null}
                </Group>
                {continuable ? (
                    <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={() => onContinue(session._id)}>
                        Continue
                    </Button>
                ) : null}
            </Group>
        );

        const banner = error ? (
            <Alert color="red" variant="light">Could not load the transcript: {error}</Alert>
        ) : !continuable ? (
            <Alert color="gray" variant="light" p="xs">
                <Text size="xs">
                    Read-only — this session came in via {sessionSourceLabel(session.source)}. Only sessions started
                    from the console can be continued here.
                </Text>
            </Alert>
        ) : undefined;

        return {
            badges,
            banner,
            items: record ? toItems(messages) : [],
            properties,
            ...(record ? { raw: { request: record.metadata ?? {}, response: messages } } : {}),
        };
    }, [session, record, error, onContinue]);

    return (
        <LlmRequestDetailModal
            opened={Boolean(session)}
            onClose={onClose}
            title={session?.title || 'New session'}
            data={data}
            labels={{
                request: 'Session metadata',
                response: 'Transcript',
                noItems: record ? 'No messages in this session yet.' : 'Loading…',
            }}
        />
    );
}
