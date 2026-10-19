/**
 * Following a turn that someone else started (or that this page did not start):
 * `GET …/sessions/:id/events/stream` speaks the session event log, not the
 * `/chat/stream` dialect the transcript's own turns arrive in. This turns one
 * frame of the former into the update the live view applies, so the live view
 * renders a followed turn exactly like one it ran itself.
 *
 * The SSE `event:` name is the event type and `data:` is the whole frame
 * (`{ seq, type, data, createdAt }`) — see `followSessionEvents`.
 */

export type FollowStep =
    /** `reminder`: the turn is a reminder waking the session — `content` is the framed note the model read. */
    | { kind: 'user'; content: string; reminder?: { message: string; setAt?: string } }
    | {
        kind: 'tool';
        event: { phase: 'start' | 'success' | 'error'; name: string; id?: string; args?: unknown; durationMs?: number; error?: string };
    }
    | { kind: 'text'; text: string }
    | { kind: 'reasoning'; text: string }
    | { kind: 'compaction'; compaction: Record<string, unknown> }
    /** The turn stopped; `stopReason` is the session's (`end_turn`, `requires_action`, …). */
    | { kind: 'idle'; stopReason?: string }
    | { kind: 'error'; message: string }
    | { kind: 'ignore' };

const IGNORE: FollowStep = { kind: 'ignore' };

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

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
                    },
                }
                : IGNORE;
        case 'agent.message.delta':
            return typeof data.text === 'string' ? { kind: 'text', text: data.text } : IGNORE;
        case 'agent.reasoning.delta':
            return typeof data.text === 'string' ? { kind: 'reasoning', text: data.text } : IGNORE;
        case 'agent.compaction':
            return { kind: 'compaction', compaction: data };
        case 'session.status_idle':
            return { kind: 'idle', ...(typeof data.stopReason === 'string' ? { stopReason: data.stopReason } : {}) };
        case 'session.error':
            return { kind: 'error', message: typeof data.message === 'string' ? data.message : 'The run failed' };
        default:
            return IGNORE;
    }
}
