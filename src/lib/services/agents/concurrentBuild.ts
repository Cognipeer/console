/**
 * Helpers for the places where a turn starts several independent reads or builders at once and still has to
 * behave exactly like the serial code it replaced: the same error wins, the same warnings come out in the same
 * order, and nothing is left running un-awaited.
 */

type Settled<T extends readonly unknown[] | []> = { -readonly [P in keyof T]: Awaited<T[P]> };

/**
 * Waits for EVERY promise to settle, then answers like `Promise.all` would have if the promises had been awaited one
 * after the other: the values in order, or the rejection of the FIRST promise in list order (not the first to fail
 * in time). Nothing is left pending when it returns, so the caller can clean up whatever the fulfilled ones built.
 */
export async function settleInOrder<T extends readonly unknown[] | []>(
    promises: T,
): Promise<{ ok: true; values: Settled<T> } | { ok: false; reason: unknown }> {
    const settled = await Promise.allSettled(promises as readonly unknown[]);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) return { ok: false, reason: failure.reason };
    return { ok: true, values: settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as Settled<T> };
}

/**
 * Same as `Promise.all`, except that when several promises reject, the one that is reported is the first in list
 * order (what a serial loop would have thrown), and no promise is left running when it throws.
 */
export async function allInOrder<T extends readonly unknown[] | []>(promises: T): Promise<Settled<T>> {
    const result = await settleInOrder(promises);
    if (!result.ok) throw result.reason;
    return result.values;
}

/**
 * Marks a promise as handled without changing it: used on a read that was started early and may never be awaited
 * (an earlier check threw first), so its failure is not reported as an unhandled rejection. Awaiting the returned
 * promise still throws as usual.
 */
export function started<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => undefined);
    return promise;
}

/**
 * Warnings of a builder that runs next to others: held back while it builds, so they join the run's warnings at
 * the point where the serial code used to emit them, then passed straight through (a builder may warn again while
 * the run is going).
 */
export function deferredWarnings(sink: Set<string>): { add: (message: string) => void; release: () => void } {
    let held: string[] | undefined = [];
    return {
        add(message) {
            if (held) held.push(message);
            else sink.add(message);
        },
        release() {
            const pending = held ?? [];
            held = undefined;
            for (const message of pending) sink.add(message);
        },
    };
}
