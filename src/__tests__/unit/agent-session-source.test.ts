import { describe, expect, it } from 'vitest';
import { isContinuableSession, sessionSourceLabel } from '@/components/agents/studio/SessionList';

describe('agent session source', () => {
    it('lets console and legacy (unsourced) sessions be continued', () => {
        expect(isContinuableSession('console')).toBe(true);
        expect(isContinuableSession(undefined)).toBe(true);
    });

    it('keeps real traffic read-only', () => {
        for (const source of ['api', 'a2a', 'schedule', 'evaluation', 'redteam']) {
            expect(isContinuableSession(source)).toBe(false);
        }
    });

    it('labels sources for the read-only notice', () => {
        expect(sessionSourceLabel('api')).toBe('API');
        expect(sessionSourceLabel('a2a')).toBe('A2A');
        expect(sessionSourceLabel(undefined)).toBe('unknown source');
        expect(sessionSourceLabel('something-new')).toBe('something-new');
    });
});
