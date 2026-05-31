/**
 * Events flow from agent to console. Used for both audit (state changes) and
 * command acknowledgements.
 */

import type { DeploymentActualState } from './deployment';

export type GpuFleetEventKind =
  | 'command-accepted'
  | 'command-completed'
  | 'command-failed'
  | 'deployment-state-changed'
  | 'image-pull-progress'
  | 'mig-layout-applied'
  | 'agent-error'
  | 'log-snapshot';

interface BaseEvent {
  /** Monotonically increasing per-host sequence number; gap-detection on console. */
  sequence: number;
  /** When the event happened on the host. */
  occurredAt: string;
  kind: GpuFleetEventKind;
}

export interface CommandAcceptedEvent extends BaseEvent {
  kind: 'command-accepted';
  commandId: string;
}

export interface CommandCompletedEvent extends BaseEvent {
  kind: 'command-completed';
  commandId: string;
  /** Optional human-readable note (e.g. image digest pulled). */
  detail?: string;
}

export interface CommandFailedEvent extends BaseEvent {
  kind: 'command-failed';
  commandId: string;
  error: string;
  /** True when retrying the same command might succeed (transient error). */
  retryable: boolean;
}

export interface DeploymentStateChangedEvent extends BaseEvent {
  kind: 'deployment-state-changed';
  deploymentId: string;
  state: DeploymentActualState;
  containerId: string | null;
  message?: string;
}

export interface MigLayoutAppliedEvent extends BaseEvent {
  kind: 'mig-layout-applied';
  gpuUuid: string;
  /** New slices the agent created after the reconfigure. */
  sliceUuids: string[];
}

export interface AgentErrorEvent extends BaseEvent {
  kind: 'agent-error';
  /** Where in the agent the error occurred ("nvidia-smi-probe", "docker", …). */
  source: string;
  error: string;
}

export interface LogSnapshotEvent extends BaseEvent {
  kind: 'log-snapshot';
  deploymentId: string;
  /** UTF-8 tail of container logs. Bounded by the originating CollectLogsCommand. */
  logs: string;
}

export interface ImagePullProgressEvent extends BaseEvent {
  kind: 'image-pull-progress';
  deploymentId: string;
  image: string;
  /** Overall % across all layers. Null until docker reports a total size. */
  percent: number | null;
  /** Bytes pulled so far (sum across layers). */
  bytesDownloaded: number;
  /** Total bytes expected. Null until docker reports it. */
  bytesTotal: number | null;
  /** Free-form last status line ("Pulling fs layer", "Extracting", …). */
  status: string;
}

export type GpuFleetEvent =
  | CommandAcceptedEvent
  | CommandCompletedEvent
  | CommandFailedEvent
  | DeploymentStateChangedEvent
  | ImagePullProgressEvent
  | MigLayoutAppliedEvent
  | AgentErrorEvent
  | LogSnapshotEvent;
