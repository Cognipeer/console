'use client';

/**
 * One section of the agent's configuration: a label column on the left, the
 * fields on the right.
 *
 * Replaces the vertical rail Configure used to have. A rail hides six of seven
 * sections behind a click, which is the wrong trade for a form that is edited
 * as a whole and saved by one button — you cannot see what the agent is
 * without touring it. Stacked, the whole config reads top to bottom, and the
 * label column keeps the fields at a readable width instead of letting them
 * stretch across the viewport.
 */

import type { ReactNode } from 'react';
import { Badge, Box, Divider, Group, Stack, Text } from '@mantine/core';
import classes from './ConfigSection.module.css';

export interface ConfigBlockProps {
    icon?: ReactNode;
    title: string;
    children: ReactNode;
}

/**
 * A named group of fields inside a section — what used to be a collapsible.
 *
 * Open, always. Each of these held one or two inputs behind a chevron, so
 * collapsing them saved a few hundred pixels and cost a click per question
 * ("is a knowledge engine attached?", "which guardrails run?") that reading
 * the page should answer on its own.
 */
export function ConfigBlock({ icon, title, children }: ConfigBlockProps) {
    return (
        <Box>
            <Group gap={6} mb="xs">
                {icon}
                <Text size="sm" fw={600}>{title}</Text>
            </Group>
            {children}
        </Box>
    );
}

export interface ConfigSectionProps {
    /** Anchor for deep links (`?tab=prompt` scrolls here). */
    id: string;
    title: string;
    description?: string;
    /** Shown under the description — a count, a state badge. */
    meta?: ReactNode;
    children: ReactNode;
    /** Sections render a divider above themselves except the first. */
    first?: boolean;
    /** Differs from the published version — flagged so a reviewer finds it. */
    changed?: boolean;
}

export default function ConfigSection({
    id,
    title,
    description,
    meta,
    children,
    first,
    changed,
}: ConfigSectionProps) {
    // Always open — no fold mode. A folded section showed a one-line summary
    // in place of its fields, which hid the config behind a click per section.
    const heading = (
        <Group gap={6} wrap="nowrap">
            <Text fw={600}>{title}</Text>
            {changed ? (
                <Badge size="xs" variant="light" color="orange">Changed</Badge>
            ) : null}
        </Group>
    );
    return (
        <>
            {!first ? <Divider my="xl" /> : null}
            <Group
                id={`config-${id}`}
                align="flex-start"
                gap="xl"
                wrap="nowrap"
                className={classes.section}
            >
                <Stack gap={4} className={classes.label}>
                    {heading}
                    {description ? <Text size="sm" c="dimmed">{description}</Text> : null}
                    {meta}
                </Stack>
                <Box id={`config-${id}-body`} className={classes.content}>
                    {children}
                </Box>
            </Group>
        </>
    );
}
