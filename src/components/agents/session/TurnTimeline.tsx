'use client';

/**
 * The turn strip above a session transcript: one segment per answer, sized
 * by how long that answer took, always exactly as wide as the panel.
 *
 * A new answer re-divides the same width rather than pushing the strip past
 * the edge — scrolling sideways to find the slow turn defeats the point of a
 * strip that exists to make the slow turn obvious at a glance.
 */

import { Box, Tooltip, UnstyledButton } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useEffect, useMemo, useState } from 'react';
import { formatDuration } from '@/lib/utils/tracingUtils';
import { stepFailed, type ChatMessage } from './sessionTypes';
import { layoutTimeline, pickSegmentLabel, turnLabelParts, turnTooltip } from './turnTimelineLayout';
import classes from './AgentSessionView.module.css';

/**
 * Zoom steps. The width is fixed to the panel, so zooming changes how tall
 * the strip is and how large its labels are — the thinnest step is a bare
 * bar with no labels at all.
 */
export const TIMELINE_ZOOM_LEVELS = [
    { height: 6, fontSize: 0 },
    { height: 16, fontSize: 10 },
    { height: 22, fontSize: 11 },
    { height: 30, fontSize: 12 },
] as const;
export const DEFAULT_TIMELINE_ZOOM = 2;

const LABEL_FONT_WEIGHT = 500;

export interface TurnTimelineEntry {
    index: number;
    message: ChatMessage;
}

interface TurnTimelineProps {
    entries: TurnTimelineEntry[];
    zoom: number;
    onSelect: (index: number) => void;
}

/**
 * Measures label text in the strip's own font, so a label is shown only when
 * it really fits. Re-measures once web fonts finish loading — measuring with
 * the fallback font would pick labels a pixel or two too wide.
 */
function useTextMeasurer(element: HTMLElement | null, fontSize: number) {
    const [fontsReady, setFontsReady] = useState(false);
    useEffect(() => {
        let active = true;
        if (typeof document === 'undefined' || !document.fonts) {
            setFontsReady(true);
            return;
        }
        void document.fonts.ready.then(() => {
            if (active) setFontsReady(true);
        });
        return () => {
            active = false;
        };
    }, []);

    return useMemo(() => {
        const fallback = (text: string) => text.length * fontSize * 0.62;
        if (!element || fontSize <= 0 || typeof document === 'undefined') return fallback;
        const context = document.createElement('canvas').getContext('2d');
        if (!context) return fallback;
        const family = window.getComputedStyle(element).fontFamily || 'sans-serif';
        context.font = `${LABEL_FONT_WEIGHT} ${fontSize}px ${family}`;
        const cache = new Map<string, number>();
        return (text: string) => {
            let width = cache.get(text);
            if (width === undefined) {
                width = Math.ceil(context.measureText(text).width);
                cache.set(text, width);
            }
            return width;
        };
        // fontsReady only triggers a re-measure once fonts have loaded.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [element, fontSize, fontsReady]);
}

export default function TurnTimeline({ entries, zoom, onSelect }: TurnTimelineProps) {
    // Measured on the track, inside the strip's padding: that is the width
    // the segments and gaps must add up to.
    const { ref, width } = useElementSize<HTMLDivElement>();
    const [trackElement, setTrackElement] = useState<HTMLDivElement | null>(null);
    const level = TIMELINE_ZOOM_LEVELS[Math.min(Math.max(zoom, 0), TIMELINE_ZOOM_LEVELS.length - 1)];
    const measure = useTextMeasurer(trackElement, level.fontSize);

    const durations = useMemo(() => entries.map(({ message }) => message.latencyMs ?? 0), [entries]);
    const layout = useMemo(() => layoutTimeline(durations, width), [durations, width]);

    return (
        <Box px="xs" py={6} className={classes.timelineStrip}>
            <div
                ref={(node) => {
                    ref.current = node;
                    setTrackElement(node);
                }}
                className={classes.timelineTrack}
                style={{ gap: layout.gap, height: level.height }}
            >
                {entries.map(({ index, message }, position) => {
                    const failed = message.role === 'error'
                        || Boolean(message.stopReason)
                        || Boolean(message.steps?.some(stepFailed));
                    const toolCalls = message.steps?.length ?? 0;
                    const duration = formatDuration(message.latencyMs);
                    const segmentWidth = layout.widths[position] ?? 0;
                    const details = turnTooltip(position + 1, duration, toolCalls, failed);
                    const label = level.fontSize > 0
                        ? pickSegmentLabel(segmentWidth, turnLabelParts(duration, toolCalls), measure)
                        : null;
                    return (
                        <Tooltip key={index} withArrow label={details}>
                            <UnstyledButton
                                aria-label={details}
                                onClick={() => onSelect(index)}
                                className={`${classes.timelineSegment} ${failed ? classes.timelineSegmentFailed : ''}`}
                                style={{
                                    width: segmentWidth,
                                    height: level.height,
                                    fontSize: level.fontSize || undefined,
                                    fontWeight: LABEL_FONT_WEIGHT,
                                }}
                            >
                                {label ? <span className={classes.timelineLabel}>{label}</span> : null}
                            </UnstyledButton>
                        </Tooltip>
                    );
                })}
            </div>
        </Box>
    );
}
