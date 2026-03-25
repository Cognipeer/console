import {
  providerRegistry,
  type ModelProviderRuntime,
} from '@/lib/providers';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import type { IProviderRecord } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { runtimePool, hashCredentials } from '@/lib/core/runtimePool';

export interface ModelRuntimeContext {
  runtime: ModelProviderRuntime;
  record: IProviderRecord;
}

export async function buildModelRuntime(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  projectId?: string,
): Promise<ModelRuntimeContext> {
  const { record, credentials } = await loadProviderRuntimeData(
    tenantDbName,
    { tenantId, key: providerKey, projectId },
  );

  if (record.type !== 'model') {
    throw new Error('Provider configuration is not a model provider.');
  }

  const cacheKey = `model:${tenantId}:${record.key}`;
  const credHash = hashCredentials(credentials);

  const runtime = await runtimePool.getOrCreate<ModelProviderRuntime>(
    cacheKey,
    credHash,
    async () => {
      const providerLog = createLogger(`model:${record.key}`);
      return providerRegistry.createRuntime<ModelProviderRuntime>(
        record.driver,
        {
          tenantId,
          projectId,
          providerKey: record.key,
          credentials,
          settings: record.settings ?? {},
          metadata: record.metadata ?? {},
          logger: providerLog,
        },
      );
    },
  );

  return {
    runtime,
    record,
  };
}
