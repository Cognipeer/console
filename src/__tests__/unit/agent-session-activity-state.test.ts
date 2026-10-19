import { describe, expect, it } from 'vitest';
import {
    ACTIVE_RUNTIME_STATUSES,
    isRunInFlight,
    isSessionActive,
    isSessionOngoing,
} from '@/lib/services/agents/sessionActivityState';
import { SESSION_QUERY_PARAM, sessionInspectorHref } from '@/components/agents/session/sessionLinks';

describe('session activity state', () => {
    it('counts only queued and running runs as in flight', () => {
        expect(isRunInFlight({ status: 'queued' })).toBe(true);
        expect(isRunInFlight({ status: 'running' })).toBe(true);
        expect(isRunInFlight({ status: 'scheduled' })).toBe(false);
        expect(isRunInFlight({ status: 'requires_action' })).toBe(false);
        expect(isRunInFlight(null)).toBe(false);
        expect(isRunInFlight(undefined)).toBe(false);
    });

    it('calls a session ongoing while a turn runs or a run is in flight', () => {
        expect(isSessionOngoing({ runtimeStatus: 'running' })).toBe(true);
        expect(isSessionOngoing({ runtimeStatus: 'idle', activeRun: { status: 'queued' } })).toBe(true);
        expect(isSessionOngoing({ runtimeStatus: null, activeRun: { status: 'running' } })).toBe(true);
        // Held on a person or a budget: nothing changes until someone acts.
        expect(isSessionOngoing({ runtimeStatus: 'requires_action' })).toBe(false);
        expect(isSessionOngoing({ runtimeStatus: 'budget_paused' })).toBe(false);
        // A scheduled wait (a reminder, a deferred run) is not work in progress.
        expect(isSessionOngoing({ runtimeStatus: 'idle', activeRun: { status: 'scheduled' } })).toBe(false);
        expect(isSessionOngoing({})).toBe(false);
    });

    it('lists a session as active while ongoing or held', () => {
        for (const runtimeStatus of ACTIVE_RUNTIME_STATUSES) {
            expect(isSessionActive({ runtimeStatus })).toBe(true);
        }
        expect(isSessionActive({ runtimeStatus: 'idle', activeRun: { status: 'queued' } })).toBe(true);
        expect(isSessionActive({ runtimeStatus: 'idle' })).toBe(false);
        expect(isSessionActive({ runtimeStatus: undefined, activeRun: { status: 'scheduled' } })).toBe(false);
    });
});

describe('session links', () => {
    it('opens the inspector on the agent Sessions tab, ids encoded', () => {
        expect(sessionInspectorHref('a b', 'c/d')).toBe(`/dashboard/agents/a%20b?tab=sessions&${SESSION_QUERY_PARAM}=c%2Fd`);
        expect(SESSION_QUERY_PARAM).toBe('session');
    });
});
