import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));
vi.mock('@/lib/services/inferenceMonitoring/vllmPoller', () => ({
  pollVllmServer: vi.fn().mockResolvedValue({ requestsRunning: 2, gpuUsage: 0.75 }),
  snapshotToMetrics: vi.fn().mockReturnValue({ tenantId: 'tenant-1', serverKey: 'srv-1', gpuUsage: 0.75 }),
}));
vi.mock('@/lib/services/inferenceMonitoring/llamacppPoller', () => ({
  pollLlamaCppServer: vi.fn().mockResolvedValue({ requestsRunning: 1 }),
}));
vi.mock('slugify', () => ({
  default: vi.fn().mockReturnValue('my-server'),
}));

import { InferenceMonitoringService } from '@/lib/services/inferenceMonitoring/inferenceMonitoringService';
import { getTenantDatabase } from '@/lib/database';
import { pollVllmServer, snapshotToMetrics } from '@/lib/services/inferenceMonitoring/vllmPoller';
import { pollLlamaCppServer } from '@/lib/services/inferenceMonitoring/llamacppPoller';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const USER_ID = 'user-1';

const mockServer = {
  _id: 'srv-1',
  tenantId: TENANT_ID,
  key: 'my-vllm-server',
  name: 'My vLLM Server',
  type: 'vllm' as const,
  baseUrl: 'http://localhost:8000',
  pollIntervalSeconds: 60,
  status: 'active' as const,
  createdBy: USER_ID,
};

const mockMetrics = {
  _id: 'metrics-1',
  tenantId: TENANT_ID,
  serverKey: 'my-vllm-server',
  gpuUsage: 0.75,
  requestQueueDepth: 2,
  capturedAt: new Date(),
  timestamp: new Date(),
};

describe('InferenceMonitoringService', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  // ─── listServers ────────────────────────────────────────────────────

  describe('listServers', () => {
    it('returns all servers for tenant', async () => {
      db.listInferenceServers.mockResolvedValue([mockServer]);
      const result = await InferenceMonitoringService.listServers(DB_NAME, TENANT_ID);
      expect(result).toHaveLength(1);
      expect(db.listInferenceServers).toHaveBeenCalledWith(TENANT_ID);
    });

    it('uses getTenantDatabase', async () => {
      db.listInferenceServers.mockResolvedValue([]);
      await InferenceMonitoringService.listServers(DB_NAME, TENANT_ID);
      expect(getTenantDatabase).toHaveBeenCalledWith(DB_NAME);
    });

    it('returns empty list when no servers', async () => {
      const result = await InferenceMonitoringService.listServers(DB_NAME, TENANT_ID);
      expect(result).toEqual([]);
    });
  });

  // ─── getServerByKey ─────────────────────────────────────────────────

  describe('getServerByKey', () => {
    it('returns server by key', async () => {
      db.findInferenceServerByKey.mockResolvedValue(mockServer);
      const result = await InferenceMonitoringService.getServerByKey(DB_NAME, TENANT_ID, 'my-vllm-server');
      expect(result).toMatchObject({ key: 'my-vllm-server' });
    });

    it('returns null when not found', async () => {
      db.findInferenceServerByKey.mockResolvedValue(null);
      const result = await InferenceMonitoringService.getServerByKey(DB_NAME, TENANT_ID, 'missing');
      expect(result).toBeNull();
    });
  });

  // ─── createServer ───────────────────────────────────────────────────

  describe('createServer', () => {
    it('creates a server with generated key', async () => {
      db.createInferenceServer.mockResolvedValue(mockServer);
      const result = await InferenceMonitoringService.createServer(
        DB_NAME, TENANT_ID,
        { name: 'My Server', type: 'vllm', baseUrl: 'http://localhost:8000' },
        USER_ID,
      );
      expect(db.createInferenceServer).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_ID, type: 'vllm', createdBy: USER_ID }),
      );
      expect(result).toBeTruthy();
    });

    it('strips trailing slashes from baseUrl', async () => {
      db.createInferenceServer.mockResolvedValue(mockServer);
      await InferenceMonitoringService.createServer(
        DB_NAME, TENANT_ID,
        { name: 'My Server', type: 'vllm', baseUrl: 'http://localhost:8000///' },
        USER_ID,
      );
      expect(db.createInferenceServer).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://localhost:8000' }),
      );
    });

    it('defaults pollIntervalSeconds to 60', async () => {
      db.createInferenceServer.mockResolvedValue(mockServer);
      await InferenceMonitoringService.createServer(
        DB_NAME, TENANT_ID,
        { name: 'My Server', type: 'vllm', baseUrl: 'http://localhost:8000' },
        USER_ID,
      );
      expect(db.createInferenceServer).toHaveBeenCalledWith(
        expect.objectContaining({ pollIntervalSeconds: 60 }),
      );
    });

    it('sets status to active on creation', async () => {
      db.createInferenceServer.mockResolvedValue(mockServer);
      await InferenceMonitoringService.createServer(
        DB_NAME, TENANT_ID,
        { name: 'My Server', type: 'vllm', baseUrl: 'http://localhost:8000' },
        USER_ID,
      );
      expect(db.createInferenceServer).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' }),
      );
    });
  });

  // ─── updateServer ───────────────────────────────────────────────────

  describe('updateServer', () => {
    it('returns null when server not found', async () => {
      db.findInferenceServerByKey.mockResolvedValue(null);
      const result = await InferenceMonitoringService.updateServer(DB_NAME, TENANT_ID, 'unknown', { name: 'New' }, USER_ID);
      expect(result).toBeNull();
    });

    it('updates server fields', async () => {
      db.findInferenceServerByKey.mockResolvedValue(mockServer);
      db.updateInferenceServer.mockResolvedValue({ ...mockServer, name: 'Updated' });
      const result = await InferenceMonitoringService.updateServer(DB_NAME, TENANT_ID, 'my-vllm-server', { name: 'Updated' }, USER_ID);
      expect(db.updateInferenceServer).toHaveBeenCalledWith('srv-1', expect.objectContaining({ name: 'Updated', updatedBy: USER_ID }));
      expect(result?.name).toBe('Updated');
    });

    it('strips trailing slashes when updating baseUrl', async () => {
      db.findInferenceServerByKey.mockResolvedValue(mockServer);
      db.updateInferenceServer.mockResolvedValue(mockServer);
      await InferenceMonitoringService.updateServer(DB_NAME, TENANT_ID, 'my-vllm-server', { baseUrl: 'http://new:9000///' }, USER_ID);
      expect(db.updateInferenceServer).toHaveBeenCalledWith('srv-1', expect.objectContaining({ baseUrl: 'http://new:9000' }));
    });

    it('only passes defined fields', async () => {
      db.findInferenceServerByKey.mockResolvedValue(mockServer);
      db.updateInferenceServer.mockResolvedValue(mockServer);
      await InferenceMonitoringService.updateServer(DB_NAME, TENANT_ID, 'my-vllm-server', { status: 'inactive' as never }, USER_ID);
      const call = (db.updateInferenceServer as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(call.name).toBeUndefined();
    });
  });

  // ─── deleteServer ───────────────────────────────────────────────────

  describe('deleteServer', () => {
    it('returns false when server not found', async () => {
      db.findInferenceServerByKey.mockResolvedValue(null);
      const result = await InferenceMonitoringService.deleteServer(DB_NAME, TENANT_ID, 'missing');
      expect(result).toBe(false);
    });

    it('deletes metrics then server', async () => {
      db.findInferenceServerByKey.mockResolvedValue(mockServer);
      db.deleteInferenceServer.mockResolvedValue(true);
      db.deleteInferenceServerMetrics.mockResolvedValue(5);
      const result = await InferenceMonitoringService.deleteServer(DB_NAME, TENANT_ID, 'my-vllm-server');
      expect(db.deleteInferenceServerMetrics).toHaveBeenCalledWith('my-vllm-server');
      expect(db.deleteInferenceServer).toHaveBeenCalledWith('srv-1');
      expect(result).toBe(true);
    });
  });

  // ─── pollServer ─────────────────────────────────────────────────────

  describe('pollServer', () => {
    beforeEach(() => {
      db.findInferenceServerByKey.mockResolvedValue(mockServer);
      db.createInferenceServerMetrics.mockResolvedValue(mockMetrics);
      db.updateInferenceServer.mockResolvedValue(mockServer);
    });

    it('throws if server not found', async () => {
      db.findInferenceServerByKey.mockResolvedValue(null);
      await expect(InferenceMonitoringService.pollServer(DB_NAME, TENANT_ID, 'unknown')).rejects.toThrow('Server not found');
    });

    it('polls vllm server for vllm type', async () => {
      await InferenceMonitoringService.pollServer(DB_NAME, TENANT_ID, 'my-vllm-server');
      expect(pollVllmServer).toHaveBeenCalledWith(mockServer);
    });

    it('polls llamacpp server for llamacpp type', async () => {
      db.findInferenceServerByKey.mockResolvedValue({ ...mockServer, type: 'llamacpp' });
      await InferenceMonitoringService.pollServer(DB_NAME, TENANT_ID, 'my-vllm-server');
      expect(pollLlamaCppServer).toHaveBeenCalled();
    });

    it('stores metrics after polling', async () => {
      await InferenceMonitoringService.pollServer(DB_NAME, TENANT_ID, 'my-vllm-server');
      expect(db.createInferenceServerMetrics).toHaveBeenCalled();
    });

    it('updates lastPolledAt and sets status active on success', async () => {
      await InferenceMonitoringService.pollServer(DB_NAME, TENANT_ID, 'my-vllm-server');
      expect(db.updateInferenceServer).toHaveBeenCalledWith(
        'srv-1',
        expect.objectContaining({ status: 'active', lastPolledAt: expect.any(Date) }),
      );
    });

    it('marks server as errored and rethrows on poll failure', async () => {
      (pollVllmServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Connection refused'));
      await expect(InferenceMonitoringService.pollServer(DB_NAME, TENANT_ID, 'my-vllm-server')).rejects.toThrow('Connection refused');
      expect(db.updateInferenceServer).toHaveBeenCalledWith(
        'srv-1',
        expect.objectContaining({ status: 'errored', lastError: 'Connection refused' }),
      );
    });

    it('returns the stored metrics', async () => {
      const result = await InferenceMonitoringService.pollServer(DB_NAME, TENANT_ID, 'my-vllm-server');
      expect(result).toMatchObject({ tenantId: TENANT_ID, serverKey: 'my-vllm-server' });
    });
  });

  // ─── getMetrics ─────────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('returns metrics list', async () => {
      db.listInferenceServerMetrics.mockResolvedValue([mockMetrics]);
      const result = await InferenceMonitoringService.getMetrics(DB_NAME, 'my-vllm-server');
      expect(result).toHaveLength(1);
      expect(db.listInferenceServerMetrics).toHaveBeenCalledWith('my-vllm-server', expect.any(Object));
    });

    it('converts from/to date strings to Date objects', async () => {
      db.listInferenceServerMetrics.mockResolvedValue([]);
      await InferenceMonitoringService.getMetrics(DB_NAME, 'srv', { from: '2025-01-01', to: '2025-01-31' });
      expect(db.listInferenceServerMetrics).toHaveBeenCalledWith('srv', {
        from: expect.any(Date),
        to: expect.any(Date),
        limit: undefined,
      });
    });

    it('supports limit option', async () => {
      db.listInferenceServerMetrics.mockResolvedValue([]);
      await InferenceMonitoringService.getMetrics(DB_NAME, 'srv', { limit: 50 });
      expect(db.listInferenceServerMetrics).toHaveBeenCalledWith('srv', expect.objectContaining({ limit: 50 }));
    });
  });
});
