import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';

const logger = createLogger('js-sandbox:concurrency');

export interface JsSandboxConcurrencyHandle {
  release(): void;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

interface TenantPool {
  permits: number;
  max: number;
  queue: Waiter[];
}

class MemoryJsSandboxConcurrencyLimiter {
  readonly name = 'memory';
  private pools = new Map<string, TenantPool>();

  async acquire(tenantId: string, options?: { max?: number; timeoutMs?: number }): Promise<JsSandboxConcurrencyHandle> {
    const max = options?.max && options.max > 0
      ? options.max
      : getConfig().jsSandbox.defaultMaxConcurrent;
    const pool = this.getPool(tenantId, max);

    if (pool.permits < pool.max) {
      pool.permits += 1;
      return this.makeHandle(tenantId);
    }

    const timeoutMs = options?.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          pool.permits += 1;
          resolve(this.makeHandle(tenantId));
        },
        reject,
      };

      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = pool.queue.indexOf(waiter);
          if (idx >= 0) pool.queue.splice(idx, 1);
          reject(new Error(`JS Sandbox concurrency wait timed out after ${timeoutMs}ms`));
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
        waiter.reject(new Error('JS Sandbox concurrency limiter is shutting down'));
      }
    }
    this.pools.clear();
  }

  private getPool(tenantId: string, max: number): TenantPool {
    let pool = this.pools.get(tenantId);
    if (!pool) {
      pool = { permits: 0, max, queue: [] };
      this.pools.set(tenantId, pool);
      return pool;
    }
    pool.max = max;
    return pool;
  }

  private makeHandle(tenantId: string): JsSandboxConcurrencyHandle {
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

let activeLimiter: MemoryJsSandboxConcurrencyLimiter | null = null;

export function getJsSandboxConcurrencyLimiter(): MemoryJsSandboxConcurrencyLimiter {
  if (activeLimiter) return activeLimiter;
  const provider = getConfig().jsSandbox.concurrencyProvider;
  if (provider !== 'memory') {
    logger.warn('Unknown JS Sandbox concurrency provider, falling back to memory', { provider });
  }
  activeLimiter = new MemoryJsSandboxConcurrencyLimiter();
  return activeLimiter;
}

export async function shutdownJsSandboxConcurrencyLimiter(): Promise<void> {
  if (!activeLimiter) return;
  await activeLimiter.shutdown();
  activeLimiter = null;
}
