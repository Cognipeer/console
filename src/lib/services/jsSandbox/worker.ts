import { buildLibraryBootstrap } from './libraries';
import type { JsSandboxWorkerRequest, JsSandboxWorkerResult } from './types';

type IvmExternalCopy = new (value: unknown) => { copyInto(): unknown };
type IvmIsolate = {
  compileScript(source: string): Promise<{
    run(context: unknown, options: Record<string, unknown>): Promise<unknown>;
  }>;
  createContext(): Promise<{
    global: {
      set(name: string, value: unknown): Promise<void>;
      derefInto(): unknown;
    };
    eval(source: string, options?: Record<string, unknown>): Promise<unknown>;
  }>;
  dispose(): void;
};
type IvmModule = {
  Isolate: new (options: { memoryLimit: number }) => IvmIsolate;
  ExternalCopy: IvmExternalCopy;
};

interface WorkerEnvelope {
  id: string;
  request: JsSandboxWorkerRequest;
}

function normalizeIvmModule(value: unknown): IvmModule {
  const moduleValue = value as { default?: unknown };
  const candidate = (moduleValue.default ?? value) as Partial<IvmModule>;
  if (!candidate.Isolate || !candidate.ExternalCopy) {
    throw new Error('isolated-vm did not expose the expected API');
  }
  return candidate as IvmModule;
}

async function loadIsolatedVm(): Promise<IvmModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  return normalizeIvmModule(await dynamicImport('isolated-vm'));
}

function buildConsoleBootstrap(maxLogEntries: number): string {
  const max = Math.max(Math.min(maxLogEntries, 1_000), 0);
  return `
    globalThis.__logs = { stdout: [], stderr: [] };
    const __formatLogValue = (value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack || value.message;
      try { return JSON.stringify(value); } catch { return String(value); }
    };
    const __pushLog = (target, args) => {
      if (globalThis.__logs[target].length >= ${max}) return;
      globalThis.__logs[target].push(Array.from(args).map(__formatLogValue).join(' '));
    };
    globalThis.console = Object.freeze({
      log: (...args) => __pushLog('stdout', args),
      info: (...args) => __pushLog('stdout', args),
      warn: (...args) => __pushLog('stderr', args),
      error: (...args) => __pushLog('stderr', args),
    });
  `;
}

function buildUserSource(request: JsSandboxWorkerRequest): string {
  return `
    "use strict";
    ${buildConsoleBootstrap(request.maxLogEntries)}
    ${buildLibraryBootstrap(request.libraries)}
    globalThis.process = undefined;
    globalThis.require = undefined;
    globalThis.Buffer = undefined;
    globalThis.fetch = undefined;
    globalThis.WebSocket = undefined;
    (async () => {
      const input = globalThis.__input;
      ${request.code}
    })()
  `;
}

function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function normalizeError(error: unknown): { status: JsSandboxWorkerResult['status']; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: /timeout|timed out/i.test(message) ? 'timeout' : 'error',
    message,
  };
}

async function runSandbox(request: JsSandboxWorkerRequest): Promise<JsSandboxWorkerResult> {
  const ivm = await loadIsolatedVm();
  const isolate = new ivm.Isolate({ memoryLimit: request.memoryLimitMb });
  const logsFallback = { stdout: [], stderr: [] };

  try {
    const context = await isolate.createContext();
    await context.global.set('globalThis', context.global.derefInto());
    await context.global.set('__input', new ivm.ExternalCopy(request.input ?? null).copyInto());

    const script = await isolate.compileScript(buildUserSource(request));
    const result = await script.run(context, {
      copy: true,
      promise: true,
      timeout: request.timeoutMs,
    });
    const logs = await context.eval('globalThis.__logs', { copy: true }) as JsSandboxWorkerResult['logs'];

    if (serializedSize(result) > request.maxResultSizeBytes) {
      return {
        status: 'error',
        logs: logs ?? logsFallback,
        errorMessage: `Result exceeds maximum serialized size (${request.maxResultSizeBytes} bytes)`,
      };
    }

    return {
      status: 'success',
      result,
      logs: logs ?? logsFallback,
    };
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      status: normalized.status,
      logs: logsFallback,
      errorMessage: normalized.message,
    };
  } finally {
    isolate.dispose();
  }
}

function sendResult(id: string, result: JsSandboxWorkerResult): void {
  if (typeof process.send === 'function') {
    process.send({ id, result });
  }
}

process.on('message', (message: WorkerEnvelope) => {
  runSandbox(message.request)
    .then((result) => sendResult(message.id, result))
    .catch((error) => {
      const normalized = normalizeError(error);
      sendResult(message.id, {
        status: normalized.status,
        logs: { stdout: [], stderr: [] },
        errorMessage: normalized.message,
      });
    });
});
