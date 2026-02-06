'use client';

import { useCallback, useEffect, useMemo, useState, use as usePromise } from 'react';
import {
    Stack,
    Group,
    Text,
    Button,
    Card,
    SimpleGrid,
    Badge,
    Loader,
    Center,
    Alert,
    Paper,
    ScrollArea,
    Code,
    Grid,
    CopyButton,
    ActionIcon,
    Tooltip,
    ThemeIcon,
    Title,
} from '@mantine/core';
import { IconBook, IconInfoCircle, IconCopy, IconRefresh, IconTimeline } from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
    formatDuration,
    formatNumber,
    formatRelativeTime,
    resolveStatusColor,
    humanize,
    formatToolName,
} from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

const formatActor = (actor: unknown): string => {
    if (!actor) return '';
    if (typeof actor === 'string') {
        // Format snake_case to Title Case
        if (actor.includes('_')) {
            return actor
                .toLowerCase()
                .split('_')
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');
        }
        return actor;
    }
    if (typeof actor === 'object') {
        const record = actor as Record<string, unknown>;

        // Check for empty object
        if (Object.keys(record).length === 0) return '';

        const parts = [record.scope, record.name, record.role, record.version]
            .map((value) => {
                if (typeof value === 'string' && value.trim() !== '') {
                    // Format snake_case values
                    if (value.includes('_')) {
                        return value
                            .toLowerCase()
                            .split('_')
                            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                            .join(' ');
                    }
                    return value;
                }
                return null;
            })
            .filter((value): value is string => value !== null);

        if (parts.length > 0) {
            return parts.join(' · ');
        }

        // Don't show JSON for empty-ish objects
        return '';
    }

    return String(actor);
};

const formatSectionContent = (content: unknown): string => {
    if (content === null || content === undefined) {
        return '';
    }

    if (typeof content === 'string') {
        return content;
    }

    try {
        return JSON.stringify(content, null, 2);
    } catch {
        return String(content);
    }
};

type SectionEntry = {
    [key: string]: unknown;
    title?: string;
    label?: string;
    kind?: string;
    id?: string;
    role?: string;
    tool?: string;
    contentType?: string;
    truncated?: boolean;
    content?: unknown;
};

interface SessionDetailResponse {
    session: {
        sessionId: string;
        agentName?: string;
        agentVersion?: string;
        status?: string;
        startedAt?: string;
        endedAt?: string;
        durationMs?: number;
        totalEvents?: number;
        totalInputTokens?: number;
        totalOutputTokens?: number;
        totalCachedInputTokens?: number;
        summary?: {
            totalInputTokens?: number;
            totalOutputTokens?: number;
            totalCachedInputTokens?: number;
        };
        modelsUsed?: string[];
        toolsUsed?: string[];
        errors?: Array<{ message: string; timestamp?: string }>;
    };
    events: Array<{
        id: string;
        sequence?: number;
        type?: string;
        label?: string;
        status?: string;
        timestamp?: string;
        actor?: unknown;
        metadata?: Record<string, unknown>;
        sections?: SectionEntry[];
        model?: string;
        error?: { message?: string } | null;
        durationMs?: number;
        toolName?: string;
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
    }>;
}

type TracingEvent = SessionDetailResponse['events'][number];

dayjs.extend(relativeTime);

const SECTION_HEADER_PROPS = [
    'label',
    'title',
    'kind',
    'id',
    'role',
    'tool',
    'contentType',
    'truncated',
    'metadata',
];

const shouldDisplaySectionField = (value: unknown): boolean => {
    if (value === null || value === undefined) {
        return false;
    }

    if (typeof value === 'string') {
        return value.trim().length > 0;
    }

    if (Array.isArray(value)) {
        return value.length > 0;
    }

    if (typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>).length > 0;
    }

    return true;
};

const renderSectionFieldValue = (value: unknown) => {
    if (typeof value === 'object' && value !== null) {
        return <Code block>{formatSectionContent(value)}</Code>;
    }

    const formatted = formatSectionContent(value);

    if (formatted.length > 160 || formatted.includes('\n')) {
        return <Code block>{formatted}</Code>;
    }

    return <Text size="sm">{formatted}</Text>;
};

const SectionCard = ({ section, index }: { section: SectionEntry; index: number }) => {
    const kind = typeof section.kind === 'string' ? section.kind : undefined;
    const role = typeof section.role === 'string' ? section.role : undefined;
    const tool = typeof section.tool === 'string' ? section.tool : undefined;
    const truncated = Boolean(section.truncated);
    const identifier = typeof section.id === 'string' ? section.id : undefined;
    const contentType = typeof section.contentType === 'string' ? section.contentType : undefined;

    const headerLabel =
        (typeof section.label === 'string' && section.label.trim().length > 0 && section.label) ||
        (typeof section.title === 'string' && section.title.trim().length > 0 && section.title) ||
        (kind ? humanize(kind) : `Section ${index + 1}`);

    const badges: Array<{ key: string; label: string }> = [];

    if (kind) {
        badges.push({ key: 'kind', label: humanize(kind) });
    }

    if (role) {
        badges.push({ key: 'role', label: humanize(role) });
    }

    if (tool) {
        badges.push({ key: 'tool', label: tool });
    }

    if (truncated) {
        badges.push({ key: 'truncated', label: 'Truncated' });
    }

    const copyValue = formatSectionContent(section.content ?? section.data ?? section);

    return (
        <Card withBorder shadow="xs" radius="md" p="md">
            <Stack gap={10}>
                <Group justify="space-between" align="flex-start">
                    <Stack gap={2}>
                        <Text fw={600} size="sm">
                            {headerLabel}
                        </Text>
                        {(identifier || contentType) && (
                            <Text size="xs" c="dimmed">
                                {identifier}
                                {identifier && contentType ? ' · ' : ''}
                                {contentType}
                            </Text>
                        )}
                    </Stack>
                    <Group gap="xs">
                        {badges.map((badge) => (
                            <Badge key={badge.key} size="xs" variant="light" color="gray">
                                {badge.label}
                            </Badge>
                        ))}
                        {copyValue && copyValue.length > 0 ? (
                            <CopyButton value={copyValue} timeout={1500}>
                                {({ copied, copy }) => (
                                    <Tooltip label={copied ? 'Copied' : 'Copy section'} withArrow>
                                        <ActionIcon
                                            variant="subtle"
                                            color={copied ? 'green' : 'blue'}
                                            aria-label="Copy section content"
                                            onClick={copy}
                                        >
                                            <IconCopy size={16} />
                                        </ActionIcon>
                                    </Tooltip>
                                )}
                            </CopyButton>
                        ) : null}
                    </Group>
                </Group>

                <Stack gap="sm">
                    {Object.entries(section)
                        .filter(([key]) => !SECTION_HEADER_PROPS.includes(key))
                        .filter(([, value]) => shouldDisplaySectionField(value))
                        .map(([key, value]) => (
                            <Stack key={key} gap={4}>
                                <Text size="xs" c="dimmed">
                                    {humanize(key)}
                                </Text>
                                {renderSectionFieldValue(value)}
                            </Stack>
                        ))}
                </Stack>
            </Stack>
        </Card>
    );
};

export default function SessionDetailPage({ params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = usePromise(params);
    const { openDocs } = useDocsDrawer();

    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [detail, setDetail] = useState<SessionDetailResponse | null>(null);

    const fetchDetail = useCallback(async (isRefresh = false) => {
        try {
            if (isRefresh) {
                setRefreshing(true);
            } else {
                setLoading(true);
            }
            setError(null);

            const response = await fetch(`/api/tracing/sessions/${sessionId}`);

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to fetch session detail');
            }

            const data: SessionDetailResponse = await response.json();
            setDetail(data);
        } catch (error) {
            console.error('Failed to load session detail:', error);
            setError(error instanceof Error ? error.message : 'Unable to load session');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [sessionId]);

    useEffect(() => {
        void fetchDetail(false);
    }, [fetchDetail]);

    const tokenStats = useMemo(() => {
        const summary = detail?.session?.summary;

        const input = summary?.totalInputTokens ?? detail?.session?.totalInputTokens ?? 0;
        const output = summary?.totalOutputTokens ?? detail?.session?.totalOutputTokens ?? 0;
        const cached = summary?.totalCachedInputTokens ?? detail?.session?.totalCachedInputTokens ?? 0;

        return {
            input,
            output,
            cached,
        };
    }, [detail]);

    const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

    const sortedEvents = useMemo(() => {
        if (!detail?.events) return [] as SessionDetailResponse['events'];
        return [...detail.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    }, [detail]);

    useEffect(() => {
        if (sortedEvents.length === 0) {
            if (selectedEventId !== null) {
                setSelectedEventId(null);
            }
            return;
        }

        const hasSelection = selectedEventId
            ? sortedEvents.some((event) => event.id === selectedEventId)
            : false;

        if (!hasSelection) {
            setSelectedEventId(sortedEvents[0].id);
        }
    }, [sortedEvents, selectedEventId]);

    const selectedEvent = useMemo(() => {
        if (!selectedEventId) return null;
        return sortedEvents.find((event) => event.id === selectedEventId) ?? null;
    }, [sortedEvents, selectedEventId]);

    const eventTokenStats = useMemo(() => {
        if (!selectedEvent) {
            return {
                isAiCall: false,
                hasData: false,
                input: null as number | null,
                output: null as number | null,
                cached: null as number | null,
            };
        }

        const input = typeof selectedEvent.inputTokens === 'number' ? selectedEvent.inputTokens : null;
        const output = typeof selectedEvent.outputTokens === 'number' ? selectedEvent.outputTokens : null;
        const cached = typeof selectedEvent.cachedInputTokens === 'number' ? selectedEvent.cachedInputTokens : null;
        const hasData = [input, output, cached].some((value) => value !== null);

        return {
            isAiCall: selectedEvent.type === 'ai_call',
            hasData,
            input,
            output,
            cached,
        };
    }, [selectedEvent]);

    if (loading) {
        return (
            <Center h={320}>
                <Loader />
            </Center>
        );
    }

    if (error) {
        return (
            <Alert icon={<IconInfoCircle size={16} />} color="red" title="Failed to load session" variant="light">
                {error}
            </Alert>
        );
    }

    if (!detail) {
        return (
            <Center h={320}>
                <Text c="dimmed">Session not found.</Text>
            </Center>
        );
    }

    const { session } = detail;

    return (
        <Stack gap="md">
            <PageHeader
                icon={<IconTimeline size={18} />}
                title={`Session ${session.sessionId.substring(0, 12)}...`}
                subtitle={`Agent ${session.agentName || 'Unknown'} · Version ${session.agentVersion || '—'} · Started ${formatRelativeTime(session.startedAt)}`}
                actions={
                    <>
                        <Badge size="sm" variant="filled" radius="xl" color={resolveStatusColor(session.status)}>
                            {(session.status || 'unknown').toUpperCase()}
                        </Badge>
                        <Button
                            onClick={() => openDocs('api-tracing')}
                            variant="light"
                            size="xs"
                            leftSection={<IconBook size={14} />}
                        >
                            Docs
                        </Button>
                        <Button
                            leftSection={<IconRefresh size={14} />}
                            variant="light"
                            size="xs"
                            onClick={() => void fetchDetail(true)}
                            loading={refreshing}
                        >
                            Refresh
                        </Button>
                    </>
                }
            />
            <Grid gutter="md" style={{ minHeight: 'calc(100vh - 320px)' }}>
                <Grid.Col span={{ base: 12, xl: 3 }}>
                    <Stack gap="md">
                        <Card withBorder p="md">
                            <Text fw={600} mb="sm">
                                Session details
                            </Text>
                            <Stack gap={6}>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">
                                        Session ID
                                    </Text>
                                    <Code>{session.sessionId}</Code>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">
                                        Started
                                    </Text>
                                    <Text size="sm">
                                        {session.startedAt ? dayjs(session.startedAt).format('MMM D, YYYY HH:mm:ss') : '—'}
                                    </Text>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">
                                        Ended
                                    </Text>
                                    <Text size="sm">
                                        {session.endedAt ? dayjs(session.endedAt).format('MMM D, YYYY HH:mm:ss') : '—'}
                                    </Text>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">
                                        Agent
                                    </Text>
                                    <Text size="sm">{session.agentName || '—'}</Text>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">
                                        Version
                                    </Text>
                                    <Text size="sm">{session.agentVersion || '—'}</Text>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">
                                        Duration
                                    </Text>
                                    <Text size="sm">{formatDuration(session.durationMs)}</Text>
                                </Group>
                                <Group justify="space-between">
                                    <Text size="sm" c="dimmed">
                                        Events
                                    </Text>
                                    <Text size="sm">{formatNumber(session.totalEvents)}</Text>
                                </Group>
                                {session.modelsUsed && session.modelsUsed.length > 0 && (
                                    <Stack gap={2}>
                                        <Text size="sm" c="dimmed">
                                            Models used
                                        </Text>
                                        <Text size="sm">{session.modelsUsed.join(', ')}</Text>
                                    </Stack>
                                )}
                            </Stack>
                        </Card>
                        <Stack>
                            <Card withBorder p="md">
                                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                                    Input
                                </Text>
                                <Text size="lg" fw={700} mt={4}>
                                    {formatNumber(tokenStats.input)}
                                </Text>
                            </Card>
                            <Card withBorder p="md">
                                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                                    Output
                                </Text>
                                <Text size="lg" fw={700} mt={4}>
                                    {formatNumber(tokenStats.output)}
                                </Text>
                            </Card>
                            <Card withBorder p="md">
                                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                                    Cache
                                </Text>
                                <Text size="lg" fw={700} mt={4}>
                                    {formatNumber(tokenStats.cached)}
                                </Text>
                            </Card>
                        </Stack>
                    </Stack>
                </Grid.Col>

                <Grid.Col span={{ base: 12, xl: 4 }}>
                    <Card withBorder p="md" h="100%">
                        <Stack gap="md" h="100%">
                            <Stack gap={2}>
                                <Text fw={600}>Events</Text>
                                <Text size="sm" c="dimmed">
                                    {sortedEvents.length} events captured
                                </Text>
                            </Stack>
                            {sortedEvents.length === 0 ? (
                                <Center h={200}>
                                    <Text c="dimmed">No events recorded for this session.</Text>
                                </Center>
                            ) : (
                                <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
                                    <Stack gap="sm">
                                        {sortedEvents.map((event: TracingEvent) => {
                                            const isSelected = event.id === selectedEventId;
                                            return (
                                                <Paper
                                                    key={event.id}
                                                    withBorder
                                                    radius="md"
                                                    p="sm"
                                                    onClick={() => setSelectedEventId(event.id)}
                                                    style={{
                                                        cursor: 'pointer',
                                                        borderColor: isSelected ? 'var(--mantine-color-blue-5)' : undefined,
                                                        backgroundColor: isSelected ? 'var(--mantine-color-blue-0)' : undefined,
                                                    }}
                                                >
                                                    <Stack gap={6}>
                                                        <Group justify="space-between" align="flex-start">
                                                            <Stack gap={2} style={{ flex: 1 }}>
                                                                <Text size="sm" fw={600} lineClamp={1}>
                                                                    {event.label ? humanize(event.label) : humanize(event.type) || 'Event'}
                                                                </Text>
                                                                <Text size="xs" c="dimmed">
                                                                    #{event.sequence ?? '—'} · {event.timestamp ? dayjs(event.timestamp).format('MMM D, YYYY HH:mm:ss') : '—'}
                                                                </Text>
                                                            </Stack>
                                                            {event.status && (
                                                                <Badge size="xs" variant="light" radius="xl" color={resolveStatusColor(event.status)}>
                                                                    {event.status.toUpperCase()}
                                                                </Badge>
                                                            )}
                                                        </Group>
                                                        <Group gap="xs">
                                                            {event.toolName && (
                                                                <Badge size="xs" variant="light" color="violet">
                                                                    {formatToolName(event.toolName)}
                                                                </Badge>
                                                            )}
                                                            {(event.inputTokens || event.outputTokens) && (
                                                                <Badge size="xs" variant="light" color="gray">
                                                                    {formatNumber((event.inputTokens || 0) + (event.outputTokens || 0))} tokens
                                                                </Badge>
                                                            )}
                                                        </Group>
                                                        {(formatRelativeTime(event.timestamp) !== '—' || formatActor(event.actor)) && (
                                                            <Text size="xs" c="dimmed">
                                                                {formatRelativeTime(event.timestamp)}{formatActor(event.actor) ? ` · ${formatActor(event.actor)}` : ''}
                                                            </Text>
                                                        )}
                                                    </Stack>
                                                </Paper>
                                            );
                                        })}
                                    </Stack>
                                </ScrollArea>
                            )}
                        </Stack>
                    </Card>
                </Grid.Col>

                <Grid.Col span={{ base: 12, xl: 5 }}>
                    <Card withBorder p="md" h="100%">
                        <Stack gap="md" h="100%">
                            <Text fw={600}>Event detail</Text>
                            {selectedEvent ? (
                                <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
                                    <Stack gap="md">
                                        <Stack gap={4}>
                                            <Text size="lg" fw={600}>
                                                {selectedEvent.label ? humanize(selectedEvent.label) : humanize(selectedEvent.type) || 'Event'}
                                            </Text>
                                            <Group gap="xs">
                                                {selectedEvent.status && (
                                                    <Badge size="sm" variant="light" radius="xl" color={resolveStatusColor(selectedEvent.status)}>
                                                        {selectedEvent.status.toUpperCase()}
                                                    </Badge>
                                                )}
                                                <Text size="xs" c="dimmed">#{selectedEvent.sequence ?? '—'}</Text>
                                            </Group>
                                            <Text size="sm" c="dimmed">
                                                {selectedEvent.timestamp ? dayjs(selectedEvent.timestamp).format('MMM D, YYYY HH:mm:ss') : '—'} · {formatRelativeTime(selectedEvent.timestamp)}
                                            </Text>
                                            {formatActor(selectedEvent.actor) && (
                                                <Text size="sm" c="dimmed">
                                                    Actor: {formatActor(selectedEvent.actor)}
                                                </Text>
                                            )}
                                        </Stack>

                                        <Stack gap={6}>
                                            {selectedEvent.toolName && (
                                                <Group gap="xs">
                                                    <Text size="sm" c="dimmed">Tool:</Text>
                                                    <Badge size="sm" variant="light" color="violet">
                                                        {formatToolName(selectedEvent.toolName)}
                                                    </Badge>
                                                </Group>
                                            )}
                                            {selectedEvent.model && (
                                                <Group gap="xs">
                                                    <Text size="sm" c="dimmed">Model:</Text>
                                                    <Badge size="sm" variant="light" color="cyan">{selectedEvent.model}</Badge>
                                                </Group>
                                            )}
                                            {selectedEvent.durationMs !== undefined && (
                                                <Group gap="xs">
                                                    <Text size="sm" c="dimmed">Duration:</Text>
                                                    <Text size="sm" fw={500}>{formatDuration(selectedEvent.durationMs)}</Text>
                                                </Group>
                                            )}
                                            {eventTokenStats.isAiCall && eventTokenStats.hasData ? (
                                                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
                                                    <Card withBorder p="sm">
                                                        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                                                            Input
                                                        </Text>
                                                        <Text size="md" fw={600} mt={4}>
                                                            {typeof eventTokenStats.input === 'number'
                                                                ? formatNumber(eventTokenStats.input)
                                                                : '—'}
                                                        </Text>
                                                    </Card>
                                                    <Card withBorder p="sm">
                                                        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                                                            Output
                                                        </Text>
                                                        <Text size="md" fw={600} mt={4}>
                                                            {typeof eventTokenStats.output === 'number'
                                                                ? formatNumber(eventTokenStats.output)
                                                                : '—'}
                                                        </Text>
                                                    </Card>
                                                    <Card withBorder p="sm">
                                                        <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                                                            Cache
                                                        </Text>
                                                        <Text size="md" fw={600} mt={4}>
                                                            {typeof eventTokenStats.cached === 'number'
                                                                ? formatNumber(eventTokenStats.cached)
                                                                : '—'}
                                                        </Text>
                                                    </Card>
                                                </SimpleGrid>
                                            ) : (selectedEvent.inputTokens || selectedEvent.outputTokens) ? (
                                                <Group gap="xs">
                                                    {selectedEvent.inputTokens ? (
                                                        <Badge size="xs" variant="light" color="blue">
                                                            {formatNumber(selectedEvent.inputTokens)} in
                                                        </Badge>
                                                    ) : null}
                                                    {selectedEvent.outputTokens ? (
                                                        <Badge size="xs" variant="light" color="indigo">
                                                            {formatNumber(selectedEvent.outputTokens)} out
                                                        </Badge>
                                                    ) : null}
                                                </Group>
                                            ) : null}
                                            {selectedEvent.error?.message && (
                                                <Alert icon={<IconInfoCircle size={14} />} color="red" variant="light">
                                                    {selectedEvent.error.message}
                                                </Alert>
                                            )}
                                        </Stack>

                                        {selectedEvent.metadata && Object.keys(selectedEvent.metadata).length > 0 && (
                                            <Stack gap={6}>
                                                <Text size="sm" fw={600}>
                                                    Metadata
                                                </Text>
                                                <Paper withBorder p="sm">
                                                    <Code block>{JSON.stringify(selectedEvent.metadata, null, 2)}</Code>
                                                </Paper>
                                            </Stack>
                                        )}

                                        <Stack gap="sm">
                                            <Text size="sm" fw={600}>
                                                Sections
                                            </Text>
                                            {selectedEvent.sections && selectedEvent.sections.length > 0 ? (
                                                <Stack gap="sm">
                                                    {selectedEvent.sections.map((section, index) => {
                                                        const key =
                                                            (typeof section.id === 'string' && section.id.length > 0 && `id-${section.id}`) ||
                                                            (typeof section.label === 'string' && section.label.length > 0 && `label-${section.label}-${index}`) ||
                                                            (typeof section.title === 'string' && section.title.length > 0 && `title-${section.title}-${index}`) ||
                                                            `section-${index}`;

                                                        return <SectionCard key={key} section={section} index={index} />;
                                                    })}
                                                </Stack>
                                            ) : (
                                                <Text size="sm" c="dimmed">
                                                    No structured sections for this event.
                                                </Text>
                                            )}
                                        </Stack>
                                    </Stack>
                                </ScrollArea>
                            ) : (
                                <Center h={200}>
                                    <Text c="dimmed">Select an event to see details.</Text>
                                </Center>
                            )}
                        </Stack>
                    </Card>
                </Grid.Col>
            </Grid>
        </Stack>
    );
}
