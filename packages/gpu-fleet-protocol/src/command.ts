/**
 * Commands the console issues to an agent. Delivered over the long-poll
 * channel; agents apply them and report results via events. Commands are
 * idempotent: the agent diffs against actual state before acting.
 */

import type { DeploymentSpec } from './deployment';
import type { DesiredMigLayout } from './slice';
import type { OpenTerminalSessionPayload } from './terminal';

export type GpuFleetCommandKind =
  | 'apply-mig-profile'
  | 'apply-deployment'
  | 'stop-deployment'
  | 'remove-deployment'
  | 'pull-image'
  | 'collect-logs'
  | 'reboot-agent'
  | 'open-terminal-session';

interface BaseCommand {
  /** Unique id, assigned by the console; agent echoes it back in events. */
  id: string;
  kind: GpuFleetCommandKind;
  /** Issued-at timestamp (ISO). Helps with command-queue debugging. */
  issuedAt: string;
}

export interface ApplyMigProfileCommand extends BaseCommand {
  kind: 'apply-mig-profile';
  layout: DesiredMigLayout;
  /** Deployments the agent must drain before reconfiguring (by deploymentId). */
  drainDeploymentIds: string[];
}

export interface ApplyDeploymentCommand extends BaseCommand {
  kind: 'apply-deployment';
  spec: DeploymentSpec;
}

export interface StopDeploymentCommand extends BaseCommand {
  kind: 'stop-deployment';
  deploymentId: string;
}

export interface RemoveDeploymentCommand extends BaseCommand {
  kind: 'remove-deployment';
  deploymentId: string;
  /**
   * Delete the image from the host after the container is removed, but only
   * if no other container still references it. Defaults to `true` (preserve
   * disk on permanent deletes). Restart flows pass `false` so the next
   * apply-deployment doesn't re-download a multi-GB image.
   */
  reclaimImage?: boolean;
}

export interface PullImageCommand extends BaseCommand {
  kind: 'pull-image';
  image: string;
}

export interface CollectLogsCommand extends BaseCommand {
  kind: 'collect-logs';
  deploymentId: string;
  tailLines: number;
}

export interface RebootAgentCommand extends BaseCommand {
  kind: 'reboot-agent';
}

export interface OpenTerminalSessionCommand extends BaseCommand, OpenTerminalSessionPayload {
  kind: 'open-terminal-session';
}

export type GpuFleetCommand =
  | ApplyMigProfileCommand
  | ApplyDeploymentCommand
  | StopDeploymentCommand
  | RemoveDeploymentCommand
  | PullImageCommand
  | CollectLogsCommand
  | RebootAgentCommand
  | OpenTerminalSessionCommand;
