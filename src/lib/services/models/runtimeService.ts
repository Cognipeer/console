import {
  providerRegistry,
  type ModelProviderRuntime,
} from '@/lib/providers';
import { assertProviderEnabled, loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import type { IProviderRecord } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import { runtimePool, hashRuntimeConfig } from '@/lib/core/runtimePool';

const MANAGED_GATEWAY_ONLY = 'This model can only be used through the model gateway.';

export interface ModelRuntimeContext {
  runtime: ModelProviderRuntime;
  record: IProviderRecord;
}

export async function buildModelRuntime(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  projectId?: string,
  options?: { allowManaged?: boolean },
): Promise<ModelRuntimeContext> {
  // Every model call from any service ends up here, so this is where an
  // internal caller (agents, RAG, evaluations) meets a switched-off service.
  await assertServiceEnabled({ tenantId, tenantDbName }, 'models');

  const { record, credentials } = await loadProviderRuntimeData(
    tenantDbName,
    { tenantId, key: providerKey, projectId },
    // Refused before the credentials are opened; the gateway path (allowManaged) meters the call.
    { allowManaged: options?.allowManaged === true, managedMessage: MANAGED_GATEWAY_ONLY },
  );

  assertProviderEnabled(record);

  // A managed record is paid with credits, which only the gateway call path meters (it passes allowManaged). Every other
  // caller (audio, image, moderation, OCR, decisions, evaluators) fails closed in loadProviderRuntimeData, before the
  // credentials are opened. No host registered: never managed.

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
