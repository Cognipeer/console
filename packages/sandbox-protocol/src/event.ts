/**
 * Events flow from runner agent to console. Used for command acknowledgement,
 * instance state changes, and exec results. Each event carries a monotonically
 * increasing per-runner `sequence` so the console can dedup/replay-protect.
 */

export type SandboxInstanceState =
  | 'pending'
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'deleted';

export type SandboxEventKind =
  | 'command-accepted'
  | 'command-completed'
  | 'command-failed'
  | 'instance-state-changed'
  | 'image-pull-progress'
  | 'exec-result'
  | 'agent-error'
  | 'log-snapshot';

interface BaseEvent {
  /** Monotonic per-runner sequence number; gap-detection on the console. */
  sequence: number;
  /** When the event happened on the runner. */
  occurredAt: string;
  kind: SandboxEventKind;
}

export interface CommandAcceptedEvent extends BaseEvent {
  kind: 'command-accepted';
  commandId: string;
}

export interface CommandCompletedEvent extends BaseEvent {
  kind: 'command-completed';
  commandId: string;
  detail?: string;
}

export interface CommandFailedEvent extends BaseEvent {
  kind: 'command-failed';
  commandId: string;
  error: string;
  retryable: boolean;
}

export interface InstanceStateChangedEvent extends BaseEvent {
  kind: 'instance-state-changed';
  instanceId: string;
  state: SandboxInstanceState;
  containerId: string | null;
  message?: string;
}

export interface ImagePullProgressEvent extends BaseEvent {
  kind: 'image-pull-progress';
  instanceId: string;
  image: string;
  /** Overall %; null until docker reports a total. */
  percent: number | null;
  bytesDownloaded: number;
  bytesTotal: number | null;
  status: string;
}

/** Result of an `exec` / `code-run` command, correlated by `execId`. */
export interface ExecResultEvent extends BaseEvent {
  kind: 'exec-result';
  execId: string;
  instanceId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentErrorEvent extends BaseEvent {
  kind: 'agent-error';
  source: string;
  error: string;
}

export interface LogSnapshotEvent extends BaseEvent {
  kind: 'log-snapshot';
  instanceId: string;
  logs: string;
}

export type SandboxEvent =
  | CommandAcceptedEvent
  | CommandCompletedEvent
  | CommandFailedEvent
  | InstanceStateChangedEvent
  | ImagePullProgressEvent
  | ExecResultEvent
  | AgentErrorEvent
  | LogSnapshotEvent;
