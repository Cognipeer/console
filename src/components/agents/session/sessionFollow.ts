/**
 * Following a turn that someone else started (or that this page did not start):
 * `GET …/sessions/:id/events/stream` speaks the session event log, not the
 * `/chat/stream` dialect the transcript's own turns arrive in. This turns one
 * frame of the former into the update the live view applies, so the live view
 * renders a followed turn exactly like one it ran itself.
 *
 * The SSE `event:` name is the event type and `data:` is the whole frame
 * (`{ seq, type, data, createdAt }`) — see `followSessionEvents`.
 *
 * The result is what the live reducers in `liveFlow.ts` take: `tool` →
 * `applyLiveToolEvent`, `plan` → `applyLivePlan`, `subagent` →
 * `applyLiveSubagent`, `compaction` → `applyLiveCompaction`, `text` /
 * `reasoning` → `appendLiveText` / `appendLiveReasoning`.
 */

import {
    isDelegationTool,
    type AgentCompactionEvent,
    type AgentPlanEvent,
    type AgentSubagentEvent,
    type AgentToolCallSubagentStamp,
} from '@/lib/shared/agentTurnFlow';

export type FollowStep =
    /** `reminder`: the turn is a reminder waking the session — `content` is the framed note the model read. */
    | { kind: 'user'; content: string; reminder?: { message: string; setAt?: string } }
    | {
        kind: 'tool';
        event: {
            phase: 'start' | 'success' | 'error';
            name: string;
            id?: string;
            args?: unknown;
            durationMs?: number;
            error?: string;
            /** Set on a call a sub-agent made (the log row's `subagentId`, with its `subagent` name, `parentToolCallId`, `parallel`); never on a delegation call. */
            subagent?: AgentToolCallSubagentStamp;
        };
    }
    | { kind: 'text'; text: string }
    | { kind: 'reasoning'; text: string }
    /** A summarization pass; one a sub-agent made carries `subagent` and belongs in its group. */
    | { kind: 'compaction'; compaction: AgentCompactionEvent }
    /** `agent.plan`: one plan version the agent wrote. */
    | { kind: 'plan'; plan: AgentPlanEvent }
    /** `agent.subagent`: one lifecycle step of a sub-agent. */
    | { kind: 'subagent'; event: AgentSubagentEvent }
    /** The turn stopped; `stopReason` is the session's (`end_turn`, `requires_action`, …). */
    | { kind: 'idle'; stopReason?: string }
    | { kind: 'error'; message: string }
    | { kind: 'ignore' };

const IGNORE: FollowStep = { kind: 'ignore' };

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Who made a tool call, from its log row: `subagentId` (or the `id` of the
 * nested `{ id, name }`) says which sub-agent, `subagent` is its name, and
 * `parentToolCallId` and `parallel` come beside them on rows written since runs
 * were grouped. No stamp unless the row names the sub-agent by id, and none on a
 * delegation call: the log writes the name of the sub-agent a task was handed to
 * on the agent's OWN delegation rows (no id), and a child cannot delegate, so
 * reading that name as a stamp would make the delegation call the call of a
 * sub-agent and open a second, ghost run beside the real one.
 */
function subagentStampOf(toolName: string, data: Record<string, unknown>): AgentToolCallSubagentStamp | undefined {
    if (isDelegationTool(toolName)) return undefined;
    const nested = asRecord(data.subagent);
    const id = typeof data.subagentId === 'string' && data.subagentId
        ? data.subagentId
        : typeof nested.id === 'string' && nested.id ? nested.id : undefined;
    if (!id) return undefined;
    const name = typeof data.subagent === 'string' && data.subagent
        ? data.subagent
        : typeof nested.name === 'string' && nested.name ? nested.name : id;
    return {
        id,
        name,
        ...(typeof data.parentToolCallId === 'string' ? { parentToolCallId: data.parentToolCallId } : {}),
        ...(data.parallel === true ? { parallel: true } : {}),
    };
}

/** `{ subagent }` for a row a sub-agent's call wrote, nothing otherwise - spread into the event. */
function stampPart(toolName: string, data: Record<string, unknown>): { subagent?: AgentToolCallSubagentStamp } {
    const subagent = subagentStampOf(toolName, data);
    return subagent ? { subagent } : {};
}

const SUBAGENT_PHASES = new Set(['start', 'result', 'error', 'paused']);

/**
 * One frame of the session event log as the update the live view applies.
 * `ignore` for a type the live view does not draw and for a frame that does not
 * have the shape the type promises.
 */
export function interpretSessionEvent(event: string, frame: unknown): FollowStep {
    const data = asRecord(asRecord(frame).data);
    switch (event) {
        case 'user.message': {
            if (typeof data.content !== 'string') return IGNORE;
            const reminder = asRecord(data.reminder);
            return data.origin === 'reminder' && typeof reminder.message === 'string'
                ? {
                    kind: 'user',
                    content: data.content,
                    reminder: { message: reminder.message, ...(typeof reminder.setAt === 'string' ? { setAt: reminder.setAt } : {}) },
                }
                : { kind: 'user', content: data.content };
        }
        case 'agent.tool_use':
            return typeof data.name === 'string'
                ? {
                    kind: 'tool',
                    event: {
                        phase: 'start',
                        name: data.name,
                        ...(typeof data.toolCallId === 'string' ? { id: data.toolCallId } : {}),
                        ...(data.args !== undefined ? { args: data.args } : {}),
                        ...stampPart(data.name, data),
                    },
                }
                : IGNORE;
        case 'agent.tool_result':
            return typeof data.name === 'string'
                ? {
                    kind: 'tool',
                    event: {
                        phase: data.ok === false ? 'error' : 'success',
                        name: data.name,
                        ...(typeof data.toolCallId === 'string' ? { id: data.toolCallId } : {}),
                        ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
                        ...(typeof data.error === 'string' ? { error: data.error } : {}),
                        ...stampPart(data.name, data),
                    },
                }
                : IGNORE;
        case 'agent.message.delta':
            return typeof data.text === 'string' ? { kind: 'text', text: data.text } : IGNORE;
        case 'agent.reasoning.delta':
            return typeof data.text === 'string' ? { kind: 'reasoning', text: data.text } : IGNORE;
        case 'agent.compaction':
            return { kind: 'compaction', compaction: data as unknown as AgentCompactionEvent };
        case 'agent.plan':
            return typeof data.version === 'number' && Array.isArray(data.steps)
                ? { kind: 'plan', plan: data as unknown as AgentPlanEvent }
                : IGNORE;
        case 'agent.subagent':
            return typeof data.id === 'string' && typeof data.name === 'string' && typeof data.phase === 'string' && SUBAGENT_PHASES.has(data.phase)
                ? { kind: 'subagent', event: data as unknown as AgentSubagentEvent }
                : IGNORE;
        case 'session.status_idle':
            return { kind: 'idle', ...(typeof data.stopReason === 'string' ? { stopReason: data.stopReason } : {}) };
        case 'session.error':
            return { kind: 'error', message: typeof data.message === 'string' ? data.message : 'The run failed' };
        default:
            return IGNORE;
    }
}
