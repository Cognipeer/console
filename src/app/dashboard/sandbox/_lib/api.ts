/**
 * Client-side fetch helpers for the sandbox dashboard. All calls go to the
 * cookie-authenticated admin API under /api/sandbox/*.
 */

export interface SandboxRunner {
  id: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  terminalEnabled: boolean;
  createdAt: string;
  /** True when the console is managing a local agent process for this runner. */
  managedRunning?: boolean;
}

export interface SandboxTemplate {
  id: string;
  key: string;
  name: string;
  description: string | null;
  baseImage: string;
  runtime: string;
  isolation: string;
  toolboxPort: number;
  enabled: boolean;
}

export interface SandboxInstance {
  id: string;
  name: string;
  templateId: string;
  runnerId: string | null;
  containerId: string | null;
  desiredState: string;
  actualState: string;
  isolation: string;
  lastError: string | null;
  createdAt: string;
}

export interface SandboxVolume {
  id: string;
  name: string;
  provider: string;
  container: string;
  prefix: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

export const sandboxApi = {
  listRunners: () => req<{ runners: SandboxRunner[] }>('/api/sandbox/runners'),
  createRunner: (name: string) =>
    req<{ runner: SandboxRunner; registrationToken: string; expiresAt: string; tenantSlug: string }>('/api/sandbox/runners', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  rotateRunnerToken: (id: string) =>
    req<{ registrationToken: string; expiresAt: string; tenantSlug: string }>(`/api/sandbox/runners/${id}/rotate-token`, {
      method: 'POST',
    }),
  deleteRunner: (id: string) => req<{ ok: boolean }>(`/api/sandbox/runners/${id}`, { method: 'DELETE' }),
  startRunner: (id: string) => req<{ ok: boolean; running: boolean }>(`/api/sandbox/runners/${id}/start`, { method: 'POST' }),
  stopRunner: (id: string) => req<{ ok: boolean; running: boolean }>(`/api/sandbox/runners/${id}/stop`, { method: 'POST' }),

  listTemplates: () => req<{ templates: SandboxTemplate[] }>('/api/sandbox/templates'),
  seedTemplates: () => req<{ created: number }>('/api/sandbox/templates/seed', { method: 'POST' }),
  createTemplate: (body: {
    key: string;
    name: string;
    baseImage: string;
    runtime?: string;
    isolation?: string;
    toolboxPort?: number;
    description?: string;
    env?: Record<string, string>;
    previewPorts?: Array<{ port: number; label?: string }>;
  }) => req<{ template: SandboxTemplate }>('/api/sandbox/templates', { method: 'POST', body: JSON.stringify(body) }),
  deleteTemplate: (id: string) => req<{ ok: boolean }>(`/api/sandbox/templates/${id}`, { method: 'DELETE' }),

  listVolumes: () => req<{ volumes: SandboxVolume[] }>('/api/sandbox/volumes'),
  createVolume: (body: { name: string; provider: 'local' | 'azure-blob' | 's3'; container: string; prefix: string }) =>
    req<{ volume: SandboxVolume }>('/api/sandbox/volumes', { method: 'POST', body: JSON.stringify(body) }),

  listInstances: () => req<{ instances: SandboxInstance[] }>('/api/sandbox/instances'),
  createInstance: (body: {
    templateId: string;
    name: string;
    runnerId?: string;
    volumeId?: string;
    env?: Record<string, string>;
  }) => req<{ instance: SandboxInstance }>('/api/sandbox/instances', { method: 'POST', body: JSON.stringify(body) }),
  startInstance: (id: string) =>
    req<{ instance: SandboxInstance }>(`/api/sandbox/instances/${id}/start`, { method: 'POST' }),
  stopInstance: (id: string) =>
    req<{ instance: SandboxInstance }>(`/api/sandbox/instances/${id}/stop`, { method: 'POST' }),
  deleteInstance: (id: string) =>
    req<{ instance: SandboxInstance }>(`/api/sandbox/instances/${id}`, { method: 'DELETE' }),
  execInstance: (id: string, body: { command: string; cwd?: string; timeoutSec?: number }) =>
    req<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>(
      `/api/sandbox/instances/${id}/exec`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  codeInstance: (
    id: string,
    body: { code: string; language?: 'python' | 'javascript' | 'typescript' | 'bash'; timeoutSec?: number },
  ) =>
    req<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>(
      `/api/sandbox/instances/${id}/code`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  openTerminal: (id: string) =>
    req<{ sessionId: string; websocketPath: string; expiresAt: string }>(
      `/api/sandbox/instances/${id}/terminal`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /** Generic toolbox call (fs/git/sessions) against a sandbox — mirrors the
   *  token client API so the Playground can test the same operations. */
  toolbox: <T = unknown>(id: string, sub: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown) =>
    req<T>(`/api/sandbox/instances/${id}/${sub}`, {
      method,
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
};
