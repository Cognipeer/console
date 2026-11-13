/**
 * Shutdown order: handlers run last-registered first, and a handler registered
 * with `first` runs before all the others whenever it was registered (the
 * agent-run drain must not wait behind a flush registered later).
 */

import { describe, expect, it } from 'vitest';

import { shutdownHandlerOrder } from '@/lib/core/lifecycle';

describe('shutdown handler order', () => {
    it('runs handlers last-registered first', () => {
        expect(shutdownHandlerOrder([{ name: 'database' }, { name: 'queue' }, { name: 'http-server' }]))
            .toEqual(['http-server', 'queue', 'database']);
    });

    it('runs a `first` handler before the others, even one registered after it', () => {
        expect(shutdownHandlerOrder([
            { name: 'database' },
            { name: 'agent-runs', first: true },
            { name: 'queue' },
            // Registered lazily, on the first usage event: without `first` it ran before the drain.
            { name: 'usage-rollup' },
        ])).toEqual(['agent-runs', 'usage-rollup', 'queue', 'database']);
    });
});
