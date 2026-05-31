/**
 * Runtime adapters describe per-engine knobs the generic Docker container
 * step can't infer:
 *
 *   - default healthcheck path (vLLM: /health, TGI: /health, Ollama: /api/tags,
 *     TEI: /health, faster-whisper: /health)
 *   - "ready" predicate (vLLM exposes /metrics; we treat /health 200 as ready)
 *   - env hint injection (HF_HOME volume, NVIDIA_VISIBLE_DEVICES, etc.)
 *
 * The reconciler resolves a runtime adapter for each `apply-deployment` and
 * lets it customise the spec before it's handed to docker.ts. Adapters are
 * intentionally tiny — most of the spec already comes from the
 * model-library template on the console side.
 */

import type { DeploymentRuntime, DeploymentSpec } from '@cognipeer/gpu-fleet-protocol';

export interface RuntimeAdapter {
  id: DeploymentRuntime;
  /** Returns a spec ready for docker.ts. Pure function. */
  prepare(spec: DeploymentSpec): DeploymentSpec;
  /** Used by the reconciler to override health-probe behaviour. */
  healthPath(spec: DeploymentSpec): string;
  /** Optional readiness probe path (defaults to healthPath). */
  readinessPath?(spec: DeploymentSpec): string;
}

const vllmAdapter: RuntimeAdapter = {
  id: 'vllm',
  prepare(spec) {
    return {
      ...spec,
      env: {
        // Persistent HF cache survives container restarts when the volume
        // is bound. The model-library entry decides whether to mount it.
        HF_HOME: '/root/.cache/huggingface',
        ...spec.env,
      },
    };
  },
  healthPath: () => '/health',
};

const tgiAdapter: RuntimeAdapter = {
  id: 'tgi',
  prepare(spec) {
    return {
      ...spec,
      env: { HF_HOME: '/data', ...spec.env },
    };
  },
  healthPath: () => '/health',
};

const ollamaAdapter: RuntimeAdapter = {
  id: 'ollama',
  prepare(spec) {
    return {
      ...spec,
      // Ollama listens on 11434 by default; respect explicit override.
      port: spec.port || 11434,
      env: {
        OLLAMA_HOST: '0.0.0.0:11434',
        ...spec.env,
      },
    };
  },
  healthPath: () => '/api/tags',
};

const customAdapter: RuntimeAdapter = {
  id: 'custom',
  prepare: (spec) => spec,
  healthPath: (spec) => spec.healthPath || '/health',
};

const ADAPTERS: Record<DeploymentRuntime, RuntimeAdapter> = {
  vllm: vllmAdapter,
  tgi: tgiAdapter,
  ollama: ollamaAdapter,
  custom: customAdapter,
};

export function resolveRuntimeAdapter(runtime: DeploymentRuntime): RuntimeAdapter {
  return ADAPTERS[runtime] ?? customAdapter;
}
