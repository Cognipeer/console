/**
 * Tiny fetch wrappers used across the GPU fleet pages. Centralised so the
 * error-handling pattern stays consistent and so the URLs are documented
 * in one place.
 */

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed: HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const GpuFleetApi = {
  async listHosts<T>(): Promise<T> {
    const res = await fetch('/api/gpu-fleet/hosts', { cache: 'no-store' });
    return asJson<T>(res);
  },

  async getHost<T>(hostId: string): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/hosts/${hostId}`, { cache: 'no-store' });
    return asJson<T>(res);
  },

  async listPendingClaim<T>(): Promise<T> {
    const res = await fetch('/api/gpu-fleet/onboarding/pending', { cache: 'no-store' });
    return asJson<T>(res);
  },

  async claimPending<T>(
    hostId: string,
    body: { name?: string; labels?: Record<string, string>; serviceAddress?: string | null; terminalEnabled?: boolean },
  ): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/onboarding/pending/${hostId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return asJson<T>(res);
  },

  async restartHostAgent(hostId: string): Promise<void> {
    const res = await fetch(`/api/gpu-fleet/hosts/${hostId}/restart-agent`, { method: 'POST' });
    await asJson(res);
  },

  async restartDeployment(deploymentId: string): Promise<void> {
    const res = await fetch(`/api/gpu-fleet/deployments/${deploymentId}/restart`, { method: 'POST' });
    await asJson(res);
  },

  async updateHostServiceAddress<T>(hostId: string, serviceAddress: string | null): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/hosts/${hostId}/service-address`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceAddress }),
    });
    return asJson<T>(res);
  },

  async rejectPending(hostId: string): Promise<void> {
    const res = await fetch(`/api/gpu-fleet/onboarding/pending/${hostId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Reject failed: HTTP ${res.status}`);
    }
  },

  async getSettings<T>(): Promise<T> {
    const res = await fetch('/api/gpu-fleet/settings', { cache: 'no-store' });
    return asJson<T>(res);
  },

  async renderInstallSnippet<T>(opts: { platform?: string; rotateToken?: boolean }): Promise<T> {
    const res = await fetch('/api/gpu-fleet/onboarding/install-snippet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return asJson<T>(res);
  },

  async rotateFleetToken<T>(): Promise<T> {
    const res = await fetch('/api/gpu-fleet/settings/fleet-token/rotate', { method: 'POST' });
    return asJson<T>(res);
  },

  async updateAgentDistribution<T>(body: {
    mode: 'console-served' | 'external-url';
    externalUrlTemplate?: string | null;
  }): Promise<T> {
    const res = await fetch('/api/gpu-fleet/settings/agent-distribution', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return asJson<T>(res);
  },

  async listModelLibrary<T>(filters: { modality?: string; accelerator?: string; q?: string; tag?: string } = {}): Promise<T> {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (v) params.set(k, String(v));
    });
    const res = await fetch(`/api/gpu-fleet/model-library?${params.toString()}`, { cache: 'no-store' });
    return asJson<T>(res);
  },

  async createDeployment<T>(hostId: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/hosts/${hostId}/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return asJson<T>(res);
  },

  async stopDeployment<T>(deploymentId: string): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/deployments/${deploymentId}/stop`, { method: 'POST' });
    return asJson<T>(res);
  },

  async deleteDeployment(deploymentId: string): Promise<void> {
    const res = await fetch(`/api/gpu-fleet/deployments/${deploymentId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Delete failed: HTTP ${res.status}`);
    }
  },

  async listPools<T>(): Promise<T> {
    const res = await fetch('/api/gpu-fleet/pools', { cache: 'no-store' });
    return asJson<T>(res);
  },

  async bulkDeploy<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetch('/api/gpu-fleet/pools/bulk-deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return asJson<T>(res);
  },

  async deletePool(poolKey: string): Promise<void> {
    const res = await fetch(`/api/gpu-fleet/pools/${poolKey}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Delete failed: HTTP ${res.status}`);
    }
  },

  async publishPool<T>(poolKey: string, modality: string): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/pools/${poolKey}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modality }),
    });
    return asJson<T>(res);
  },

  async openTerminal<T>(hostId: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/hosts/${hostId}/terminal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return asJson<T>(res);
  },

  async listPoolCandidates<T>(poolKey: string): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/pools/${poolKey}/candidates`, { cache: 'no-store' });
    return asJson<T>(res);
  },

  async attachMember(poolKey: string, deploymentId: string): Promise<void> {
    const res = await fetch(`/api/gpu-fleet/pools/${poolKey}/members/${deploymentId}`, { method: 'POST' });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Attach failed: HTTP ${res.status}`);
    }
  },

  async detachMember(poolKey: string, deploymentId: string): Promise<void> {
    const res = await fetch(`/api/gpu-fleet/pools/${poolKey}/members/${deploymentId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Detach failed: HTTP ${res.status}`);
    }
  },

  async patchPool<T>(poolKey: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`/api/gpu-fleet/pools/${poolKey}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return asJson<T>(res);
  },
};
