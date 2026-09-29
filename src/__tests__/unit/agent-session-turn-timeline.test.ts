import { describe, expect, it } from 'vitest';
import {
    formatToolCallCount,
    layoutTimeline,
    pickSegmentLabel,
    TIMELINE_LABEL_PADDING_PX,
    TIMELINE_MIN_SEGMENT_PX,
    turnLabelParts,
    turnTooltip,
} from '@/components/agents/session/turnTimelineLayout';

const total = ({ widths, gap }: { widths: number[]; gap: number }) =>
    widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);

describe('layoutTimeline', () => {
    it('fills exactly the available width with a single turn', () => {
        const layout = layoutTimeline([1200], 640);
        expect(layout.widths).toEqual([640]);
        expect(layout.gap).toBe(0);
    });

    it('keeps the proportions between turns', () => {
        const layout = layoutTimeline([1000, 3000, 2000], 600);
        expect(total(layout)).toBeCloseTo(600, 6);
        const [a, b, c] = layout.widths;
        expect(b / a).toBeCloseTo(3, 6);
        expect(c / a).toBeCloseTo(2, 6);
    });

    it('stays within the same width as turns keep arriving', () => {
        const width = 720;
        const durations: number[] = [];
        for (let turn = 0; turn < 500; turn += 1) {
            durations.push(((turn * 7919) % 45_000) + 50);
            const layout = layoutTimeline(durations, width);
            expect(layout.widths).toHaveLength(durations.length);
            expect(total(layout)).toBeLessThanOrEqual(width + 1e-6);
            expect(total(layout)).toBeGreaterThan(width - 1e-6);
            expect(layout.widths.every((w) => w > 0)).toBe(true);
        }
    });

    it('keeps short turns visible and the rest proportional', () => {
        const layout = layoutTimeline([10, 60_000, 30_000], 300);
        expect(layout.widths[0]).toBeCloseTo(TIMELINE_MIN_SEGMENT_PX, 6);
        expect(layout.widths[1] / layout.widths[2]).toBeCloseTo(2, 6);
        expect(total(layout)).toBeCloseTo(300, 6);
    });

    it('shares the width equally when no turn has a duration', () => {
        const layout = layoutTimeline([0, 0, 0, 0], 400);
        expect(total(layout)).toBeCloseTo(400, 6);
        expect(new Set(layout.widths.map((w) => w.toFixed(6))).size).toBe(1);
    });

    it('never exceeds the width when there are more turns than pixels', () => {
        const layout = layoutTimeline(Array.from({ length: 2000 }, (_, i) => (i % 5) * 1000), 500);
        expect(layout.gap).toBe(0);
        expect(total(layout)).toBeLessThanOrEqual(500 + 1e-6);
    });

    it('returns zero widths before the strip has been measured', () => {
        expect(layoutTimeline([1000, 2000], 0)).toEqual({ widths: [0, 0], gap: 0 });
        expect(layoutTimeline([], 500)).toEqual({ widths: [], gap: 0 });
    });
});

describe('turn labels', () => {
    // A monospace stand-in for canvas measurement: 6px per character.
    const measure = (text: string) => text.length * 6;
    const pad = TIMELINE_LABEL_PADDING_PX * 2;

    it('counts tool calls, including none and one', () => {
        expect(formatToolCallCount(0)).toBe('0 tool calls');
        expect(formatToolCallCount(1)).toBe('1 tool call');
        expect(formatToolCallCount(2)).toBe('2 tool calls');
    });

    it('always puts turn number, duration and tool calls in the tooltip', () => {
        expect(turnTooltip(1, '45.7s', 2, false)).toBe('Turn 1 · 45.7s · 2 tool calls');
        expect(turnTooltip(7, '850ms', 0, false)).toBe('Turn 7 · 850ms · 0 tool calls');
        expect(turnTooltip(3, '1.2m', 1, true)).toBe('Turn 3 · 1.2m · 1 tool call · Failed');
    });

    it('shows duration and tool calls in a wide segment', () => {
        const parts = turnLabelParts('45.7s', 2);
        expect(parts.full).toBe('45.7s · 2 tool calls');
        expect(pickSegmentLabel(measure(parts.full) + pad, parts, measure)).toBe('45.7s · 2 tool calls');
        expect(pickSegmentLabel(400, turnLabelParts('3.1s', 0), measure)).toBe('3.1s · 0 tool calls');
    });

    it('falls back to the duration, then to nothing, as the segment narrows', () => {
        const parts = turnLabelParts('45.7s', 2);
        expect(pickSegmentLabel(measure(parts.full) + pad - 1, parts, measure)).toBe('45.7s');
        expect(pickSegmentLabel(measure('45.7s') + pad, parts, measure)).toBe('45.7s');
        expect(pickSegmentLabel(measure('45.7s') + pad - 1, parts, measure)).toBeNull();
        expect(pickSegmentLabel(TIMELINE_MIN_SEGMENT_PX, parts, measure)).toBeNull();
        expect(pickSegmentLabel(0, parts, measure)).toBeNull();
    });
});
