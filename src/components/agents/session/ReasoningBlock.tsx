'use client';

/**
 * The model's thinking text, drawn directly in the transcript: a collapsible
 * block that starts open, while it streams and on the finished message alike
 * (no show/hide switch - the person can fold it). The same block serves the
 * live view and the stored message, so nothing jumps when the turn ends.
 */

import { useState } from 'react';
import { Box, Collapse, Group, Loader, Text, UnstyledButton } from '@mantine/core';
import { IconBrain, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import classes from './AgentSessionView.module.css';

export interface ReasoningBlockProps {
    reasoning: string;
    /** The model is still thinking: the label says so and a spinner runs. */
    streaming?: boolean;
    testId?: string;
}

export default function ReasoningBlock({ reasoning, streaming, testId }: ReasoningBlockProps) {
    const [open, setOpen] = useState(true);
    if (!reasoning.trim()) return null;
    const Chevron = open ? IconChevronDown : IconChevronRight;
    return (
        <Box mb="xs" data-testid={testId ?? 'agent-reasoning-block'}>
            <UnstyledButton onClick={() => setOpen((v) => !v)} className={classes.disclosureButton} aria-expanded={open}>
                <IconBrain size={13} color="var(--mantine-color-violet-6)" />
                <Text size="xs" fw={500} c="violet.6">{streaming ? 'Thinking…' : 'Reasoning'}</Text>
                {streaming ? <Loader size={10} color="violet" /> : null}
                <Chevron size={12} color="var(--mantine-color-violet-6)" />
            </UnstyledButton>
            <Collapse in={open}>
                <Group mt={4} pl="xs" className={classes.reasoningBody}>
                    <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
                        {reasoning}
                    </Text>
                </Group>
            </Collapse>
        </Box>
    );
}
