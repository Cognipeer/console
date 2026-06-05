/**
 * Simple counting semaphore + retry helper.
 */

export class Semaphore {
  private counter = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.counter < this.max) {
      this.counter++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.counter = Math.max(0, this.counter - 1);
    }
  }
}

export async function retry<T>(
  fn: () => Promise<T>,
  attempts: number,
  initialDelayMs = 1000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise<void>((r) => setTimeout(r, initialDelayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}
