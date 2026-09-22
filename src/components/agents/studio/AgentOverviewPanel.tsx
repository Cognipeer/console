'use client';

/**
 * Overview — the landing tab.
 *
 * Answers "is this agent healthy and what has it been doing" in one screen,
 * rather than opening on a blank chat box (the old default) or a settings
 * form (which says nothing about whether the agent actually works).
 */

import { Badge, Button, Card, Group, SimpleGrid, Stack, Text, ThemeIcon } from '@mantine/core';
import {
    IconCalendarTime,
    IconGitBranch,
    IconMessageCircle,
    IconPlus,
    IconRobot,
    IconTool,
    IconUsers,
} from '@tabler/icons-react';
import SectionCard from '@/components/common/SectionCard';
import SessionList, { type SessionListItem } from './SessionList';

interface OverviewAgent {
    name: string;
    description?: string;
    status: string;
    publishedVersion?: number | null;
    config?: { modelKey?: string; kind?: 'native' | 'external' };
}

export interface AgentOverviewPanelProps {
    agent: OverviewAgent;
    isConnected: boolean;
    toolCount: number;
    subagentCount: number;
    hasKnowledgeEngine: boolean;
    sessions: SessionListItem[];
    sessionsLoading: boolean;
    startingSession?: boolean;
    onStartSession: () => void;
    onOpenSession: (sessionId: string) => void;
    onGoToTab: (tab: string) => void;
}

function StatCard({
    icon,
    label,
    value,
    onClick,
}: {
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
    onClick?: () => void;
}) {
    return (
        <Card
            withBorder
            padding="md"
            radius="md"
            onClick={onClick}
            style={onClick ? { cursor: 'pointer' } : undefined}
        >
            <Group gap="sm" wrap="nowrap">
                <ThemeIcon size={36} radius="md" variant="light" color="gray">
                    {icon}
                </ThemeIcon>
                <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="xs" c="dimmed">{label}</Text>
                    <Text size="lg" fw={700}>{value}</Text>
                </Stack>
            </Group>
        </Card>
    );
}

export default function AgentOverviewPanel({
    agent,
    isConnected,
    toolCount,
    subagentCount,
    hasKnowledgeEngine,
    sessions,
    sessionsLoading,
    startingSession,
    onStartSession,
    onOpenSession,
    onGoToTab,
}: AgentOverviewPanelProps) {
    const capabilityCount = toolCount + subagentCount + (hasKnowledgeEngine ? 1 : 0);

    return (
        <Stack gap="lg">
            <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
                <StatCard
                    icon={<IconRobot size={18} />}
                    label="Status"
                    value={
                        <Badge size="sm" variant="light" color={agent.status === 'active' ? 'teal' : 'gray'}>
                            {agent.status}
                        </Badge>
                    }
                />
                <StatCard
                    icon={<IconGitBranch size={18} />}
                    label="Published"
                    value={agent.publishedVersion ? `v${agent.publishedVersion}` : 'never'}
                    onClick={() => onGoToTab('versions')}
                />
                <StatCard
                    icon={<IconMessageCircle size={18} />}
                    label="Sessions"
                    value={sessions.length}
                    onClick={() => onGoToTab('sessions')}
                />
                <StatCard
                    icon={<IconTool size={18} />}
                    label="Capabilities"
                    value={capabilityCount}
                    onClick={() => onGoToTab('settings')}
                />
            </SimpleGrid>

            {!isConnected ? (
                <Group gap="xs">
                    {toolCount > 0 ? (
                        <Badge variant="outline" leftSection={<IconTool size={11} />}>
                            {toolCount} tool{toolCount === 1 ? '' : 's'}
                        </Badge>
                    ) : null}
                    {subagentCount > 0 ? (
                        <Badge variant="outline" color="violet" leftSection={<IconUsers size={11} />}>
                            {subagentCount} sub-agent{subagentCount === 1 ? '' : 's'}
                        </Badge>
                    ) : null}
                    {hasKnowledgeEngine ? <Badge variant="outline" color="blue">Knowledge engine attached</Badge> : null}
                    <Badge
                        variant="outline"
                        color="grape"
                        leftSection={<IconCalendarTime size={11} />}
                        style={{ cursor: 'pointer' }}
                        onClick={() => onGoToTab('schedules')}
                    >
                        Schedules
                    </Badge>
                </Group>
            ) : (
                <Badge variant="light" color="violet">Connected agent — configuration lives on the remote endpoint</Badge>
            )}

            <SectionCard
                title="Recent sessions"
                description="Pick up where a conversation left off, or start a new one."
                actions={
                    <Button size="xs" leftSection={<IconPlus size={14} />} loading={startingSession} onClick={onStartSession}>
                        Start new session
                    </Button>
                }
            >
                <SessionList
                    sessions={sessions}
                    loading={sessionsLoading}
                    onOpen={onOpenSession}
                    onStart={onStartSession}
                    starting={startingSession}
                    limit={5}
                />
                {sessions.length > 5 ? (
                    <Group justify="flex-end" mt="sm">
                        <Button size="xs" variant="subtle" onClick={() => onGoToTab('sessions')}>
                            View all {sessions.length} sessions
                        </Button>
                    </Group>
                ) : null}
            </SectionCard>
        </Stack>
    );
}
