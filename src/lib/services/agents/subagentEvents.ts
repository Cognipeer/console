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

/** The SDK's delegation tools: a call to one of these hands a task to a sub-agent. */
const DELEGATION_TOOLS = new Set(['delegate_to', 'spawn_subagent', 'spawn_subagents_parallel']);

export function isDelegationTool(toolName: string | undefined): boolean {
    return Boolean(toolName && DELEGATION_TOOLS.has(toolName));
}

const FAILED_CHILD = new Set(['error', 'cancelled']);

type ChildResult = { name?: unknown; status?: unknown; error?: unknown; note?: unknown };

function childResults(output: unknown): ChildResult[] {
    if (!output || typeof output !== 'object') return [];
    const record = output as { results?: unknown };
    if (Array.isArray(record.results)) return record.results.filter((r): r is ChildResult => Boolean(r) && typeof r === 'object');
    return [output as ChildResult];
}

/**
 * Which sub-agent(s) a delegation call handed its task to, read from what the call
 * returned (`delegate_to` / `spawn_subagent`: one result; the parallel tool: one
 * per task) so a step can say "via <sub-agent>". Undefined for any other tool.
 */
export function delegatedSubagentName(toolName: string | undefined, args: unknown, output: unknown): string | undefined {
    if (!isDelegationTool(toolName)) return undefined;
    const names = [...new Set(childResults(output).map((r) => (typeof r.name === 'string' && r.name !== '?' ? r.name : undefined)).filter(Boolean))];
    if (names.length > 0) return names.join(', ');
    const named = (args as { subagent?: unknown } | null | undefined)?.subagent;
    return typeof named === 'string' ? named : undefined;
}

/**
 * Why a delegation call failed, when it did: the child came back `error` /
 * `cancelled`, or every task of a parallel call did. Some of a parallel call's
 * tasks failing is a result the model can use, not a failed call.
 */
export function delegationFailure(toolName: string | undefined, output: unknown): string | undefined {
    if (!isDelegationTool(toolName)) return undefined;
    const results = childResults(output);
    if (results.length === 0) return undefined;
    const failed = (r: ChildResult) => FAILED_CHILD.has(String(r.status)) || (r.status === undefined && Boolean(r.error));
    if (!results.every(failed)) return undefined;
    const first = results[0];
    const why = [first.error, first.note, first.status].find((v) => typeof v === 'string' && v) as string | undefined;
    return results.length > 1 ? `All ${results.length} sub-agent tasks failed: ${why ?? 'failed'}` : why ?? 'The sub-agent failed.';
}
