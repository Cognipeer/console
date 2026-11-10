/**
 * Hourly peaks of the capacity dimensions, for the usage page ("24 h peak").
 * Kept in process, written to the main DB only when the hour's maximum grows,
 * at most once a minute per key.
 */
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';

const log = createLogger('limits:peaks');

const WRITE_EVERY_MS = 60_000;
const MAX_STATES = 10_000;
const DIMENSION_RE = /^[a-zA-Z0-9_]{1,64}$/;
const HOUR_MS = 3600 * 1000;

interface PeakState {
  tenantId: string;
  dimension: string;
  day: string;
  hour: number;
  max: number;
  written: number;
  lastWriteAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<string, PeakState>();

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function writePeak(state: PeakState): Promise<void> {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.max <= state.written) return;
  const value = state.max;
  state.lastWriteAt = Date.now();
  try {
    const db = await getDatabase();
    await db.maxPlanUsagePeak(state.tenantId, state.day, state.dimension, state.hour, value);
    state.written = Math.max(state.written, value);
  } catch (error) {
    log.warn('Peak could not be stored', {
      tenantId: state.tenantId,
      dimension: state.dimension,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function dropStaleStates(nowHourStart: number): void {
  for (const [key, state] of states) {
    const bucket = Date.parse(`${state.day}T00:00:00Z`) + state.hour * HOUR_MS;
    if (bucket < nowHourStart && !state.timer) states.delete(key);
  }
  while (states.size > MAX_STATES) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    const state = states.get(oldest);
    if (state?.timer) clearTimeout(state.timer);
    states.delete(oldest);
  }
}

export function notePeak(tenantId: string, dimension: string, value: number): void {
  try {
    if (!DIMENSION_RE.test(dimension) || !Number.isFinite(value) || value <= 0) return;
    const now = new Date();
    const day = utcDay(now);
    const hour = now.getUTCHours();
    const key = `${tenantId}|${dimension}|${day}|${hour}`;
    let state = states.get(key);
    if (!state) {
      state = { tenantId, dimension, day, hour, max: 0, written: 0, lastWriteAt: 0, timer: null };
      states.set(key, state);
      if (states.size > MAX_STATES) dropStaleStates(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    }
    if (value <= state.max) return;
    state.max = value;
    const sinceWrite = now.getTime() - state.lastWriteAt;
    if (sinceWrite >= WRITE_EVERY_MS) {
      void writePeak(state);
    } else if (!state.timer) {
      const target = state;
      target.timer = setTimeout(() => {
        target.timer = null;
        void writePeak(target);
      }, WRITE_EVERY_MS - sinceWrite);
      target.timer.unref?.();
    }
  } catch {
    /* never throws */
  }
}

/** Max per dimension over the last 24 hourly buckets (stored values plus this process's unwritten ones). */
export async function getPeaks24h(tenantId: string): Promise<Record<string, number>> {
  const now = Date.now();
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const oldestBucket = currentHourStart - 23 * HOUR_MS;
  const result: Record<string, number> = {};
  const take = (dimension: string, value: number) => {
    if (value > (result[dimension] ?? 0)) result[dimension] = value;
  };
  try {
    const db = await getDatabase();
    const days = [utcDay(new Date(now)), utcDay(new Date(now - 24 * HOUR_MS))];
    const rows = await db.getPlanUsagePeaks(tenantId, days);
    for (const row of rows) {
      const bucket = Date.parse(`${row.day}T00:00:00Z`) + row.hour * HOUR_MS;
      if (bucket >= oldestBucket && bucket <= currentHourStart) take(row.dimension, row.value);
    }
  } catch (error) {
    log.warn('Peaks could not be read', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const state of states.values()) {
    if (state.tenantId !== tenantId) continue;
    const bucket = Date.parse(`${state.day}T00:00:00Z`) + state.hour * HOUR_MS;
    if (bucket >= oldestBucket && bucket <= currentHourStart) take(state.dimension, state.max);
  }
  return result;
}

export function clearPeaksForTests(): void {
  for (const state of states.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  states.clear();
}
