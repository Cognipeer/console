import { getTenantDatabase } from '@/lib/database';
import type { IInferenceServer, IInferenceServerMetrics } from '@/lib/database';
import { pollVllmServer, snapshotToMetrics } from './vllmPoller';
import { pollLlamaCppServer } from './llamacppPoller';
import { sealApiKey, openApiKey } from './apiKeyVault';
import slugify from 'slugify';

function generateServerKey(name: string): string {
  return slugify(name, { lower: true, strict: true, trim: true }) + '-' + Date.now().toString(36);
}

/**
 * The status a finished poll may write. The server is re-read first because the
 * operator can disable it while the poll is in flight, and a poll result must
 * not switch it back on.
 */
async function pollStatusUpdate(
  db: Awaited<ReturnType<typeof getTenantDatabase>>,
  tenantId: string,
  serverKey: string,
  status: 'active' | 'errored',
): Promise<{ status?: IInferenceServer['status'] }> {
  const current = await db.findInferenceServerByKey(tenantId, serverKey);
  return current?.status === 'disabled' ? {} : { status };
}

/** A poll was asked for on a server the operator switched off. */
export class InferenceServerDisabledError extends Error {
  readonly status = 409;
  readonly code = 'inference_server_disabled';

  constructor(serverKey: string) {
    super(`Inference server "${serverKey}" is disabled`);
    this.name = 'InferenceServerDisabledError';
  }
}

export class InferenceMonitoringService {
  /**
   * List all inference servers for a tenant.
   */
  static async listServers(tenantDbName: string, tenantId: string): Promise<IInferenceServer[]> {
    const db = await getTenantDatabase(tenantDbName);
    return db.listInferenceServers(tenantId);
  }

  /**
   * Get a single inference server by its key.
   */
  static async getServerByKey(
    tenantDbName: string,
    tenantId: string,
    serverKey: string,
  ): Promise<IInferenceServer | null> {
    const db = await getTenantDatabase(tenantDbName);
    return db.findInferenceServerByKey(tenantId, serverKey);
  }

  /**
   * Create a new inference server configuration.
   */
  static async createServer(
    tenantDbName: string,
    tenantId: string,
    data: {
      name: string;
      type: IInferenceServer['type'];
      baseUrl: string;
      apiKey?: string;
      pollIntervalSeconds?: number;
    },
    userId: string,
  ): Promise<IInferenceServer> {
    const db = await getTenantDatabase(tenantDbName);
    const key = generateServerKey(data.name);
    return db.createInferenceServer({
      tenantId,
      key,
      name: data.name,
      type: data.type,
      baseUrl: data.baseUrl.replace(/\/+$/, ''),
      // Never persist the plaintext apiKey — only its AES-256-GCM ciphertext.
      apiKey: undefined,
      apiKeySealed: data.apiKey ? sealApiKey(data.apiKey) : undefined,
      pollIntervalSeconds: data.pollIntervalSeconds ?? 60,
      status: 'active',
      createdBy: userId,
    });
  }

  /**
   * Update an existing inference server.
   */
  static async updateServer(
    tenantDbName: string,
    tenantId: string,
    serverKey: string,
    data: Partial<Pick<IInferenceServer, 'name' | 'baseUrl' | 'apiKey' | 'pollIntervalSeconds' | 'status'>>,
    userId: string,
  ): Promise<IInferenceServer | null> {
    const db = await getTenantDatabase(tenantDbName);
    const server = await db.findInferenceServerByKey(tenantId, serverKey);
    if (!server) return null;
    const update: Record<string, unknown> = { updatedBy: userId };
    if (data.name !== undefined) update.name = data.name;
    if (data.baseUrl !== undefined) update.baseUrl = data.baseUrl.replace(/\/+$/, '');
    if (data.apiKey !== undefined) {
      // Re-seal on every change; never persist the plaintext apiKey column
      // (also clears any leftover plaintext from a pre-encryption row).
      update.apiKey = null;
      update.apiKeySealed = data.apiKey ? sealApiKey(data.apiKey) : null;
    }
    if (data.pollIntervalSeconds !== undefined) update.pollIntervalSeconds = data.pollIntervalSeconds;
    if (data.status !== undefined) update.status = data.status;
    return db.updateInferenceServer(String(server._id), update);
  }

  /**
   * Delete an inference server and its metrics.
   */
  static async deleteServer(
    tenantDbName: string,
    tenantId: string,
    serverKey: string,
  ): Promise<boolean> {
    const db = await getTenantDatabase(tenantDbName);
    const server = await db.findInferenceServerByKey(tenantId, serverKey);
    if (!server) return false;
    await db.deleteInferenceServerMetrics(serverKey);
    return db.deleteInferenceServer(String(server._id));
  }

  /**
   * Poll a server right now and store the metrics.
   */
  static async pollServer(
    tenantDbName: string,
    tenantId: string,
    serverKey: string,
  ): Promise<IInferenceServerMetrics> {
    const db = await getTenantDatabase(tenantDbName);
    const server = await db.findInferenceServerByKey(tenantId, serverKey);
    if (!server) throw new Error('Server not found');
    if (server.status === 'disabled') throw new InferenceServerDisabledError(serverKey);

    // Decrypt the apiKey only for this outbound poll call — never persisted
    // or logged in plaintext.
    const pollableServer = { ...server, apiKey: openApiKey(server) };

    try {
      const snapshot =
        server.type === 'llamacpp'
          ? await pollLlamaCppServer(pollableServer)
          : await pollVllmServer(pollableServer);
      const metricsData = snapshotToMetrics(tenantId, serverKey, snapshot);
      const metrics = await db.createInferenceServerMetrics(metricsData);

      // Update server last polled timestamp
      await db.updateInferenceServer(String(server._id), {
        lastPolledAt: new Date(),
        lastError: undefined,
        ...(await pollStatusUpdate(db, tenantId, serverKey, 'active')),
      });

      return metrics;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await db.updateInferenceServer(String(server._id), {
        lastPolledAt: new Date(),
        lastError: errorMessage,
        ...(await pollStatusUpdate(db, tenantId, serverKey, 'errored')),
      });
      throw error;
    }
  }

  /**
   * Get metrics history for a server.
   */
  static async getMetrics(
    tenantDbName: string,
    serverKey: string,
    options?: { from?: string; to?: string; limit?: number },
  ): Promise<IInferenceServerMetrics[]> {
    const db = await getTenantDatabase(tenantDbName);
    return db.listInferenceServerMetrics(serverKey, {
      from: options?.from ? new Date(options.from) : undefined,
      to: options?.to ? new Date(options.to) : undefined,
      limit: options?.limit,
    });
  }
}
