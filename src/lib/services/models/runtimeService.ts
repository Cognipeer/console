import {
  providerRegistry,
  type ModelProviderRuntime,
} from '@/lib/providers';
import { assertProviderEnabled, loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import type { IProviderRecord } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { runtimePool, hashRuntimeConfig } from '@/lib/core/runtimePool';

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
  // Every model call from any service ends up here, so this is where an
  // internal caller (agents, RAG, evaluations) meets a switched-off service.
  await assertServiceEnabled({ tenantId, tenantDbName }, 'models');

  const { record, credentials } = await loadProviderRuntimeData(
    tenantDbName,
    { tenantId, key: providerKey, projectId },
  );

  assertProviderEnabled(record);

  const allowedTypes = new Set(['model', 'embedding', 'stt', 'tts', 'ocr']);
  if (!allowedTypes.has(record.type)) {
    throw new Error('Provider configuration is not a model/audio/ocr provider.');
  }

  const cacheKey = `model:${tenantId}:${record.key}`;
  // The settings (a baseUrl, a region, an API version, ...) shape the runtime as much as the credentials do: hashed
  // with the credentials only, an edited setting would go unseen until the pooled runtime expired.
  const configHash = hashRuntimeConfig({ driver: record.driver, credentials, settings: record.settings ?? {} });

  const runtime = await runtimePool.getOrCreate<ModelProviderRuntime>(
    cacheKey,
    configHash,
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
