/**
 * Lays out the turn strip above a session transcript so it always fits the
 * width it is given.
 *
 * Every segment's width is proportional to its turn's duration, but a turn
 * that took 50ms next to one that took two minutes would otherwise vanish, so
 * each segment gets a floor. Segments pinned to the floor are taken out of the
 * proportional share and the rest is re-divided among the others — the same
 * "freeze and redistribute" pass flexbox does for `min-width` — which keeps
 * the proportions between every un-pinned segment exact and the total equal
 * to the available width, however many turns there are.
 */

/** The narrowest a segment is drawn while there is room for that. */
export const TIMELINE_MIN_SEGMENT_PX = 4;

export interface TimelineLayout {
    /** One width per duration, in the same order, in pixels. */
    widths: number[];
    /** Space between neighbouring segments, in pixels. */
    gap: number;
}

/** Tighter gaps as the strip fills up, so gaps never eat the segments. */
export function timelineGap(count: number, availableWidth: number): number {
    if (count <= 1) return 0;
    const perSegment = availableWidth / count;
    if (perSegment >= 12) return 2;
    if (perSegment >= 5) return 1;
    return 0;
}

export function layoutTimeline(durationsMs: number[], availableWidth: number): TimelineLayout {
    const count = durationsMs.length;
    const width = Math.max(0, availableWidth);
    if (count === 0 || width === 0) return { widths: durationsMs.map(() => 0), gap: 0 };

    const gap = timelineGap(count, width);
    const usable = Math.max(0, width - gap * (count - 1));
    const floor = Math.min(TIMELINE_MIN_SEGMENT_PX, usable / count);
    const weights = durationsMs.map((ms) => (Number.isFinite(ms) && ms > 0 ? ms : 0));

    const pinned = new Array<boolean>(count).fill(false);
    let pinnedCount = 0;
    for (;;) {
        const remaining = usable - pinnedCount * floor;
        const totalWeight = weights.reduce((sum, weight, i) => (pinned[i] ? sum : sum + weight), 0);
        if (totalWeight === 0) {
            // Nothing left with a measurable duration: share what is left equally.
            const share = (count - pinnedCount) > 0 ? remaining / (count - pinnedCount) : 0;
            return { widths: weights.map((_, i) => (pinned[i] ? floor : share)), gap };
        }
        const scale = remaining / totalWeight;
        let changed = false;
        weights.forEach((weight, i) => {
            if (!pinned[i] && weight * scale < floor) {
                pinned[i] = true;
                pinnedCount += 1;
                changed = true;
            }
        });
        if (!changed) {
            return { widths: weights.map((weight, i) => (pinned[i] ? floor : weight * scale)), gap };
        }
    }
}

/** Horizontal padding a segment keeps around its label, per side. */
export const TIMELINE_LABEL_PADDING_PX = 4;

export function formatToolCallCount(count: number): string {
    return `${count} tool call${count === 1 ? '' : 's'}`;
}

export interface TurnLabelParts {
    /** e.g. `45.7s · 2 tool calls` — shown when the segment is wide enough. */
    full: string;
    /** e.g. `45.7s` — the fallback for a narrower segment. */
    duration: string;
}

export function turnLabelParts(duration: string, toolCalls: number): TurnLabelParts {
    return { full: `${duration} · ${formatToolCallCount(toolCalls)}`, duration };
}

/** What the hover card says about a turn, whatever fits inside the segment. */
export function turnTooltip(turnNumber: number, duration: string, toolCalls: number, failed: boolean): string {
    return [`Turn ${turnNumber}`, duration, formatToolCallCount(toolCalls), ...(failed ? ['Failed'] : [])].join(' · ');
}

/**
 * The longest label that fits inside a segment of `segmentWidth` pixels:
 * duration and tool calls, then the duration alone, then nothing.
 */
export function pickSegmentLabel(
    segmentWidth: number,
    parts: TurnLabelParts,
    measure: (text: string) => number,
): string | null {
    const room = segmentWidth - TIMELINE_LABEL_PADDING_PX * 2;
    if (room <= 0) return null;
    if (measure(parts.full) <= room) return parts.full;
    if (measure(parts.duration) <= room) return parts.duration;
    return null;
}
