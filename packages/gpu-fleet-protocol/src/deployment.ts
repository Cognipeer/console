/**
 * Deployment = a Docker container running on a slice and exposing an
 * OpenAI-compatible (or otherwise model-serving) HTTP endpoint.
 */

export type DeploymentRuntime = 'vllm' | 'tgi' | 'ollama' | 'custom';

export type DeploymentDesiredState = 'running' | 'stopped';

export type DeploymentActualState =
  | 'pending'
  | 'pulling'
  | 'starting'
  | 'healthy'
  | 'unhealthy'
  | 'stopped'
  | 'failed';

export interface DeploymentSpec {
  /** Stable id assigned by the console. Used as the container name suffix. */
  deploymentId: string;
  /** Slice UUID this deployment is pinned to. */
  sliceUuid: string;
  runtime: DeploymentRuntime;
  /** Docker image, e.g. "vllm/vllm-openai:v0.6.4". */
  image: string;
  /** Model identifier the runtime should serve (HF id, gguf path, etc.). */
  modelName: string;
  /** Extra CLI args passed to the container ENTRYPOINT. */
  args: string[];
  /** Environment variables for the container. */
  env: Record<string, string>;
  /** Host port the runtime listens on (mapped 1-1 inside the container). */
  port: number;
  /** Container path that returns 200 when the runtime is ready to serve. */
  healthPath: string;
  /** Volume mounts for model cache, e.g. HF_HOME. */
  volumes: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
  /** Restart policy passed to docker. */
  restart: 'no' | 'on-failure' | 'always' | 'unless-stopped';
}

export interface DeploymentRuntimeStatus {
  deploymentId: string;
  state: DeploymentActualState;
  /** ID of the docker container backing this deployment, when one exists. */
  containerId: string | null;
  /** Last health probe result. Null if never probed. */
  lastHealthyAt: string | null;
  /** Restart count from docker inspect. */
  restartCount: number;
  /** Most recent failure message (probe failure, oom, exit code, etc.). */
  lastError: string | null;
}
