'use client';

/**
 * Side-by-side: the same message to two versions of the agent.
 *
 * Built for the question asked right before Publish — "is the draft actually
 * better than what is live?". Each side keeps its own history and runs
 * stateless (`history`, no `conversationId`), so comparing never writes a
 * session into the list or the published agent's traffic.
 *
 * Both sides start at once and stream independently: the answer text and the
 * model's reasoning appear as they are written, a failure stays on its own
 * side, and one Stop ends whatever is still running. The two panes always have
 * the same height and their stats footers share a baseline (see the CSS module).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    Alert,
    Badge,
    Box,
    Button,
    Collapse,
    Drawer,
    Grid,
    Group,
    Loader,
    Paper,
    SegmentedControl,
    Select,
    SimpleGrid,
    Stack,
    Text,
    Textarea,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import {
    IconArrowsLeftRight,
    IconBrain,
    IconChevronDown,
    IconChevronRight,
    IconPlayerStop,
    IconRefresh,
    IconSend,
} from '@tabler/icons-react';
import MessageBlock from '@/components/common/ui/MessageBlock';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import { formatDuration, formatNumber } from '@/lib/utils/tracingUtils';
import AgentMarkdown from '../session/AgentMarkdown';
import { formatCost } from '../session/sessionUsage';
import {
    DEFAULT_RESPONSE_FORMAT,
    compareTotals,
    isResponseFormat,
    type CompareResponseFormat,
    type CompareTurn as Turn,
} from './compareVersionsStats';
import { runCompareSide, type CompareLive } from './compareVersionsStream';
import classes from './CompareVersionsDrawer.module.css';

const DRAFT = 'draft';

type SideKey = 'left' | 'right';

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

/** The drawer is a flex column of exactly the available height: the page itself never scrolls. */
const DRAWER_STYLES = {
    content: { display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    body: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
} as const;

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
    // What each side has streamed so far; null when the side is not running.
    const [leftLive, setLeftLive] = useState<CompareLive | null>(null);
    const [rightLive, setRightLive] = useState<CompareLive | null>(null);
    const [input, setInput] = useState('');
    const controllers = useRef<Partial<Record<SideKey, AbortController>>>({});
    // One mode for both columns, kept across version switches and resets, so
    // the two answers are always read in the same form.
    const [responseFormat, setResponseFormat] = useState<CompareResponseFormat>(DEFAULT_RESPONSE_FORMAT);
    const running = leftLive !== null || rightLive !== null;

    const sideLabel = (value: string): string => {
        if (value === DRAFT) return t('draft');
        return Number(value) === publishedVersion
            ? t('publishedVersionOption', { version: value })
            : t('versionOption', { version: value });
    };

    const stop = () => {
        for (const controller of Object.values(controllers.current)) controller?.abort();
    };

    useEffect(() => {
        if (opened && initialMessage && !input) setInput(initialMessage);
        // Only when the drawer opens — not while someone is typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened]);

    // Closing the drawer (or leaving the page) ends the runs: nobody is reading them.
    useEffect(() => {
        if (!opened) stop();
    }, [opened]);
    useEffect(() => stop, []);

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

    const send = async () => {
        const message = input.trim();
        if (!message || running) return;
        setInput('');
        const user: Turn = { role: 'user', content: message };
        const sides: Array<{
            key: SideKey;
            side: string;
            history: Turn[];
            setTurns: (update: (turns: Turn[]) => Turn[]) => void;
            setLive: (live: CompareLive | null) => void;
        }> = [
            { key: 'left', side: left, history: leftTurns, setTurns: setLeftTurns, setLive: setLeftLive },
            { key: 'right', side: right, history: rightTurns, setTurns: setRightTurns, setLive: setRightLive },
        ];
        // Both sides start now, each with its own controller, stream and failure.
        const runs = sides.map((entry) => {
            const controller = new AbortController();
            controllers.current[entry.key] = controller;
            entry.setTurns((turns) => [...turns, user]);
            entry.setLive({ content: '', reasoning: '' });
            return runCompareSide({
                agentId,
                ...(entry.side !== DRAFT ? { version: Number(entry.side) } : {}),
                message,
                history: entry.history,
                signal: controller.signal,
                onLive: entry.setLive,
                noAnswerMessage: t('noAnswer'),
            }).then((turn) => {
                entry.setLive(null);
                entry.setTurns((turns) => [...turns, turn]);
            });
        });
        await Promise.all(runs);
    };

    const pane = (key: SideKey, side: string, onSide: (value: string) => void, turns: Turn[], live: CompareLive | null) => (
        <ComparePane
            testId={`compare-pane-${key}`}
            side={side}
            sideLabel={sideLabel(side)}
            options={options}
            onSide={(value) => { onSide(value); reset(); }}
            turns={turns}
            live={live}
            running={running}
            responseFormat={responseFormat}
        />
    );

    return (
        <Drawer
            opened={opened}
            onClose={onClose}
            position="right"
            size="90%"
            styles={DRAWER_STYLES}
            title={
                <Group gap="xs">
                    <IconArrowsLeftRight size={16} />
                    <Text fw={600}>{t('title')}</Text>
                </Group>
            }
        >
            <div className={classes.root} data-testid="compare-root">
                {changedSections && changedSections.length > 0 ? (
                    <Group gap={6} className={classes.fixed}>
                        <Text size="xs" c="dimmed">{t('changedSince', { version: publishedVersion })}</Text>
                        {changedSections.map((section) => (
                            <Badge key={section} size="sm" variant="light" color="orange">{section}</Badge>
                        ))}
                    </Group>
                ) : null}
                <Group justify="space-between" gap="xs" className={classes.fixed}>
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
                <div className={classes.panes} data-testid="compare-panes">
                    {pane('left', left, setLeft, leftTurns, leftLive)}
                    {pane('right', right, setRight, rightTurns, rightLive)}
                </div>
                <Group align="flex-end" wrap="nowrap" className={classes.fixed}>
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
                    {running ? (
                        <Button color="red" variant="light" leftSection={<IconPlayerStop size={14} />} onClick={stop} data-testid="compare-stop">
                            {t('stop')}
                        </Button>
                    ) : (
                        <Button leftSection={<IconSend size={14} />} onClick={() => void send()} disabled={!input.trim()} data-testid="compare-send">
                            {t('send')}
                        </Button>
                    )}
                    <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={reset} disabled={running}>
                        {t('reset')}
                    </Button>
                </Group>
                {left === right ? (
                    <Text size="xs" c="orange" className={classes.fixed}>{t('sameVersion')}</Text>
                ) : null}
            </div>
        </Drawer>
    );
}

interface ComparePaneProps {
    testId: string;
    side: string;
    sideLabel: string;
    options: Array<{ value: string; label: string }>;
    onSide: (value: string) => void;
    turns: Turn[];
    live: CompareLive | null;
    running: boolean;
    responseFormat: CompareResponseFormat;
}

/**
 * One side: header, a transcript that scrolls inside the pane, and the stats
 * footer pinned under it. The footer is always there (with dashes before the
 * first answer), so both panes have the same structure whatever happened on
 * either side.
 */
function ComparePane({ testId, side, sideLabel, options, onSide, turns, live, running, responseFormat }: ComparePaneProps) {
    const t = useTranslations('agents.compare');
    const sum = compareTotals(turns);
    const answered = turns.some((turn) => turn.role === 'assistant');
    const tokenValue = (value: number | undefined) => (
        value === undefined
            ? answered
                ? <Tooltip label={t('stats.notReported')} withArrow><span>—</span></Tooltip>
                : '—'
            : formatNumber(value)
    );

    // Follows the newest text while it streams, until the reader scrolls up.
    const transcript = useRef<HTMLDivElement>(null);
    const stuck = useRef(true);
    useEffect(() => { stuck.current = true; }, [turns.length]);
    useEffect(() => {
        const element = transcript.current;
        if (element && stuck.current) element.scrollTop = element.scrollHeight;
    });

    return (
        <Paper withBorder radius="md" p="md" className={classes.pane} data-testid={testId}>
            <Group justify="space-between" mb="sm" wrap="nowrap">
                <Select
                    size="xs"
                    w={220}
                    data={options}
                    value={side}
                    onChange={(value) => { if (value) onSide(value); }}
                    allowDeselect={false}
                    disabled={running}
                />
                <Badge variant="light" color={side === DRAFT ? 'orange' : 'teal'}>
                    {sideLabel}
                </Badge>
            </Group>
            <div
                ref={transcript}
                className={classes.transcript}
                data-testid={`${testId}-transcript`}
                onScroll={() => {
                    const element = transcript.current;
                    if (element) stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
                }}
            >
                {turns.length === 0 && !live ? (
                    <Text size="sm" c="dimmed">{t('empty')}</Text>
                ) : null}
                {turns.map((turn, index) => (
                    <TurnView key={index} turn={turn} responseFormat={responseFormat} />
                ))}
                {live ? (
                    <TurnView
                        turn={{ role: 'assistant', content: live.content, ...(live.reasoning ? { reasoning: live.reasoning } : {}) }}
                        responseFormat={responseFormat}
                        live
                    />
                ) : null}
            </div>
            <div className={classes.footer} data-testid={`${testId}-footer`}>
                <Grid type="container" breakpoints={STATS_BREAKPOINTS} columns={6} gutter="sm">
                    {/*
                      * Wide: Latency | Cost | Tool calls on the left half, Tokens on the
                      * right half with its breakdown as a second row directly beneath —
                      * set off by a divider so the two rows read as one group.
                      * Narrow: the three scalar stats share a row and the Tokens group
                      * moves below them, full width, so its breakdown never gets squeezed.
                      */}
                    <Grid.Col span={{ base: 2, sm: 1 }}>
                        <Stat label={t('stats.latency')} value={answered ? formatDuration(sum.latencyMs) : '—'} />
                    </Grid.Col>
                    <Grid.Col span={{ base: 2, sm: 1 }}>
                        <Stat label={t('stats.cost')} value={sum.cost ? formatCost(sum.cost) : '—'} />
                    </Grid.Col>
                    <Grid.Col span={{ base: 2, sm: 1 }}>
                        <Stat label={t('stats.toolCalls')} value={answered ? String(sum.toolCalls) : '—'} />
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
            </div>
        </Paper>
    );
}

function TurnView({ turn, responseFormat, live = false }: { turn: Turn; responseFormat: CompareResponseFormat; live?: boolean }) {
    const t = useTranslations('agents.compare');
    if (turn.role === 'error') {
        return (
            <Alert color="red" variant="light" p="xs">
                <Text size="xs">{turn.content}</Text>
            </Alert>
        );
    }
    const isAssistant = turn.role === 'assistant';
    return (
        <Paper
            withBorder={isAssistant}
            radius="md"
            p="sm"
            bg={turn.role === 'user' ? 'var(--ds-surface-sunken, var(--mantine-color-gray-0))' : undefined}
            style={{ flex: '0 0 auto' }}
        >
            <Stack gap={6}>
                {isAssistant && turn.reasoning ? (
                    <ReasoningBlock text={turn.reasoning} thinking={live && !turn.content} />
                ) : null}
                {isAssistant && responseFormat === 'markdown' ? (
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
                        roleLabel={isAssistant ? t('roleAssistant') : t('roleUser')}
                    />
                )}
                {live && !turn.content && !turn.reasoning ? (
                    <Group gap="xs"><Loader size="xs" /><Text size="xs" c="dimmed">{t('running')}</Text></Group>
                ) : null}
                {live && (turn.content || turn.reasoning) ? <Loader size="xs" type="dots" /> : null}
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
                {turn.stopped ? <Text size="xs" c="dimmed">{t('stopped')}</Text> : null}
                {isAssistant && !live ? (
                    <Group gap="md">
                        {turn.latencyMs ? <Text size="xs" c="dimmed">{formatDuration(turn.latencyMs)}</Text> : null}
                        {turn.totalTokens ? <Text size="xs" c="dimmed">{t('turnTokens', { count: formatNumber(turn.totalTokens) })}</Text> : null}
                        {turn.costUsd ? <Text size="xs" c="dimmed">{formatCost(turn.costUsd)}</Text> : null}
                    </Group>
                ) : null}
            </Stack>
        </Paper>
    );
}

/**
 * The model's thinking, above its answer. Open by default and live while it
 * streams; the operator can fold it away but there is no switch that hides it —
 * this screen exists to see what each version did.
 */
function ReasoningBlock({ text, thinking }: { text: string; thinking: boolean }) {
    const t = useTranslations('agents.compare');
    const [open, setOpen] = useState(true);
    return (
        <Box data-testid="compare-reasoning">
            <UnstyledButton onClick={() => setOpen((value) => !value)} className={classes.reasoningButton} aria-expanded={open}>
                <IconBrain size={13} color="var(--mantine-color-violet-6)" />
                <Text size="xs" fw={500} c="violet.6">{thinking ? t('thinking') : t('reasoning')}</Text>
                {open
                    ? <IconChevronDown size={12} color="var(--mantine-color-violet-6)" />
                    : <IconChevronRight size={12} color="var(--mantine-color-violet-6)" />}
            </UnstyledButton>
            <Collapse in={open}>
                <Text size="xs" c="dimmed" mt={4} pl="xs" className={classes.reasoningBody} data-testid="compare-reasoning-text">
                    {text}
                </Text>
            </Collapse>
        </Box>
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
