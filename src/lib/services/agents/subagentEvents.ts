/**
 * What the SDK forwards from a delegated child, and how a turn tells it from its own.
 *
 * A sub-agent runs a loop of its own, and the SDK passes the child's events and
 * stream chunks up to the parent's host stamped with where they came from:
 * `subagentId` / `subagentName` (and `delegatedTo` for an `asTool` child). The
 * parent's own events carry none of them.
 *
 * A turn's answer text, its reasoning and its compactions belong to the parent's
 * transcript alone, so each of those asks `isSubagentEvent` before it takes a
 * forwarded event as its own: a child's thinking is not the parent's thinking, and
 * a child compacting its own context did not shorten the parent's messages.
 */

/** True for an event or stream chunk a delegated child produced. */
export function isSubagentEvent(event: object | null | undefined): boolean {
    if (!event) return false;
    const stamp = event as { subagentId?: unknown; subagentName?: unknown; delegatedTo?: unknown };
    return Boolean(stamp.subagentId || stamp.subagentName || stamp.delegatedTo);
}
