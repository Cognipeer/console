/**
 * Runtime abstraction. The reconciler talks to a `SandboxRuntime`; the console
 * protocol is identical regardless of the backend. Phase 1 ships `dind`; a
 * `k8s` adapter can be added later without touching the protocol or reconciler.
 */

import type { SandboxInstanceSpec } from '@cognipeer/sandbox-protocol';
import type { AgentConfig } from '../config';
import { createDindRuntime } from './dindRuntime';

export interface SandboxRuntime {
  create(spec: SandboxInstanceSpec): Promise<{ containerId: string }>;
  start(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  remove(instanceId: string): Promise<void>;
  logs(instanceId: string, tail: number): Promise<string>;
}

export function createRuntime(cfg: AgentConfig): SandboxRuntime {
  const kind = process.env.SANDBOX_RUNTIME || 'dind';
  switch (kind) {
    case 'dind':
    default:
      return createDindRuntime(cfg);
  }
}
