/** Abort-signal helpers shared by the extraction engine and its OCR handlers. */

export interface LinkedSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** One signal that aborts when any of `signals` does (AbortSignal.any is newer than the Node versions we run on). */
export function linkSignals(...signals: Array<AbortSignal | undefined>): LinkedSignal {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const source of signals) {
    if (!source) continue;
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    const onAbort = () => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => source.removeEventListener('abort', onAbort));
  }
  return { signal: controller.signal, dispose: () => listeners.forEach((remove) => remove()) };
}
