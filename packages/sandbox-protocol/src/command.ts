/**
 * Lifecycle + exec commands the console issues to a runner agent over the
 * long-poll channel. The agent applies them and reports results via events.
 * Commands are idempotent where it matters: the agent diffs against the actual
 * container state before acting.
 */

import type { SandboxInstanceSpec } from './template';
import type { OpenTerminalSessionPayload } from './terminal';

export type SandboxCommandKind =
  | 'create-sandbox'
  | 'start-sandbox'
  | 'stop-sandbox'
  | 'delete-sandbox'
  | 'collect-logs'
  | 'exec'
  | 'code-run'
  | 'open-terminal-session'
  | 'reboot-agent';

interface BaseCommand {
  /** Unique id assigned by the console; the agent echoes it in events. */
  id: string;
  kind: SandboxCommandKind;
  /** Issued-at timestamp (ISO). */
  issuedAt: string;
}

export interface CreateSandboxCommand extends BaseCommand {
  kind: 'create-sandbox';
  spec: SandboxInstanceSpec;
}

export interface StartSandboxCommand extends BaseCommand {
  kind: 'start-sandbox';
  instanceId: string;
}

export interface StopSandboxCommand extends BaseCommand {
  kind: 'stop-sandbox';
  instanceId: string;
}

export interface DeleteSandboxCommand extends BaseCommand {
  kind: 'delete-sandbox';
  instanceId: string;
  /** Also delete the backing volume data. Defaults to false (preserve). */
  reclaimVolume?: boolean;
}

export interface CollectLogsCommand extends BaseCommand {
  kind: 'collect-logs';
  instanceId: string;
  tailLines: number;
}

/** Run a shell command inside the sandbox and report the result. */
export interface ExecCommand extends BaseCommand {
  kind: 'exec';
  instanceId: string;
  /** Correlation id; the agent echoes it on the `exec-result` event. */
  execId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
}

/** Run a code snippet inside the sandbox with the right interpreter. */
export interface CodeRunCommand extends BaseCommand {
  kind: 'code-run';
  instanceId: string;
  execId: string;
  code: string;
  language?: 'python' | 'javascript' | 'typescript' | 'bash';
  cwd?: string;
  timeoutSec?: number;
}

export interface OpenTerminalSessionCommand extends BaseCommand, OpenTerminalSessionPayload {
  kind: 'open-terminal-session';
}

export interface RebootAgentCommand extends BaseCommand {
  kind: 'reboot-agent';
}

export type SandboxCommand =
  | CreateSandboxCommand
  | StartSandboxCommand
  | StopSandboxCommand
  | DeleteSandboxCommand
  | CollectLogsCommand
  | ExecCommand
  | CodeRunCommand
  | OpenTerminalSessionCommand
  | RebootAgentCommand;
