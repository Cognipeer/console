'use client';

/**
 * A context summarization as a dashed divider in the flow of a turn, at the
 * point it happened: "⟲ Context summarized · pass 2 · 84.2k → 11.9k tokens
 * (−86%) · 3.1s". The pill opens to what the agent now remembers in place of
 * what was dropped (the same content as the summary card), with the tool
 * results THIS pass replaced. While the summarizer runs it reads "Summarizing
 * context…". A pass a sub-agent made inside its group carries no number: it
 * is not one of the agent's own.
 */

import { useState } from 'react';
import { Box, Collapse, Loader, Text, UnstyledButton } from '@mantine/core';
import { IconArrowsMinimize, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { formatDuration } from '@/lib/utils/tracingUtils';
import { ContextCompactionBody, compactionHasDetail } from './ContextCompactionCard';
import type { TurnCompaction } from './sessionTypes';
import { formatCompactTokens } from './sessionUsage';
import { compactionChangeLabel, type CompactionDividerView } from './turnFlowUi';
import classes from './AgentSessionView.module.css';

export interface CompactionDividerProps {
    compaction: TurnCompaction;
    /** The figures to show (`compactionDividerView`); `index` absent = no pass number. */
    view: CompactionDividerView;
    /** DOM id the "go to" links scroll to. */
    anchorId?: string;
    /**
     * The tool results to list as replaced. Without it the pass's own list is used, and a turn stored before
     * passes had their own lists passes its turn-level list for the last pass only.
     */
    compactedTools?: Array<{ toolName: string; toolCallId: string }>;
    defaultOpen?: boolean;
}

export default function CompactionDivider({ compaction, view, anchorId, compactedTools, defaultOpen = false }: CompactionDividerProps) {
    const t = useTranslations('agents.sessionFlow');
    const [open, setOpen] = useState(defaultOpen);
    const tools = compactedTools ?? compaction.compactedTools;
    const hasDetail = !view.pending && compactionHasDetail(compaction, tools);
    const tone = view.failed ? 'orange' : 'indigo';

    const before = view.tokensBefore !== undefined ? formatCompactTokens(view.tokensBefore) : undefined;
    const after = view.tokensAfter !== undefined ? formatCompactTokens(view.tokensAfter) : undefined;
    const shrink = before !== undefined && after !== undefined
        ? (view.savedPercent !== undefined
            ? t('compactionShrink', { before, after, change: compactionChangeLabel(view.savedPercent) })
            : `${before} → ${after}`)
        : undefined;
    const replaced = view.replacedTools
        ? (view.replacedTools === 1 ? t('compactionReplacedOne') : t('compactionReplaced', { count: view.replacedTools }))
        : undefined;

    const pill = (
        <>
            {view.pending ? <Loader size={11} color="indigo" /> : <IconArrowsMinimize size={13} />}
            {view.pending ? (
                <Text size="xs" fw={600}>{t('compactionPending')}</Text>
            ) : (
                <>
                    <Text size="xs" fw={600}>{view.failed ? t('compactionFallback') : t('compactionTitle')}</Text>
                    {view.index !== undefined ? <Text size="xs" c="dimmed">{t('compactionPass', { index: view.index })}</Text> : null}
                    {shrink ? <Text size="xs">{shrink}</Text> : null}
                    {view.durationMs !== undefined ? <Text size="xs" c="dimmed">{formatDuration(view.durationMs)}</Text> : null}
                    {replaced ? <Text size="xs" c="dimmed">{replaced}</Text> : null}
                    {hasDetail ? (open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />) : null}
                </>
            )}
        </>
    );

    return (
        <Box id={anchorId} className={classes.flowAnchor} data-testid="compaction-divider" data-pending={view.pending ? 'true' : undefined}>
            <Box className={classes.flowDivider}>
                <span className={classes.flowDividerLine} />
                {hasDetail ? (
                    <UnstyledButton
                        className={classes.flowDividerPill}
                        data-tone={tone}
                        onClick={() => setOpen((value) => !value)}
                        aria-expanded={open}
                        aria-label={open ? t('compactionHideDetails') : t('compactionDetails')}
                    >
                        {pill}
                    </UnstyledButton>
                ) : (
                    <Box className={classes.flowDividerPill} data-tone={tone}>{pill}</Box>
                )}
                <span className={classes.flowDividerLine} />
            </Box>
            {hasDetail ? (
                <Collapse in={open}>
                    <Box className={classes.flowDividerBody} data-tone={tone}>
                        <ContextCompactionBody compaction={compaction} compactedTools={tools} />
                    </Box>
                </Collapse>
            ) : null}
        </Box>
    );
}
