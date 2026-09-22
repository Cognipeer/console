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
import { Box, Divider, Group, Stack, Text } from '@mantine/core';
import classes from './ConfigSection.module.css';

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
}

export default function ConfigSection({
    id,
    title,
    description,
    meta,
    children,
    first,
}: ConfigSectionProps) {
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
                    <Text fw={600}>{title}</Text>
                    {description ? <Text size="sm" c="dimmed">{description}</Text> : null}
                    {meta}
                </Stack>
                <Box className={classes.content}>{children}</Box>
            </Group>
        </>
    );
}
