import { getTenantDatabase } from '@/lib/database';
import type { IInferenceServer, IInferenceServerMetrics } from '@/lib/database';
import { pollVllmServer, snapshotToMetrics } from './vllmPoller';
import slugify from 'slugify';

function generateServerKey(name: string): string {
  return slugify(name, { lower: true, strict: true, trim: true }) + '-' + Date.now().toString(36);
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
      apiKey: data.apiKey,
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
    if (data.apiKey !== undefined) update.apiKey = data.apiKey;
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

    try {
      const snapshot = await pollVllmServer(server);
      const metricsData = snapshotToMetrics(tenantId, serverKey, snapshot);
      const metrics = await db.createInferenceServerMetrics(metricsData);

      // Update server last polled timestamp
      await db.updateInferenceServer(String(server._id), {
        lastPolledAt: new Date(),
        lastError: undefined,
        status: 'active',
      });

      return metrics;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await db.updateInferenceServer(String(server._id), {
        lastPolledAt: new Date(),
        lastError: errorMessage,
        status: 'errored',
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
