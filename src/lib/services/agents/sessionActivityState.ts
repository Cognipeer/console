/**
 * Whether a session is doing something right now, as the Sessions lists ask it.
 *
 * Shared by the server (the Active list is filtered with it) and the console
 * (views of a session refresh while it holds), so both sides draw the line in
 * the same place. Pure: no database, no request.
 */

/** A session's newest run that is waiting for its time, queued or running — absent when there is none. */
export type SessionRunState = { status: string } | null | undefined;

export interface SessionActivitySubject {
    runtimeStatus?: string | null;
    activeRun?: SessionRunState;
}

/** Runtime statuses that keep a session in the Active list: a turn runs, or it is held on a person or its budget. */
export const ACTIVE_RUNTIME_STATUSES = ['running', 'requires_action', 'budget_paused'] as const;

/** A run that is executing or about to — a scheduled wait (a deferred run, a reminder) is not. */
export function isRunInFlight(run: SessionRunState): boolean {
    return run?.status === 'queued' || run?.status === 'running';
}

/** The session changes on its own right now, so whatever shows it refreshes. */
export function isSessionOngoing(row: SessionActivitySubject): boolean {
    return row.runtimeStatus === 'running' || isRunInFlight(row.activeRun);
}

/** In progress, or held until someone answers an approval or raises the budget: what the Active list shows. */
export function isSessionActive(row: SessionActivitySubject): boolean {
    return isSessionOngoing(row) || row.runtimeStatus === 'requires_action' || row.runtimeStatus === 'budget_paused';
}
