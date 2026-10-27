/**
 * Flow sandbox seam — COMMUNITY (open-source) edition.
 *
 * Flow nodes that run code (`code.run`, `sandbox.*`) need a sandbox, and the
 * sandbox module is an enterprise feature. The community core defines the node
 * catalog entries and their behaviour; the enterprise overlay supplies the
 * runtime behind them through this seam, the same split agents use
 * (`agentSandboxRunner`), but flow-shaped: owned by a RUN, not by an agent
 * conversation.
 *
 * Contract:
 *   - Nothing is registered in the community edition: `resolveFlowSandboxRuntime`
 *     answers null, the sandbox nodes show as unavailable in the editor and
 *     fail with `sandbox_unavailable` when a run reaches one.
 *   - The overlay calls `registerFlowSandboxRuntime(...)` once at load, from its
 *     `registry.ts`. This is a separate community file (NOT replaced by the
 *     overlay), so the `registry.ts` seam shape and SEAM_CONTRACT_VERSION do not
 *     change because of it.
 *   - Licensing is checked by the community caller (`nodes/sandbox.ts`), not here.
 *   - Every method takes the run's {@link FlowSandboxRef}. A runtime only ever
 *     touches sandboxes of that run: an instance id that the run did not create
 *     reads as "not found". Nodes never create persistent sandboxes.
 *   - Failures are thrown as {@link FlowSandboxError} (code + retryable), so the
 *     engine can tell a quota or capacity refusal (retry later) from a missing
 *     sandbox or a bad request (do not retry).
 *
 * Leaf module on purpose: no runtime imports, so the overlay registry can
 * import it at load time without creating a cycle.
 */

/** Who the run acts as (mirrors `FlowRunPrincipal` of the engine; structural on purpose). */
export interface FlowSandboxPrincipal {
  kind: 'user' | 'token' | 'flow';
  userId?: string;
  tokenId?: string;
  accountableUserId?: string;
  label: string;
}

/** Identifies the run a sandbox call belongs to. `runId` is the OWNER of every sandbox the call creates. */
export interface FlowSandboxRef {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  flowId: string;
  /** Short flow key, used in logs only. */
  flowKey?: string;
  runId: string;
  stepId?: string;
  principal: FlowSandboxPrincipal;
}

/** What a run-end teardown needs: no principal, no flow. */
export type FlowSandboxRunRef = Pick<FlowSandboxRef, 'tenantDbName' | 'tenantId' | 'projectId' | 'runId'>;

export type FlowSandboxLanguage = 'python' | 'javascript' | 'typescript' | 'bash';

export interface FlowSandboxCreateSpec {
  /** Sandbox template key; omitted = the default (`multi-base`). */
  templateKey?: string;
  resources?: { cpuCores?: number; memoryMb?: number; diskMb?: number };
  /** Cut the sandbox off from the network (a runtime that cannot do it throws `sandbox_unsupported`). */
  blockNetwork?: boolean;
  /** Plain (non-secret) variables set on the sandbox itself. */
  env?: Record<string, string>;
  /**
   * The sandbox is closed after this many idle seconds even if the run never
   * releases it (a crashed worker, a run that waits for days). Always set by the
   * nodes; a runtime applies its own default when absent.
   */
  idleStopSeconds?: number;
}

export interface FlowSandboxCallOptions {
  timeoutSec?: number;
  signal?: AbortSignal;
  /** Per-call variables; never stored on the sandbox. Secrets travel here. */
  env?: Record<string, string>;
  cwd?: string;
  /** Values to mask in everything the call returns (the runtime adds the sandbox's own launch secrets). */
  maskValues?: string[];
}

export interface FlowSandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface FlowSandboxFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
  size?: number;
}

export interface FlowSandboxSeedFile {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface FlowSandboxRuntime {
  /**
   * One-shot (Code node): create an ephemeral sandbox, wait until it executes,
   * write `files`, run the code, and destroy the sandbox in a `finally`
   * (also on abort and on failure).
   */
  runCode(
    ref: FlowSandboxRef,
    input: FlowSandboxCreateSpec &
      FlowSandboxCallOptions & {
        code: string;
        language: FlowSandboxLanguage;
        files?: FlowSandboxSeedFile[];
        /** How long to wait for the sandbox to accept commands. */
        readyTimeoutMs?: number;
      },
  ): Promise<FlowSandboxExecResult & { instanceId: string; durationMs: number }>;
  /** Create an ephemeral sandbox owned by the run. It may not accept commands yet: call `waitReady`. */
  create(ref: FlowSandboxRef, spec: FlowSandboxCreateSpec): Promise<{ instanceId: string; name: string; state: string }>;
  /** Resolves once the sandbox accepts commands; rejects with `sandbox_failed` / `sandbox_gone` / `sandbox_timeout`. */
  waitReady(ref: FlowSandboxRef, instanceId: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  exec(ref: FlowSandboxRef, instanceId: string, input: FlowSandboxCallOptions & { command: string }): Promise<FlowSandboxExecResult>;
  runCodeIn(
    ref: FlowSandboxRef,
    instanceId: string,
    input: FlowSandboxCallOptions & { code: string; language: FlowSandboxLanguage },
  ): Promise<FlowSandboxExecResult>;
  listFiles(ref: FlowSandboxRef, instanceId: string, path: string): Promise<FlowSandboxFileEntry[]>;
  readFile(
    ref: FlowSandboxRef,
    instanceId: string,
    path: string,
    encoding?: 'utf8' | 'base64',
  ): Promise<{ content: string; encoding: 'utf8' | 'base64'; size: number }>;
  writeFile(
    ref: FlowSandboxRef,
    instanceId: string,
    path: string,
    content: string,
    encoding?: 'utf8' | 'base64',
  ): Promise<{ bytesWritten: number }>;
  mkdir(ref: FlowSandboxRef, instanceId: string, path: string): Promise<void>;
  removeFile(ref: FlowSandboxRef, instanceId: string, path: string, recursive?: boolean): Promise<void>;
  moveFile(ref: FlowSandboxRef, instanceId: string, from: string, to: string): Promise<void>;
  /** Close the sandbox (ephemeral sandboxes are deleted by a stop). Idempotent. */
  stop(ref: FlowSandboxRef, instanceId: string): Promise<{ deleted: boolean }>;
  /** Delete the sandbox. Idempotent. */
  destroy(ref: FlowSandboxRef, instanceId: string): Promise<{ destroyed: boolean }>;
  /**
   * Run-end teardown: destroy every sandbox the run owns. `instanceIds` are the
   * ones the caller tracked; a runtime SHOULD also find the run's sandboxes by
   * itself (a worker may have restarted since they were created). Idempotent;
   * resolves with how many it destroyed and never throws for a missing sandbox.
   */
  releaseRun(ref: FlowSandboxRunRef, instanceIds?: string[]): Promise<{ destroyed: number }>;
}

/** Failure classes a flow sandbox runtime reports. */
export type FlowSandboxErrorCode =
  /** The sandbox service is switched off or not licensed for the workspace. */
  | 'sandbox_unavailable'
  /** Concurrent-sandbox quota or cluster capacity reached: retry later. */
  | 'sandbox_quota'
  /** No such sandbox for this run (never created here, or already deleted). */
  | 'sandbox_not_found'
  /** The sandbox existed but is gone or not running now (idle-stopped, deleted). */
  | 'sandbox_gone'
  /** The sandbox failed to start. */
  | 'sandbox_failed'
  /** The sandbox did not become ready in time. */
  | 'sandbox_timeout'
  /** The runtime cannot do what was asked (e.g. network isolation). */
  | 'sandbox_unsupported'
  /** The template is missing, disabled, or not allowed for flows. */
  | 'sandbox_template'
  /** The run already owns the maximum number of sandboxes. */
  | 'sandbox_limit'
  /** Anything else. */
  | 'sandbox_error';

/** Typed failure of a flow sandbox runtime; `nodes/sandbox.ts` turns it into a `FlowNodeError`. */
export class FlowSandboxError extends Error {
  readonly code: FlowSandboxErrorCode;
  readonly retryable: boolean;
  constructor(message: string, code: FlowSandboxErrorCode = 'sandbox_error', retryable = false) {
    super(message);
    this.name = 'FlowSandboxError';
    this.code = code;
    this.retryable = retryable;
  }
}

let runtime: FlowSandboxRuntime | null = null;

/** Registers the sandbox runtime (called by the enterprise overlay at load). `null` clears it (tests). A later registration replaces the earlier one. */
export function registerFlowSandboxRuntime(next: FlowSandboxRuntime | null): void {
  runtime = next;
}

/** True when an enterprise sandbox runtime is registered. */
export function hasFlowSandboxRuntime(): boolean {
  return runtime !== null;
}

/** The registered runtime, or null in the community edition. Resolve at call time, never at module scope. */
export function resolveFlowSandboxRuntime(): FlowSandboxRuntime | null {
  return runtime;
}
