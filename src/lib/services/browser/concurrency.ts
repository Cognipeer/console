/**
 * Browser concurrency limiter (provider-pattern).
 *
 * Today: in-memory semaphore per tenant.
 * Tomorrow: drop-in Redis provider when scaling beyond a single Node pod.
 *
 * Selected via `getConfig().browser.concurrencyProvider`.
 */

import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';

const logger = createLogger('browser:concurrency');

export interface AcquireOptions {
  /** Max concurrent permits for this tenant (overrides default). */
  max?: number;
  /** Max time to wait in queue before throwing (ms). 0 = no wait. */
  timeoutMs?: number;
}

export interface ConcurrencyHandle {
  release(): void;
}

export interface ConcurrencyLimiterProvider {
  readonly name: string;
  acquire(tenantId: string, options?: AcquireOptions): Promise<ConcurrencyHandle>;
  /** Number of permits currently held for a tenant (best-effort). */
  inUse(tenantId: string): number;
  shutdown(): Promise<void>;
}

interface PendingWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

interface TenantPool {
  permits: number;
  max: number;
  queue: PendingWaiter[];
}

class MemoryConcurrencyLimiter implements ConcurrencyLimiterProvider {
  readonly name = 'memory';
  private pools = new Map<string, TenantPool>();

  private getPool(tenantId: string, max: number): TenantPool {
    let pool = this.pools.get(tenantId);
    if (!pool) {
      pool = { permits: 0, max, queue: [] };
      this.pools.set(tenantId, pool);
    } else if (pool.max !== max) {
      // Allow runtime tuning (e.g., admin raises tenant limit).
      pool.max = max;
    }
    return pool;
  }

  async acquire(tenantId: string, options?: AcquireOptions): Promise<ConcurrencyHandle> {
    const cfg = getConfig().browser;
    const max = options?.max && options.max > 0 ? options.max : cfg.defaultMaxConcurrent;
    const pool = this.getPool(tenantId, max);

    if (pool.permits < pool.max) {
      pool.permits += 1;
      return this.makeHandle(tenantId);
    }

    const timeoutMs = options?.timeoutMs ?? 60_000;

    return new Promise<ConcurrencyHandle>((resolve, reject) => {
      const waiter: PendingWaiter = {
        resolve: () => {
          pool.permits += 1;
          resolve(this.makeHandle(tenantId));
        },
        reject,
      };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = pool.queue.indexOf(waiter);
          if (idx >= 0) {
            pool.queue.splice(idx, 1);
          }
          reject(new Error(`Browser concurrency wait timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      pool.queue.push(waiter);
    });
  }

  inUse(tenantId: string): number {
    return this.pools.get(tenantId)?.permits ?? 0;
  }

  async shutdown(): Promise<void> {
    for (const pool of this.pools.values()) {
      for (const waiter of pool.queue.splice(0)) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new Error('Browser concurrency limiter is shutting down'));
      }
    }
    this.pools.clear();
  }

  private makeHandle(tenantId: string): ConcurrencyHandle {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const pool = this.pools.get(tenantId);
        if (!pool) return;
        pool.permits = Math.max(0, pool.permits - 1);
        const next = pool.queue.shift();
        if (next) {
          if (next.timer) clearTimeout(next.timer);
          next.resolve();
        }
      },
    };
  }
}

let activeProvider: ConcurrencyLimiterProvider | null = null;

export function getConcurrencyLimiter(): ConcurrencyLimiterProvider {
  if (activeProvider) return activeProvider;
  const provider = getConfig().browser.concurrencyProvider;
  if (provider !== 'memory') {
    logger.warn('Unknown browser concurrency provider, falling back to memory', { provider });
  }
  activeProvider = new MemoryConcurrencyLimiter();
  return activeProvider;
}

export async function shutdownConcurrencyLimiter(): Promise<void> {
  if (activeProvider) {
    await activeProvider.shutdown();
    activeProvider = null;
  }
}
