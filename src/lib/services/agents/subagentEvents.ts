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
 * The stamp also travels on `AgentToolCallEvent.subagent` (see `subagentStampOf`).
 */

/** True for an event or stream chunk a delegated child produced. */
export function isSubagentEvent(event: object | null | undefined): boolean {
    if (!event) return false;
    const stamp = event as { subagentId?: unknown; subagentName?: unknown; delegatedTo?: unknown };
    return Boolean(stamp.subagentId || stamp.subagentName || stamp.delegatedTo);
}

/** Which sub-agent a forwarded event came from, or undefined for the parent's own. */
export function subagentStampOf(event: object | null | undefined): { id?: string; name: string } | undefined {
    if (!event) return undefined;
    const stamp = event as { subagentId?: unknown; subagentName?: unknown; delegatedTo?: unknown };
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const id = text(stamp.subagentId);
    const name = text(stamp.subagentName) ?? text(stamp.delegatedTo) ?? id;
    return name ? { ...(id ? { id } : {}), name } : undefined;
}

/** The SDK's delegation tools: a call to one of these hands a task to a sub-agent. */
const DELEGATION_TOOLS = new Set(['delegate_to', 'spawn_subagent', 'spawn_subagents_parallel']);

export function isDelegationTool(toolName: string | undefined): boolean {
    return Boolean(toolName && DELEGATION_TOOLS.has(toolName));
}

/**
 * Ids of the delegation calls a resumed state re-enters: the keys of the SDK's
 * `__subagentPending` (by parent tool call id), kept across pauses.
 */
export function resumedDelegationIds(state: { ctx?: unknown } | null | undefined): ReadonlySet<string> {
    const pending = (state?.ctx as { __subagentPending?: unknown } | undefined)?.__subagentPending;
    return new Set(pending && typeof pending === 'object' && !Array.isArray(pending) ? Object.keys(pending) : []);
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
    const given = (args ?? undefined) as { subagent?: unknown; role?: unknown } | undefined;
    if (typeof given?.subagent === 'string') return given.subagent;
    // `spawn_subagent` has no named child yet when it starts: the role it spawns is the label.
    return toolName === 'spawn_subagent' && typeof given?.role === 'string' && given.role ? given.role : undefined;
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

/**
 * Names the sub-agent on a trace step that records a tool approval or a question
 * of its child ("Approval requested · get_weather" alone reads as the parent's
 * own tool). `approvalSubagents` maps the SDK's approval / question id to the
 * child it came from, learned from the child's forwarded events. Returns the
 * label and metadata to store; the step itself is otherwise left as the SDK wrote it.
 */
export function nameSubagentOnApprovalStep(
    step: { type?: string; label?: string; sequence?: number; metadata?: Record<string, unknown>; sections?: unknown },
    approvalSubagents: ReadonlyMap<string, string>,
): { label?: string; metadata: Record<string, unknown> } {
    const metadata = { ...(step.metadata ?? {}) };
    if ((step.type !== 'tool_approval' && step.type !== 'user_question') || approvalSubagents.size === 0) return { label: step.label, metadata };
    const sections = Array.isArray(step.sections) ? (step.sections as Array<{ data?: Record<string, unknown> }>) : [];
    for (const section of sections) {
        const data = section?.data;
        const id = data && (typeof data.approvalId === 'string' ? data.approvalId : typeof data.questionId === 'string' ? data.questionId : undefined);
        const subagent = id ? approvalSubagents.get(id) : undefined;
        if (!subagent) continue;
        metadata.subagent = subagent;
        const suffix = typeof step.sequence === 'number' ? ` #${step.sequence}` : '';
        const label = step.label && suffix && step.label.endsWith(suffix)
            ? `${step.label.slice(0, -suffix.length)} (sub-agent ${subagent})${suffix}`
            : step.label ? `${step.label} (sub-agent ${subagent})` : step.label;
        return { label, metadata };
    }
    return { label: step.label, metadata };
}
