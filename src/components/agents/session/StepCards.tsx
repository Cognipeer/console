'use client';

/**
 * A turn's tool calls as the transcript shows them once the turn is stored: a
 * collapsed timeline per run of calls, a card per call, and the payload viewer
 * inside it. Shared by the stored turn and by the sub-agent groups, which show
 * their own steps the same way.
 */

import { useMemo, useState } from 'react';
import { ActionIcon, Badge, Box, Button, Code, Collapse, CopyButton, Group, Paper, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconTimeline } from '@tabler/icons-react';
import { stepFailed, type PlaygroundStep } from './sessionTypes';
import classes from './AgentSessionView.module.css';

/** How much of a payload is shown before "Show the whole payload". */
const PAYLOAD_CLIP_CHARS = 1200;

/**
 * The tool calls a turn made, in order.
 *
 * Collapsed, because by the time a turn is in the transcript the calls have
 * already been watched live (LiveToolCalls) and the answer is what the reader
 * came back for. The summary line keeps them one click away, and a failure
 * colours it red so a turn that went wrong still announces itself.
 */
export function StepTimeline({ steps, offset = 0 }: { steps: PlaygroundStep[]; offset?: number }) {
    const [open, setOpen] = useState(false);
    const failed = steps.filter(stepFailed).length;

    return (
        <Box mb="sm">
            <Button
                size="compact-xs"
                variant="subtle"
                color={failed > 0 ? 'red' : 'gray'}
                leftSection={<IconTimeline size={12} />}
                rightSection={open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                onClick={() => setOpen((value) => !value)}
            >
                {steps.length} tool call{steps.length === 1 ? '' : 's'}
                {failed > 0 ? ` · ${failed} failed` : ''}
            </Button>
            <Collapse in={open}>
                <Stack gap={6} mt="xs">
                    {steps.map((step, index) => (
                        <StepCard key={step.id ?? index} step={step} index={offset + index} />
                    ))}
                </Stack>
            </Collapse>
        </Box>
    );
}

/** One tool call: what was asked, what came back, and how the run treated it. */
export function StepCard({ step, index }: { step: PlaygroundStep; index: number }) {
    const failed = stepFailed(step);

    return (
        <Paper withBorder p="xs" radius="sm">
            <Group gap="xs" mb={6} wrap="wrap">
                <Badge size="xs" variant="light" color={failed ? 'red' : 'blue'}>{index + 1}</Badge>
                <Text size="xs" fw={600} ff="monospace">{step.name}</Text>
                {step.status && step.status !== 'success' ? (
                    <Badge size="xs" variant="light" color={failed ? 'red' : 'yellow'}>{step.status}</Badge>
                ) : null}
                {step.subagent ? (
                    <Badge size="xs" variant="outline" color="violet">via {step.subagent}</Badge>
                ) : null}
                {step.approvalRule ? (
                    <Tooltip
                        label={`An approval exception on this tool: ${step.approvalRule.field ?? 'any argument'} matches "${step.approvalRule.pattern}"`}
                        withArrow
                    >
                        {step.approvalRule.action === 'deny'
                            ? <Badge size="xs" variant="filled" color="red">blocked by rule</Badge>
                            : <Badge size="xs" variant="outline" color="gray">no approval · exception</Badge>}
                    </Tooltip>
                ) : null}
                {step.fromCache ? (
                    <Tooltip label="Served from the response cache — the tool was not actually called" withArrow>
                        <Badge size="xs" variant="outline" color="gray">cached</Badge>
                    </Tooltip>
                ) : null}
                {step.summarized ? (
                    <Tooltip
                        label={step.originalTokenCount
                            ? `The model saw a compaction of this result (originally ~${step.originalTokenCount} tokens)`
                            : 'The model saw a compaction of this result'}
                        withArrow
                    >
                        <Badge size="xs" variant="outline" color="orange">summarized</Badge>
                    </Tooltip>
                ) : null}
                {step.timestamp ? (
                    <Text size="10px" c="dimmed">{new Date(step.timestamp).toLocaleTimeString()}</Text>
                ) : null}
            </Group>

            {step.args !== undefined ? <StepPayload label="args" value={step.args} /> : null}
            {step.error ? (
                <Box mb={4}>
                    <Text size="10px" c="dimmed" tt="uppercase" fw={600}>error</Text>
                    <Text size="xs" c="red" className={classes.preWrap}>{step.error}</Text>
                </Box>
            ) : null}
            {step.output !== undefined ? (
                <StepPayload
                    // Naming matters once the two can differ: with the console's
                    // default retention the model may have read a compaction, and
                    // calling that "result" hid the substitution entirely.
                    label={step.rawOutput !== undefined ? 'what the model saw' : 'result'}
                    value={step.output}
                />
            ) : null}
            {step.rawOutput !== undefined ? (
                <StepPayload label="full tool result" value={step.rawOutput} defaultOpen={false} />
            ) : null}
        </Paper>
    );
}

/**
 * One payload inside a step.
 *
 * Long values open clipped with the rest one click away, rather than being
 * truncated outright: a 50KB tool result pasted into the transcript makes the
 * whole session unreadable, but "… 48000 more characters" with no way to see
 * them made the playground useless for the exact debugging it exists for.
 */
export function StepPayload({
    label,
    value,
    defaultOpen = true,
}: {
    label: string;
    value: unknown;
    defaultOpen?: boolean;
}) {
    const [expanded, setExpanded] = useState(false);
    const [open, setOpen] = useState(defaultOpen);

    const text = useMemo(() => {
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }, [value]);

    const clipped = text.length > PAYLOAD_CLIP_CHARS && !expanded;
    const shown = clipped ? text.slice(0, PAYLOAD_CLIP_CHARS) : text;

    return (
        <Box mb={6}>
            <Group gap={6} mb={2}>
                <UnstyledButton onClick={() => setOpen((value) => !value)}>
                    <Group gap={3}>
                        {open ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                        <Text size="10px" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
                    </Group>
                </UnstyledButton>
                <Text size="10px" c="dimmed">{text.length.toLocaleString()} chars</Text>
                <CopyButton value={text}>
                    {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                            <ActionIcon size={14} variant="subtle" color="gray" onClick={copy}>
                                {copied ? <IconCheck size={10} /> : <IconCopy size={10} />}
                            </ActionIcon>
                        </Tooltip>
                    )}
                </CopyButton>
            </Group>
            <Collapse in={open}>
                <Code block className={classes.payloadCode}>
                    {shown}
                    {clipped ? `\n… ${(text.length - PAYLOAD_CLIP_CHARS).toLocaleString()} more characters` : ''}
                </Code>
                {text.length > PAYLOAD_CLIP_CHARS ? (
                    <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        mt={2}
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded ? 'Collapse' : 'Show the whole payload'}
                    </Button>
                ) : null}
            </Collapse>
        </Box>
    );
}
