import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { registerShutdownHandler } from '@/lib/core/lifecycle';
import { getJsSandboxConcurrencyLimiter, shutdownJsSandboxConcurrencyLimiter } from './concurrency';
import type { JsSandboxWorkerRequest, JsSandboxWorkerResult } from './types';

const logger = createLogger('js-sandbox:executor');

interface WorkerResponse {
  id: string;
  result: JsSandboxWorkerResult;
}

class JsSandboxExecutorManager {
  private readonly children = new Set<ChildProcess>();
  private shutdownRegistered = false;
  private shuttingDown = false;

  async execute(tenantId: string, request: JsSandboxWorkerRequest): Promise<JsSandboxWorkerResult> {
    if (this.shuttingDown) {
      throw new Error('JS Sandbox executor is shutting down');
    }

    this.ensureShutdownHook();
    const limiter = getJsSandboxConcurrencyLimiter();
    const handle = await limiter.acquire(tenantId, { timeoutMs: request.timeoutMs + getConfig().jsSandbox.childProcessTimeoutBufferMs });

    try {
      return await this.runWorker(request);
    } finally {
      handle.release();
    }
  }

  getRuntimeStats(): { liveWorkers: number; shuttingDown: boolean } {
    return {
      liveWorkers: this.children.size,
      shuttingDown: this.shuttingDown,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const child of this.children) {
      child.kill('SIGTERM');
    }
    await shutdownJsSandboxConcurrencyLimiter();
  }

  private ensureShutdownHook(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;
    registerShutdownHandler('js-sandbox-executor', () => this.shutdown());
  }

  private runWorker(request: JsSandboxWorkerRequest): Promise<JsSandboxWorkerResult> {
    const id = randomUUID();
    const cfg = getConfig().jsSandbox;
    const timeoutMs = request.timeoutMs + cfg.childProcessTimeoutBufferMs;
    const workerPath = path.join(process.cwd(), 'src/lib/services/jsSandbox/worker.ts');
    const child = fork(workerPath, [], {
      execArgv: process.execArgv.length > 0 ? process.execArgv : ['--import', 'tsx'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });

    this.children.add(child);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({
          status: 'timeout',
          logs: { stdout: [], stderr: [] },
          errorMessage: `Execution timed out after ${request.timeoutMs}ms`,
        });
      }, timeoutMs);

      child.once('message', (message: WorkerResponse) => {
        if (!message || message.id !== id) {
          return;
        }
        clearTimeout(timer);
        resolve(message.result);
        child.kill('SIGTERM');
      });

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.once('exit', (code, signal) => {
        this.children.delete(child);
        if (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL') {
          return;
        }
        clearTimeout(timer);
        logger.warn('JS Sandbox worker exited unexpectedly', { code, signal });
        reject(new Error(`JS Sandbox worker exited unexpectedly (${code ?? signal ?? 'unknown'})`));
      });

      child.stderr?.once('data', (chunk: Buffer) => {
        logger.warn('JS Sandbox worker stderr', {
          message: chunk.toString('utf8').slice(0, 500),
        });
      });

      child.send({ id, request });
    });
  }
}

export const jsSandboxExecutorManager = new JsSandboxExecutorManager();
