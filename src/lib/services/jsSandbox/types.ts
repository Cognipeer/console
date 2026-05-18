import type {
  IJsSandboxExecution,
  IJsSandboxRuntime,
  IJsSandboxRuntimeLimits,
  IJsSandboxNetworkPolicy,
  JsSandboxCallerType,
  JsSandboxRuntimeStatus,
} from '@/lib/database';

export interface JsSandboxContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

export interface JsSandboxRuntimeView extends Omit<IJsSandboxRuntime, '_id'> {
  id: string;
}

export interface JsSandboxExecutionView extends Omit<IJsSandboxExecution, '_id'> {
  id: string;
}

export interface CreateJsSandboxRuntimeInput {
  key?: string;
  name: string;
  description?: string;
  status?: JsSandboxRuntimeStatus;
  libraries?: string[];
  limits?: Partial<IJsSandboxRuntimeLimits>;
  network?: Partial<IJsSandboxNetworkPolicy>;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateJsSandboxRuntimeInput {
  name?: string;
  description?: string;
  status?: JsSandboxRuntimeStatus;
  libraries?: string[];
  limits?: Partial<IJsSandboxRuntimeLimits>;
  network?: Partial<IJsSandboxNetworkPolicy>;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

export interface ExecuteJsSandboxInput {
  jsRuntimeId: string;
  code: string;
  input?: unknown;
  timeoutMs?: number;
  callerType: JsSandboxCallerType;
  callerTokenId?: string;
}

export interface JsSandboxWorkerRequest {
  code: string;
  input?: unknown;
  libraries: string[];
  timeoutMs: number;
  memoryLimitMb: number;
  maxResultSizeBytes: number;
  maxLogEntries: number;
}

export interface JsSandboxWorkerResult {
  status: 'success' | 'error' | 'timeout';
  result?: unknown;
  logs: {
    stdout: string[];
    stderr: string[];
  };
  errorMessage?: string;
}

export interface ExecuteJsSandboxResult extends JsSandboxExecutionView {
  request_id?: string;
}
