'use client';

import { useCallback, useEffect, useMemo, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
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
    Tabs,
    Box,
} from '@mantine/core';
import {
    IconArrowLeft,
    IconBook,
    IconInfoCircle,
    IconCopy,
    IconRefresh,
    IconTimeline,
    IconChevronDown,
    IconChevronRight,
    IconBrandOpenSource,
    IconCode,
    IconActivity,
    IconBinaryTree,
} from '@tabler/icons-react';
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
import JsonTreeViewer from '@/components/common/JsonTreeViewer';

dayjs.extend(relativeTime);

// ─── Type helpers ──────────────────────────────────────────────

const formatActor = (actor: unknown): string => {
    if (!actor) return '';
    if (typeof actor === 'string') {
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
        if (Object.keys(record).length === 0) return '';
        const parts = [record.scope, record.name, record.role, record.version]
            .map((value) => {
                if (typeof value === 'string' && value.trim() !== '') {
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
        if (parts.length > 0) return parts.join(' · ');
        return '';
    }
    return String(actor);
};

const formatSectionContent = (content: unknown): string => {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
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
        threadId?: string;
        traceId?: string;
        rootSpanId?: string;
        source?: 'custom' | 'otlp';
        agentName?: string;
        agentVersion?: string;
        agentModel?: string;
        status?: string;
        startedAt?: string;
        endedAt?: string;
        durationMs?: number;
        totalEvents?: number;
        totalInputTokens?: number;
        totalOutputTokens?: number;
        totalCachedInputTokens?: number;
        totalBytesIn?: number;
        totalBytesOut?: number;
        summary?: {
            totalInputTokens?: number;
            totalOutputTokens?: number;
            totalCachedInputTokens?: number;
        };
        modelsUsed?: string[];
        toolsUsed?: string[];
        eventCounts?: Record<string, number>;
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
        toolExecutionId?: string;
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        requestBytes?: number;
        responseBytes?: number;
        traceId?: string;
        spanId?: string;
        parentSpanId?: string;
        actorName?: string;
        actorRole?: string;
    }>;
}

interface EventDetailResponse {
    event: SessionDetailResponse['events'][number];
}

type TracingEvent = SessionDetailResponse['events'][number];

// ─── Event type → color mapping ────────────────────────────────

function eventTypeColor(type?: string): string {
    if (!type) return 'gray';
    const t = type.toLowerCase();
    if (t === 'ai_call' || t.includes('llm') || t.includes('chat') || t.includes('completion')) return 'blue';
    if (t === 'tool_call' || t.includes('tool') || t.includes('function')) return 'violet';
    if (t === 'agent_iteration') return 'teal';
    if (t === 'embedding' || t.includes('embed')) return 'cyan';
    if (t === 'retrieval' || t.includes('retriev') || t.includes('search')) return 'orange';
    if (t === 'summarization') return 'green';
    if (t === 'error') return 'red';
    return 'gray';
}

function sourceBadge(source?: string) {
    if (source === 'otlp') {
        return (
            <Badge size="xs" variant="light" color="grape" leftSection={<IconBrandOpenSource size={10} />}>
                OpenTelemetry
            </Badge>
        );
    }
    return (
        <Badge size="xs" variant="light" color="blue">
            Custom
        </Badge>
    );
}

// ─── Section rendering ─────────────────────────────────────────

const SECTION_HEADER_PROPS = [
    'label', 'title', 'kind', 'id', 'role', 'tool', 'contentType', 'truncated', 'metadata',
];

const shouldDisplaySectionField = (value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
    return true;
};

const renderFieldValue = (value: unknown) => {
    if (typeof value === 'object' && value !== null) {
        return <JsonTreeViewer data={value} initialExpandLevel={2} />;
    }
    const formatted = formatSectionContent(value);
    if (formatted.length > 300 || formatted.includes('\n')) {
        // Try parsing stringified JSON
        try {
            const parsed = JSON.parse(formatted);
            if (typeof parsed === 'object' && parsed !== null) {
                return <JsonTreeViewer data={parsed} initialExpandLevel={2} />;
            }
        } catch { /* not JSON, fall through */ }
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

    const badges: Array<{ key: string; label: string; color: string }> = [];
    if (kind) badges.push({
        key: 'kind',
        label: humanize(kind),
        color: kind === 'message' ? 'blue' : kind === 'tool_call' ? 'violet' : kind === 'tool_result' ? 'green' : 'gray',
    });
    if (role) badges.push({
        key: 'role',
        label: humanize(role),
        color: role === 'user' ? 'cyan' : role === 'assistant' ? 'blue' : role === 'system' ? 'orange' : 'gray',
    });
    if (tool) badges.push({ key: 'tool', label: tool, color: 'violet' });
    if (truncated) badges.push({ key: 'truncated', label: 'Truncated', color: 'yellow' });

    const copyValue = formatSectionContent(section.content ?? section);

    return (
        <Card withBorder shadow="xs" radius="md" p="md">
            <Stack gap={10}>
                <Group justify="space-between" align="flex-start">
                    <Stack gap={2}>
                        <Text fw={600} size="sm">{headerLabel}</Text>
                        {(identifier || contentType) && (
                            <Text size="xs" c="dimmed">
                                {identifier}{identifier && contentType ? ' · ' : ''}{contentType}
                            </Text>
                        )}
                    </Stack>
                    <Group gap="xs">
                        {badges.map((badge) => (
                            <Badge key={badge.key} size="xs" variant="light" color={badge.color}>
                                {badge.label}
                            </Badge>
                        ))}
                        {copyValue && copyValue.length > 0 ? (
                            <CopyButton value={copyValue} timeout={1500}>
                                {({ copied, copy }) => (
                                    <Tooltip label={copied ? 'Copied' : 'Copy section'} withArrow>
                                        <ActionIcon variant="subtle" color={copied ? 'green' : 'blue'} onClick={copy}>
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
                                <Text size="xs" c="dimmed">{humanize(key)}</Text>
                                {renderFieldValue(value)}
                            </Stack>
                        ))}
                </Stack>
            </Stack>
        </Card>
    );
};

// ─── Key-value row ─────────────────────────────────────────────

function KVRow({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
    return (
        <Group justify="space-between" wrap="nowrap">
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{label}</Text>
            {mono ? (
                <Code style={{ fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</Code>
            ) : (
                <Text size="sm" ta="right" style={{ wordBreak: 'break-all' }}>{children}</Text>
            )}
        </Group>
    );
}

// ─── Span hierarchy tree ───────────────────────────────────────

interface SpanTreeNode { event: TracingEvent; children: SpanTreeNode[] }

function buildSpanTree(events: TracingEvent[]): SpanTreeNode[] {
    const map = new Map<string, SpanTreeNode>();
    const roots: SpanTreeNode[] = [];

    for (const event of events) {
        const key = event.spanId || event.id;
        map.set(key, { event, children: [] });
    }

    for (const event of events) {
        const key = event.spanId || event.id;
        const node = map.get(key)!;
        const parentKey = event.parentSpanId;
        if (parentKey && map.has(parentKey)) {
            map.get(parentKey)!.children.push(node);
        } else {
            roots.push(node);
        }
    }

    return roots;
}

function SpanTreeItem({
    node,
    depth,
    selectedEventId,
    onSelect,
}: {
    node: SpanTreeNode;
    depth: number;
    selectedEventId: string | null;
    onSelect: (id: string) => void;
}) {
    const [expanded, setExpanded] = useState(true);
    const event = node.event;
    const isSelected = event.id === selectedEventId;
    const hasChildren = node.children.length > 0;

    return (
        <Box>
            <Paper
                withBorder
                radius="md"
                p="xs"
                onClick={() => onSelect(event.id)}
                style={{
                    cursor: 'pointer',
                    marginLeft: depth * 16,
                    borderColor: isSelected ? 'var(--mantine-color-blue-4)' : undefined,
                    backgroundColor: isSelected ? 'var(--mantine-color-blue-0)' : undefined,
                }}
            >
                <Group gap={6} wrap="nowrap">
                    {hasChildren ? (
                        <ActionIcon
                            variant="subtle"
                            size="xs"
                            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                        >
                            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                        </ActionIcon>
                    ) : (
                        <Box w={22} />
                    )}
                    <Badge size="xs" variant="light" color={eventTypeColor(event.type)} style={{ flexShrink: 0 }}>
                        {humanize(event.type) || 'Span'}
                    </Badge>
                    <Text size="xs" fw={500} lineClamp={1} style={{ flex: 1 }}>
                        {event.label ? humanize(event.label) : humanize(event.type) || 'Event'}
                    </Text>
                    {event.status && (
                        <Badge size="xs" variant="dot" color={resolveStatusColor(event.status)} style={{ flexShrink: 0 }}>
                            {event.status}
                        </Badge>
                    )}
                    {event.durationMs != null && (
                        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{formatDuration(event.durationMs)}</Text>
                    )}
                </Group>
            </Paper>
            {hasChildren && expanded && (
                <Stack gap={4} mt={4}>
                    {node.children.map((child) => (
                        <SpanTreeItem
                            key={child.event.spanId || child.event.id}
                            node={child}
                            depth={depth + 1}
                            selectedEventId={selectedEventId}
                            onSelect={onSelect}
                        />
                    ))}
                </Stack>
            )}
        </Box>
    );
}

// ─── Dynamic event info rows ───────────────────────────────────

function EventInfoRows({ event }: { event: TracingEvent }) {
    const rows: Array<{ key: string; label: string; value: React.ReactNode }> = [];

    if (event.type) {
        rows.push({
            key: 'type',
            label: 'Type',
            value: <Badge size="sm" variant="light" color={eventTypeColor(event.type)}>{humanize(event.type)}</Badge>,
        });
    }
    if (event.model) {
        rows.push({
            key: 'model',
            label: 'Model',
            value: <Badge size="sm" variant="light" color="cyan">{event.model}</Badge>,
        });
    }
    if (event.toolName) {
        rows.push({
            key: 'tool',
            label: 'Tool',
            value: <Badge size="sm" variant="light" color="violet">{formatToolName(event.toolName)}</Badge>,
        });
    }
    if (event.toolExecutionId) {
        rows.push({
            key: 'toolExecId',
            label: 'Tool Exec ID',
            value: <Code style={{ fontSize: 11 }}>{event.toolExecutionId}</Code>,
        });
    }
    if (event.durationMs != null) {
        rows.push({
            key: 'duration',
            label: 'Duration',
            value: <Text size="sm" fw={500}>{formatDuration(event.durationMs)}</Text>,
        });
    }
    if (formatActor(event.actor)) {
        rows.push({
            key: 'actor',
            label: 'Actor',
            value: <Text size="sm">{formatActor(event.actor)}</Text>,
        });
    }
    if (event.actorName && !formatActor(event.actor).includes(event.actorName)) {
        rows.push({
            key: 'actorName',
            label: 'Actor Name',
            value: <Text size="sm">{event.actorName}</Text>,
        });
    }

    return (
        <Stack gap={6}>
            {rows.map(({ key, label, value }) => (
                <Group key={key} gap="xs" wrap="nowrap">
                    <Text size="sm" c="dimmed" style={{ minWidth: 80 }}>{label}</Text>
                    {value}
                </Group>
            ))}
        </Stack>
    );
}

// ─── Token / bytes stats ───────────────────────────────────────

function EventTokenStats({ event }: { event: TracingEvent }) {
    const hasTokens = event.inputTokens != null || event.outputTokens != null || event.cachedInputTokens != null;
    const hasBytes = event.requestBytes != null || event.responseBytes != null;
    if (!hasTokens && !hasBytes) return null;

    const items: Array<{ label: string; value: number }> = [];
    if (event.inputTokens != null) items.push({ label: 'Input', value: event.inputTokens });
    if (event.outputTokens != null) items.push({ label: 'Output', value: event.outputTokens });
    if (event.cachedInputTokens != null && event.cachedInputTokens > 0) items.push({ label: 'Cached', value: event.cachedInputTokens });
    if (event.totalTokens != null) items.push({ label: 'Total', value: event.totalTokens });
    if (event.requestBytes != null) items.push({ label: 'Req Bytes', value: event.requestBytes });
    if (event.responseBytes != null) items.push({ label: 'Res Bytes', value: event.responseBytes });

    return (
        <SimpleGrid cols={{ base: 2, sm: Math.min(items.length, 4) }} spacing="sm">
            {items.map((item) => (
                <Card key={item.label} withBorder p="sm">
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{item.label}</Text>
                    <Text size="md" fw={600} mt={2}>{formatNumber(item.value)}</Text>
                </Card>
            ))}
        </SimpleGrid>
    );
}

// ─── Span identity block ──────────────────────────────────────

function SpanIdentityBlock({ event }: { event: TracingEvent }) {
    const hasIds = event.traceId || event.spanId || event.parentSpanId;
    if (!hasIds) return null;

    return (
        <Paper withBorder p="xs" radius="md">
            <Group gap={4} mb={4}>
                <ThemeIcon size="xs" variant="light" color="grape"><IconBinaryTree size={10} /></ThemeIcon>
                <Text size="xs" fw={600} c="dimmed">Span Identity</Text>
            </Group>
            <Stack gap={2}>
                {event.traceId && (
                    <Group gap="xs" wrap="nowrap">
                        <Text size="xs" c="dimmed" style={{ minWidth: 70 }}>Trace ID</Text>
                        <CopyButton value={event.traceId} timeout={1500}>
                            {({ copied, copy }) => (
                                <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                                    <Code style={{ fontSize: 10, cursor: 'pointer' }} onClick={copy}>
                                        {event.traceId}
                                    </Code>
                                </Tooltip>
                            )}
                        </CopyButton>
                    </Group>
                )}
                {event.spanId && (
                    <Group gap="xs" wrap="nowrap">
                        <Text size="xs" c="dimmed" style={{ minWidth: 70 }}>Span ID</Text>
                        <CopyButton value={event.spanId} timeout={1500}>
                            {({ copied, copy }) => (
                                <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                                    <Code style={{ fontSize: 10, cursor: 'pointer' }} onClick={copy}>
                                        {event.spanId}
                                    </Code>
                                </Tooltip>
                            )}
                        </CopyButton>
                    </Group>
                )}
                {event.parentSpanId && (
                    <Group gap="xs" wrap="nowrap">
                        <Text size="xs" c="dimmed" style={{ minWidth: 70 }}>Parent ID</Text>
                        <CopyButton value={event.parentSpanId} timeout={1500}>
                            {({ copied, copy }) => (
                                <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                                    <Code style={{ fontSize: 10, cursor: 'pointer' }} onClick={copy}>
                                        {event.parentSpanId}
                                    </Code>
                                </Tooltip>
                            )}
                        </CopyButton>
                    </Group>
                )}
            </Stack>
        </Paper>
    );
}

// ─── Raw JSON view ─────────────────────────────────────────────

function RawJsonView({ event }: { event: TracingEvent }) {
    const json = useMemo(() => {
        try { return JSON.stringify(event, null, 2); }
        catch { return '{}'; }
    }, [event]);

    return (
        <Stack gap="xs">
            <Group justify="space-between">
                <Text size="sm" fw={600}>Raw Event JSON</Text>
                <CopyButton value={json} timeout={1500}>
                    {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy JSON'} withArrow>
                            <ActionIcon variant="subtle" size="sm" color={copied ? 'green' : 'blue'} onClick={copy}>
                                <IconCopy size={14} />
                            </ActionIcon>
                        </Tooltip>
                    )}
                </CopyButton>
            </Group>
            <ScrollArea.Autosize mah={500}>
                <JsonTreeViewer data={event} initialExpandLevel={2} bordered={false} />
            </ScrollArea.Autosize>
        </Stack>
    );
}

// ─── Event detail panel ────────────────────────────────────────

function EventDetailPanel({ event }: { event: TracingEvent }) {
    const hasSections = event.sections && event.sections.length > 0;
    const hasMetadata = event.metadata && Object.keys(event.metadata).length > 0;

    return (
        <Stack gap="md">
            {/* Header */}
            <Stack gap={4}>
                <Group gap="xs" wrap="nowrap">
                    <Text size="lg" fw={600}>
                        {event.label ? humanize(event.label) : humanize(event.type) || 'Event'}
                    </Text>
                    {event.status && (
                        <Badge size="sm" variant="light" radius="xl" color={resolveStatusColor(event.status)}>
                            {event.status.toUpperCase()}
                        </Badge>
                    )}
                </Group>
                <Text size="sm" c="dimmed">
                    #{event.sequence ?? '—'} · {event.timestamp ? dayjs(event.timestamp).format('MMM D, YYYY HH:mm:ss') : '—'} · {formatRelativeTime(event.timestamp)}
                </Text>
            </Stack>

            {/* Info rows */}
            <EventInfoRows event={event} />

            {/* Token/byte stats */}
            <EventTokenStats event={event} />

            {/* Error */}
            {event.error?.message && (
                <Alert icon={<IconInfoCircle size={14} />} color="red" variant="light">
                    {event.error.message}
                </Alert>
            )}

            {/* Span identity */}
            <SpanIdentityBlock event={event} />

            {/* Tabs: Sections / Metadata / Raw JSON */}
            <Tabs defaultValue={hasSections ? 'sections' : hasMetadata ? 'metadata' : 'raw'}>
                <Tabs.List>
                    <Tabs.Tab value="sections" leftSection={<IconActivity size={14} />} disabled={!hasSections}>
                        Sections {hasSections ? `(${event.sections!.length})` : ''}
                    </Tabs.Tab>
                    <Tabs.Tab value="metadata" leftSection={<IconInfoCircle size={14} />} disabled={!hasMetadata}>
                        Metadata
                    </Tabs.Tab>
                    <Tabs.Tab value="raw" leftSection={<IconCode size={14} />}>
                        Raw JSON
                    </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="sections" pt="md">
                    {hasSections ? (
                        <Stack gap="sm">
                            {event.sections!.map((section, index) => {
                                const key =
                                    (typeof section.id === 'string' && section.id.length > 0 && `id-${section.id}`) ||
                                    (typeof section.label === 'string' && section.label.length > 0 && `label-${section.label}-${index}`) ||
                                    `section-${index}`;
                                return <SectionCard key={key} section={section} index={index} />;
                            })}
                        </Stack>
                    ) : (
                        <Text size="sm" c="dimmed">No structured sections for this event.</Text>
                    )}
                </Tabs.Panel>

                <Tabs.Panel value="metadata" pt="md">
                    {hasMetadata ? (
                        <JsonTreeViewer data={event.metadata} initialExpandLevel={3} />
                    ) : (
                        <Text size="sm" c="dimmed">No metadata.</Text>
                    )}
                </Tabs.Panel>

                <Tabs.Panel value="raw" pt="md">
                    <RawJsonView event={event} />
                </Tabs.Panel>
            </Tabs>
        </Stack>
    );
}

// ─── Event list (flat view) ────────────────────────────────────

function EventListFlat({
    events,
    selectedEventId,
    onSelect,
}: {
    events: TracingEvent[];
    selectedEventId: string | null;
    onSelect: (id: string) => void;
}) {
    return (
        <Stack gap="sm">
            {events.map((event) => {
                const isSelected = event.id === selectedEventId;
                return (
                    <Paper
                        key={event.id}
                        withBorder
                        radius="md"
                        p="sm"
                        onClick={() => onSelect(event.id)}
                        style={{
                            cursor: 'pointer',
                            borderColor: isSelected ? 'var(--mantine-color-blue-4)' : undefined,
                            backgroundColor: isSelected ? 'var(--mantine-color-blue-0)' : undefined,
                        }}
                    >
                        <Stack gap={6}>
                            <Group justify="space-between" align="flex-start">
                                <Stack gap={2} style={{ flex: 1 }}>
                                    <Group gap={6}>
                                        <Badge size="xs" variant="light" color={eventTypeColor(event.type)}>
                                            {humanize(event.type) || 'Span'}
                                        </Badge>
                                        <Text size="sm" fw={600} lineClamp={1}>
                                            {event.label ? humanize(event.label) : humanize(event.type) || 'Event'}
                                        </Text>
                                    </Group>
                                    <Text size="xs" c="dimmed">
                                        #{event.sequence ?? '—'} · {event.timestamp ? dayjs(event.timestamp).format('HH:mm:ss.SSS') : '—'}
                                    </Text>
                                </Stack>
                                {event.status && (
                                    <Badge size="xs" radius="xl" color={resolveStatusColor(event.status)}>
                                        {event.status}
                                    </Badge>
                                )}
                            </Group>
                            <Group gap="xs">
                                {event.toolName && (
                                    <Badge size="xs" variant="light" color="violet">{formatToolName(event.toolName)}</Badge>
                                )}
                                {event.model && (
                                    <Badge size="xs" variant="light" color="cyan">{event.model}</Badge>
                                )}
                                {(event.inputTokens || event.outputTokens) ? (
                                    <Badge size="xs" variant="light" color="gray">
                                        {formatNumber((event.inputTokens || 0) + (event.outputTokens || 0))} tokens
                                    </Badge>
                                ) : null}
                                {event.durationMs != null && (
                                    <Badge size="xs" variant="light" color="gray">{formatDuration(event.durationMs)}</Badge>
                                )}
                            </Group>
                        </Stack>
                    </Paper>
                );
            })}
        </Stack>
    );
}

// ─── Main page ─────────────────────────────────────────────────

export default function SessionDetailPage({ params }: { params: Promise<{ sessionId: string }> }) {
    const { sessionId } = usePromise(params);
    const router = useRouter();
    const { openDocs } = useDocsDrawer();

    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [detail, setDetail] = useState<SessionDetailResponse | null>(null);
    const [eventDetailError, setEventDetailError] = useState<string | null>(null);
    const [eventDetailLoading, setEventDetailLoading] = useState(false);
    const [eventDetailsById, setEventDetailsById] = useState<Record<string, SessionDetailResponse['events'][number]>>({});
    const [eventsView, setEventsView] = useState<'list' | 'tree'>('list');

    const fetchDetail = useCallback(async (isRefresh = false) => {
        try {
            if (isRefresh) setRefreshing(true); else setLoading(true);
            setError(null);
            const response = await fetch(`/api/tracing/sessions/${sessionId}?includeEventContent=false`);
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

    useEffect(() => { void fetchDetail(false); }, [fetchDetail]);

    useEffect(() => {
        if (detail?.session?.status !== 'in_progress') return;
        const interval = setInterval(() => { void fetchDetail(true); }, 5000);
        return () => clearInterval(interval);
    }, [detail?.session?.status, fetchDetail]);

    const tokenStats = useMemo(() => {
        const summary = detail?.session?.summary;
        return {
            input: summary?.totalInputTokens ?? detail?.session?.totalInputTokens ?? 0,
            output: summary?.totalOutputTokens ?? detail?.session?.totalOutputTokens ?? 0,
            cached: summary?.totalCachedInputTokens ?? detail?.session?.totalCachedInputTokens ?? 0,
        };
    }, [detail]);

    const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

    const sortedEvents = useMemo(() => {
        return detail?.events ?? [];
    }, [detail]);

    const hasSpanIds = useMemo(() => sortedEvents.some((e) => e.spanId), [sortedEvents]);

    const spanTree = useMemo(() => {
        if (!hasSpanIds) return [];
        return buildSpanTree(sortedEvents);
    }, [sortedEvents, hasSpanIds]);

    useEffect(() => {
        if (sortedEvents.length === 0) {
            if (selectedEventId !== null) setSelectedEventId(null);
            return;
        }
        const hasSelection = selectedEventId ? sortedEvents.some((e) => e.id === selectedEventId) : false;
        if (!hasSelection) setSelectedEventId(sortedEvents[0].id);
    }, [sortedEvents, selectedEventId]);

    useEffect(() => {
        if (!selectedEventId) {
            setEventDetailError(null);
            return;
        }

        if (eventDetailsById[selectedEventId]) {
            setEventDetailError(null);
            return;
        }

        let cancelled = false;

        const loadEventDetail = async () => {
            try {
                setEventDetailLoading(true);
                setEventDetailError(null);

                const response = await fetch(
                    `/api/tracing/sessions/${sessionId}/events/${encodeURIComponent(selectedEventId)}`,
                );

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.error || 'Failed to fetch event detail');
                }

                const data: EventDetailResponse = await response.json();
                if (cancelled) {
                    return;
                }

                setEventDetailsById((current) => ({
                    ...current,
                    [selectedEventId]: data.event,
                }));
            } catch (eventError) {
                if (cancelled) {
                    return;
                }

                setEventDetailError(
                    eventError instanceof Error ? eventError.message : 'Unable to load event detail',
                );
            } finally {
                if (!cancelled) {
                    setEventDetailLoading(false);
                }
            }
        };

        void loadEventDetail();

        return () => {
            cancelled = true;
        };
    }, [eventDetailsById, selectedEventId, sessionId]);

    const selectedEvent = useMemo(() => {
        if (!selectedEventId) return null;
        return eventDetailsById[selectedEventId] ?? null;
    }, [eventDetailsById, selectedEventId]);

    // ── Render states ──────────────────────────────────────────

    if (loading) {
        return (<Center h={320}><Loader /></Center>);
    }

    if (error) {
        return (
            <Alert icon={<IconInfoCircle size={16} />} color="red" title="Failed to load session" variant="light">
                {error}
            </Alert>
        );
    }

    if (!detail) {
        return (<Center h={320}><Text c="dimmed">Session not found.</Text></Center>);
    }

    const { session } = detail;

    return (
        <Stack gap="md">
            <PageHeader
                icon={<IconTimeline size={18} />}
                title={`Session ${session.sessionId.substring(0, 12)}...`}
                subtitle={
                    `Agent ${session.agentName || 'Unknown'}` +
                    (session.agentVersion ? ` · v${session.agentVersion}` : '') +
                    (session.agentModel ? ` · ${session.agentModel}` : '') +
                    ` · Started ${formatRelativeTime(session.startedAt)}`
                }
                actions={
                    <>
                        <Badge size="sm" variant="filled" radius="xl" color={resolveStatusColor(session.status)}>
                            {(session.status || 'unknown').toUpperCase()}
                        </Badge>
                        {sourceBadge(session.source)}
                        <Button leftSection={<IconArrowLeft size={14} />} variant="default" size="xs" onClick={() => router.push('/dashboard/tracing/sessions')}>
                            Back
                        </Button>
                        <Button onClick={() => openDocs('api-tracing')} variant="light" size="xs" leftSection={<IconBook size={14} />}>
                            Docs
                        </Button>
                        <Button leftSection={<IconRefresh size={14} />} variant="light" size="xs" onClick={() => void fetchDetail(true)} loading={refreshing}>
                            Refresh
                        </Button>
                    </>
                }
            />

            <Grid gutter="md" style={{ minHeight: 'calc(100vh - 320px)' }}>
                {/* ── Left: Session info ── */}
                <Grid.Col span={{ base: 12, xl: 3 }}>
                    <Stack gap="md">
                        <Card withBorder p="md">
                            <Text fw={600} mb="sm">Session details</Text>
                            <Stack gap={6}>
                                <KVRow label="Session ID" mono>{session.sessionId}</KVRow>
                                {session.threadId && (
                                    <Group justify="space-between">
                                        <Text size="sm" c="dimmed">Thread</Text>
                                        <Text size="sm" c="blue" style={{ cursor: 'pointer', fontFamily: 'monospace' }} onClick={() => router.push(`/dashboard/tracing/threads/${session.threadId}`)}>
                                            {session.threadId.substring(0, 16)}...
                                        </Text>
                                    </Group>
                                )}
                                {session.traceId && <KVRow label="Trace ID" mono>{session.traceId.substring(0, 16)}...</KVRow>}
                                {session.rootSpanId && <KVRow label="Root Span" mono>{session.rootSpanId}</KVRow>}
                                <KVRow label="Started">{session.startedAt ? dayjs(session.startedAt).format('MMM D, YYYY HH:mm:ss') : '—'}</KVRow>
                                <KVRow label="Ended">{session.endedAt ? dayjs(session.endedAt).format('MMM D, YYYY HH:mm:ss') : '—'}</KVRow>
                                <KVRow label="Agent">{session.agentName || '—'}</KVRow>
                                {session.agentVersion && <KVRow label="Version">{session.agentVersion}</KVRow>}
                                {session.agentModel && <KVRow label="Model">{session.agentModel}</KVRow>}
                                <KVRow label="Duration">{formatDuration(session.durationMs)}</KVRow>
                                <KVRow label="Events">{formatNumber(session.totalEvents)}</KVRow>
                                {session.modelsUsed && session.modelsUsed.length > 0 && (
                                    <Stack gap={2}>
                                        <Text size="sm" c="dimmed">Models used</Text>
                                        <Group gap={4}>
                                            {session.modelsUsed.map((m) => (
                                                <Badge key={m} size="xs" variant="light" color="cyan">{m}</Badge>
                                            ))}
                                        </Group>
                                    </Stack>
                                )}
                                {session.toolsUsed && session.toolsUsed.length > 0 && (
                                    <Stack gap={2}>
                                        <Text size="sm" c="dimmed">Tools used</Text>
                                        <Group gap={4}>
                                            {session.toolsUsed.map((t) => (
                                                <Badge key={t} size="xs" variant="light" color="violet">{formatToolName(t)}</Badge>
                                            ))}
                                        </Group>
                                    </Stack>
                                )}
                            </Stack>
                        </Card>

                        {/* Event type breakdown */}
                        {session.eventCounts && Object.keys(session.eventCounts).length > 0 && (
                            <Card withBorder p="md">
                                <Text fw={600} mb="sm" size="sm">Event Breakdown</Text>
                                <Stack gap={4}>
                                    {Object.entries(session.eventCounts).map(([type, count]) => (
                                        <Group key={type} justify="space-between">
                                            <Badge size="xs" variant="light" color={eventTypeColor(type)}>{humanize(type)}</Badge>
                                            <Text size="sm" fw={500}>{count}</Text>
                                        </Group>
                                    ))}
                                </Stack>
                            </Card>
                        )}

                        {/* Token cards */}
                        <SimpleGrid cols={3} spacing="xs">
                            <Card withBorder p="sm">
                                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Input</Text>
                                <Text size="lg" fw={700} mt={2}>{formatNumber(tokenStats.input)}</Text>
                            </Card>
                            <Card withBorder p="sm">
                                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Output</Text>
                                <Text size="lg" fw={700} mt={2}>{formatNumber(tokenStats.output)}</Text>
                            </Card>
                            <Card withBorder p="sm">
                                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Cache</Text>
                                <Text size="lg" fw={700} mt={2}>{formatNumber(tokenStats.cached)}</Text>
                            </Card>
                        </SimpleGrid>

                        {/* Errors */}
                        {session.errors && session.errors.length > 0 && (
                            <Card withBorder p="md">
                                <Text fw={600} mb="sm" size="sm" c="red">Errors ({session.errors.length})</Text>
                                <Stack gap={4}>
                                    {session.errors.map((err, i) => (
                                        <Alert key={i} color="red" variant="light" icon={<IconInfoCircle size={12} />} p="xs">
                                            <Text size="xs">{err.message}</Text>
                                            {err.timestamp && <Text size="xs" c="dimmed">{dayjs(err.timestamp).format('HH:mm:ss')}</Text>}
                                        </Alert>
                                    ))}
                                </Stack>
                            </Card>
                        )}
                    </Stack>
                </Grid.Col>

                {/* ── Middle: Events list / tree ── */}
                <Grid.Col span={{ base: 12, xl: 4 }}>
                    <Card withBorder p="md" h="100%">
                        <Stack gap="md" h="100%">
                            <Group justify="space-between">
                                <Stack gap={2}>
                                    <Text fw={600}>Events</Text>
                                    <Text size="sm" c="dimmed">{sortedEvents.length} events captured</Text>
                                </Stack>
                                {hasSpanIds && (
                                    <Tooltip label={eventsView === 'list' ? 'Switch to tree view' : 'Switch to list view'}>
                                        <ActionIcon
                                            variant={eventsView === 'tree' ? 'filled' : 'light'}
                                            size="sm"
                                            color="blue"
                                            onClick={() => setEventsView(eventsView === 'list' ? 'tree' : 'list')}
                                        >
                                            <IconBinaryTree size={14} />
                                        </ActionIcon>
                                    </Tooltip>
                                )}
                            </Group>
                            {sortedEvents.length === 0 ? (
                                <Center h={200}>
                                    <Text c="dimmed">No events recorded for this session.</Text>
                                </Center>
                            ) : (
                                <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
                                    {eventsView === 'tree' && hasSpanIds ? (
                                        <Stack gap={4}>
                                            {spanTree.map((node) => (
                                                <SpanTreeItem
                                                    key={node.event.spanId || node.event.id}
                                                    node={node}
                                                    depth={0}
                                                    selectedEventId={selectedEventId}
                                                    onSelect={setSelectedEventId}
                                                />
                                            ))}
                                        </Stack>
                                    ) : (
                                        <EventListFlat
                                            events={sortedEvents}
                                            selectedEventId={selectedEventId}
                                            onSelect={setSelectedEventId}
                                        />
                                    )}
                                </ScrollArea>
                            )}
                        </Stack>
                    </Card>
                </Grid.Col>

                {/* ── Right: Event detail ── */}
                <Grid.Col span={{ base: 12, xl: 5 }}>
                    <Card withBorder p="md" h="100%">
                        <Stack gap="md" h="100%">
                            <Text fw={600}>Event detail</Text>
                            {selectedEvent ? (
                                <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars>
                                    <EventDetailPanel event={selectedEvent} />
                                </ScrollArea>
                            ) : selectedEventId && eventDetailLoading ? (
                                <Center h={200}>
                                    <Stack gap="xs" align="center">
                                        <Loader size="sm" />
                                        <Text c="dimmed" size="sm">Loading event detail...</Text>
                                    </Stack>
                                </Center>
                            ) : eventDetailError ? (
                                <Alert icon={<IconInfoCircle size={16} />} color="red" variant="light">
                                    {eventDetailError}
                                </Alert>
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
