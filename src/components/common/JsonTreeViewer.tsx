'use client';

import { useMemo } from 'react';
import { Paper, useMantineColorScheme } from '@mantine/core';
import { JsonView, collapseAllNested, defaultStyles, darkStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

/* ─── Expand strategy ───────────────────────────────────────── */

export interface JsonTreeViewerProps {
    /** The data to display — object, array, or primitive */
    data: unknown;
    /** Max collapsed depth. Defaults to 2 (root + first children open) */
    initialExpandLevel?: number;
    /** Wrap in a bordered Paper? Defaults to true */
    bordered?: boolean;
}

export default function JsonTreeViewer({
    data,
    initialExpandLevel = 2,
    bordered = true,
}: JsonTreeViewerProps) {
    const { colorScheme } = useMantineColorScheme();
    const isDark = colorScheme === 'dark';

    const expandFn = useMemo(() => {
        if (initialExpandLevel <= 0) return collapseAllNested;
        if (initialExpandLevel >= 100) return () => true;
        return (level: number) => level < initialExpandLevel;
    }, [initialExpandLevel]);

    // Normalize primitive values into a renderable object
    const normalizedData = useMemo(() => {
        if (data === null || data === undefined) return { value: null };
        if (typeof data === 'object') return data as object;
        return { value: data };
    }, [data]);

    const content = (
        <JsonView
            data={normalizedData}
            shouldExpandNode={expandFn}
            clickToExpandNode
            style={isDark ? darkStyles : defaultStyles}
        />
    );

    if (!bordered) return content;

    return (
        <Paper
            withBorder
            radius="md"
            p="xs"
            style={{
                overflow: 'auto',
                fontSize: 13,
                lineHeight: 1.6,
                fontFamily: 'var(--mantine-font-family-monospace, ui-monospace, monospace)',
            }}
        >
            {content}
        </Paper>
    );
}
