/**
 * Playground step extraction: the tool-call steps of a run, in the dashboard playground's shape, and the structured-output error text.
 */

import type { AgentInvokeResult as AgentSdkInvokeResult } from '@cognipeer/agent-sdk';
import { delegatedSubagentName, delegationFailure } from './subagentEvents';
import { type HitlCallLog } from './agentHitlExceptions';
import { type AgentPlaygroundStep } from './agentChatTypes';
import { agentMessageText } from './agentGuardrails';

/**
 * Flattens the SDK's tool history into the playground's step list.
 *
 * Reads `state.toolHistory` rather than the event stream: the history survives
 * summarization (the archived entry keeps its `executionId`), so a long run
 * still shows every call it made instead of only the ones after the last
 * compaction.
 *
 * Carries the whole entry, not just name/args/output. Two of those fields
 * change what the playground is actually showing you:
 *
 *  - `output` is what the MODEL saw, which under the console's default
 *    `summarize_archive` retention can be a compaction of the real result.
 *    `rawOutput` is the result itself, kept whenever the two differ, so
 *    "what did this tool return" and "what did the model get to read" stop
 *    being the same question with one answer.
 *  - `status` is the SDK's own verdict. Inferring it by sniffing the output
 *    for an `error` key — what this did before — both missed a guardrail
 *    `rejected` call and flagged any tool whose successful result happens to
 *    carry a field called `error`.
 */
/** EXPORTED FOR TESTS — see the failure rules above. */
export function extractPlaygroundSteps(
    result: AgentSdkInvokeResult,
    /**
     * Execution ids the run STARTED with. A turn resumed from a stored state
     * carries the earlier turns' tool history; those calls belong to the turns
     * that made them, not to this one.
     */
    priorExecutionIds?: ReadonlySet<string>,
    /** What the approval gates decided: a call an exception let through or refused names the rule. */
    hitlLog?: Pick<HitlCallLog, 'ruleFor'>,
): AgentPlaygroundStep[] {
    const history = (result.state as { toolHistory?: Array<Record<string, unknown>> } | undefined)?.toolHistory;
    if (!Array.isArray(history)) return [];

    // Calls an approval answered "deny" (the SDK marks the approval `rejected` and the call
    // `rejected` too): a decision, not a failure. A call a guardrail blocked is also `rejected`
    // in the history but has no approval behind it.
    const deniedCallIds = new Set<string>();
    const approvals = (result.state as { pendingApprovals?: Array<{ toolCallId?: unknown; metadata?: { resolution?: unknown } }> } | undefined)?.pendingApprovals;
    for (const approval of Array.isArray(approvals) ? approvals : []) {
        if (approval?.metadata?.resolution === 'rejected' && typeof approval.toolCallId === 'string') deniedCallIds.add(approval.toolCallId);
    }

    // tool_call_id → the text of the assistant message that issued it.
    const narrations = new Map<string, string>();
    const messages = (result.state as { messages?: unknown[] } | undefined)?.messages;
    for (const message of Array.isArray(messages) ? messages : []) {
        const m = message as { role?: unknown; _getType?: () => string; content?: unknown; tool_calls?: Array<{ id?: unknown }> };
        const role = typeof m?.role === 'string' ? m.role : m?._getType?.();
        if ((role !== 'assistant' && role !== 'ai') || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
        const text = agentMessageText(m.content).trim();
        const firstId = m.tool_calls[0]?.id;
        if (text && typeof firstId === 'string') narrations.set(firstId, text);
    }

    return history
        .filter((entry) => !(priorExecutionIds && typeof entry.executionId === 'string' && priorExecutionIds.has(entry.executionId)))
        .map((entry) => {
        const output = entry.output;
        const status = typeof entry.status === 'string'
            ? entry.status as AgentPlaygroundStep['status']
            : undefined;
        // The SDK records `status: 'error'` only when a tool THROWS. A tool
        // that catches its own failure and returns `{ ok: false, error }`
        // instead — `web_search` does — is recorded as a success, so status
        // alone would show a failed search as a green tick. The payload check
        // therefore SUPPLEMENTS status rather than being its fallback.
        //
        // Narrow on purpose: a truthy `error`, or an explicit `ok: false`. An
        // `error: null` field, which plenty of successful results carry, is
        // not a failure, and treating it as one is what made sniffing
        // untrustworthy in the first place.
        const record = output !== null && typeof output === 'object'
            ? output as Record<string, unknown>
            : undefined;
        const delegationError = delegationFailure(typeof entry.toolName === 'string' ? entry.toolName : undefined, output);
        const sniffedError = Boolean(record?.error) || record?.ok === false || Boolean(delegationError);
        const deniedByUser = status === 'rejected' && (
            (typeof entry.tool_call_id === 'string' && deniedCallIds.has(entry.tool_call_id))
            // The SDK words a reviewer's refusal `Rejected: <comment>`; a policy block carries its own reason.
            || (typeof output === 'string' && output.startsWith('Rejected: ') && entry.rawOutput === null)
        );
        const failed = !deniedByUser && (status === 'error' || status === 'rejected' || sniffedError);
        const errorText = failed
            ? (status === 'rejected' ? 'Blocked before the tool ran.' : undefined)
                ?? (record?.error ? String(record.error) : undefined)
                ?? delegationError
                ?? 'The tool call failed.'
            : undefined;

        // The history entry names no child; the delegation call's own result does.
        const subagentOf = typeof entry.subagent === 'string'
            ? entry.subagent
            : delegatedSubagentName(typeof entry.toolName === 'string' ? entry.toolName : undefined, entry.args, output);

        const rawOutput = entry.rawOutput;
        const rawDiffers = rawOutput !== undefined && rawOutput !== output;

        // A step is named by the call the model made (`tool_call_id`, the id on the live events), not by the
        // SDK's random `executionId`: the plan versions, sub-agent runs and summarization passes of the turn
        // anchor on the call id, and a step that carried another id would match none of them.
        const callId = typeof entry.tool_call_id === 'string' && entry.tool_call_id ? entry.tool_call_id : undefined;
        const approvalRule = hitlLog?.ruleFor(typeof entry.toolName === 'string' ? entry.toolName : undefined, entry.args);
        // A blocked call reports the rule, not a generic failure.
        const blockedText = approvalRule?.action === 'deny' && typeof output === 'string'
            ? output.replace(/^Error executing tool:\s*/, '')
            : undefined;

        return {
            id: callId ?? (typeof entry.executionId === 'string' ? entry.executionId : undefined),
            name: typeof entry.toolName === 'string' ? entry.toolName : 'tool',
            args: entry.args,
            output,
            ...(rawDiffers ? { rawOutput } : {}),
            ...(errorText ? { error: blockedText ?? errorText } : {}),
            ...(subagentOf ? { subagent: subagentOf } : {}),
            ...(approvalRule ? { approvalRule } : {}),
            // Reported as an error even when the SDK called it a success,
            // so the transcript, the Events tab and the per-tool failure
            // count all agree with the error text above.
            ...(failed ? { status: 'error' as const } : status ? { status } : {}),
            ...(deniedByUser ? { deniedByUser: true } : {}),
            ...(entry.fromCache === true ? { fromCache: true } : {}),
            ...(entry.summarized === true ? { summarized: true } : {}),
            ...(typeof entry.originalTokenCount === 'number'
                ? { originalTokenCount: entry.originalTokenCount }
                : {}),
            ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
            ...(typeof entry.tool_call_id === 'string' && narrations.has(entry.tool_call_id)
                ? { narration: narrations.get(entry.tool_call_id) }
                : {}),
        };
    });
}

export function describeStructuredOutputError(error: unknown): string {
    if (typeof error === 'string') return error;
    const record = error as { message?: unknown; issues?: unknown } | null;
    if (record && typeof record.message === 'string') return record.message;
    return JSON.stringify(error);
}
