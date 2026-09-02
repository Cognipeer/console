'use client';

import { useMemo } from 'react';
import { Paper } from '@mantine/core';
import { JsonView, collapseAllNested, defaultStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import moduleStyles from './JsonTreeViewer.module.css';

/**
 * `react-json-view-lite`'s style props are CSS class names, not inline
 * styles — `basicChildStyle`/`childFieldsContainer` carry no color (just
 * indentation), so the library's own classes are kept for those; every
 * color-bearing class is replaced with one driven by Mantine tokens, so it
 * reads as part of this app rather than the library's default black-on-grey
 * look, and stays correct in both themes without a light/dark branch.
 */
const jsonViewStyle = {
    ...defaultStyles,
    container: moduleStyles.container,
    label: moduleStyles.label,
    clickableLabel: moduleStyles.clickableLabel,
    stringValue: moduleStyles.stringValue,
    numberValue: moduleStyles.numberValue,
    booleanValue: moduleStyles.booleanValue,
    nullValue: moduleStyles.nullValue,
    undefinedValue: moduleStyles.undefinedValue,
    otherValue: moduleStyles.otherValue,
    punctuation: moduleStyles.punctuation,
    expandIcon: moduleStyles.expandIcon,
    collapseIcon: moduleStyles.collapseIcon,
    collapsedContent: moduleStyles.collapsedContent,
};

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
            style={jsonViewStyle}
        />
    );

    if (!bordered) return content;

    return (
        <Paper
            withBorder
            radius="md"
            p="xs"
            style={{ overflow: 'auto' }}
        >
            {content}
        </Paper>
    );
}
