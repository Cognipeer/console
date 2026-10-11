/**
 * Why a session page could not be shown, from the two answers it asked for (the
 * agent and the session): the session is not there ("not found") or it is there
 * and the person may not open it ("no access"). The page used to say "Session
 * not found" for both, which sends someone looking for a session that exists.
 */

export type SessionLoadFailure = 'forbidden' | 'notFound';

export function sessionLoadFailure(
    agent: { ok: boolean; status: number },
    session: { ok: boolean; status: number },
): SessionLoadFailure | null {
    if (agent.ok && session.ok) return null;
    // The session's own answer decides first: a 403 there is a refusal, a 404 is a missing session.
    if (session.status === 403) return 'forbidden';
    if (session.status === 404) return 'notFound';
    if (agent.status === 403) return 'forbidden';
    return 'notFound';
}
