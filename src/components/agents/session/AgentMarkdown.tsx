'use client';

import { TypographyStylesProvider } from '@mantine/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MARKDOWN_LINK_COMPONENTS } from '@/components/common/ui/ExternalLinks';
import classes from './AgentMarkdown.module.css';

/**
 * Wrapped so headings, lists and tables in an answer actually look like
 * headings, lists and tables — a bare ReactMarkdown emits real h2/ul/table
 * elements that nothing was styling, so a structured report rendered as one
 * undifferentiated block of text.
 *
 * Shared by the session transcript and the compare drawer so an answer reads
 * the same in both places. Its links open in a new tab.
 */
export default function AgentMarkdown({ text }: { text: string }) {
    return (
        <TypographyStylesProvider className={classes.markdownBody}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_LINK_COMPONENTS}>{text}</ReactMarkdown>
        </TypographyStylesProvider>
    );
}
