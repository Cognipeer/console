'use client';

import { useEffect, useState } from 'react';

/**
 * The current time in milliseconds, renewed every `intervalMs` while `active`. For a screen whose answer changes with
 * the clock alone (a job that has been waiting long enough to be taken for lost); `active: false` stops the timer.
 */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
