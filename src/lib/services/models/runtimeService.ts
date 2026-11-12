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

/**
 * The config hash of a provider load. `loadProviderRuntimeData` hands the same object to every call that is served
 * from its in-process copy, so keying by that object reuses one hash (a sorted JSON.stringify + sha256) until the
 * copy is dropped; a load built afresh (every managed call) is simply hashed again.
 */
const configHashes = new WeakMap<object, string>();

export interface ModelRuntimeContext {
  runtime: ModelProviderRuntime;
  record: IProviderRecord;
  /** Managed call only: the connection the runtime was built from. */
  managedConnectionId?: string;
}

export async function buildModelRuntime(
  tenantDbName: string,
  tenantId: string,
  providerKey: string,
  projectId?: string,
  options?: { allowManaged?: boolean; managedConnectionId?: string },
): Promise<ModelRuntimeContext> {
  // Every model call from any service ends up here, so this is where an
  // internal caller (agents, RAG, evaluations) meets a switched-off service.
  await assertServiceEnabled({ tenantId, tenantDbName }, 'models');

  const loaded = await loadProviderRuntimeData(
    tenantDbName,
    { tenantId, key: providerKey, projectId },
    // Refused before the credentials are opened; the gateway path (allowManaged) meters the call.
    {
      allowManaged: options?.allowManaged === true,
      managedMessage: MANAGED_GATEWAY_ONLY,
      managedConnectionId: options?.managedConnectionId,
      reuse: true,
    },
  );
  const { record, credentials, managedConnection } = loaded;

  assertProviderEnabled(record);

  // A managed record is paid with credits, which only the gateway call path meters (it passes allowManaged). Every other
  // caller (audio, image, moderation, OCR, decisions, evaluators) fails closed in loadProviderRuntimeData, before the
  // credentials are opened. No host registered: never managed.

  const allowedTypes = new Set(['model', 'embedding', 'stt', 'tts', 'ocr']);
  if (!allowedTypes.has(record.type)) {
    throw new Error('Provider configuration is not a model/audio/ocr provider.');
  }

  // A managed call is built from the route's connection, not the record: one pooled runtime per connection.
  const runtimeDriver = managedConnection?.driver ?? record.driver;
  const runtimeSettings = managedConnection?.settings ?? record.settings ?? {};
  const cacheKey = managedConnection
    ? `model:${tenantId}:${record.key}:${managedConnection.id}`
    : `model:${tenantId}:${record.key}`;
  // The settings (a baseUrl, a region, an API version, ...) shape the runtime as much as the credentials do: hashed
  // with the credentials only, an edited setting would go unseen until the pooled runtime expired.
  let configHash = configHashes.get(loaded);
  if (configHash === undefined) {
    configHash = hashRuntimeConfig({ driver: runtimeDriver, credentials, settings: runtimeSettings });
    configHashes.set(loaded, configHash);
  }

  const runtime = await runtimePool.getOrCreate<ModelProviderRuntime>(
    cacheKey,
    configHash,
    async () => {
      const providerLog = createLogger(`model:${record.key}`);
      return providerRegistry.createRuntime<ModelProviderRuntime>(
        runtimeDriver,
        {
          tenantId,
          projectId,
          providerKey: record.key,
          credentials,
          settings: runtimeSettings,
          metadata: managedConnection ? {} : record.metadata ?? {},
          logger: providerLog,
        },
      );
    },
  );

  return {
    runtime,
    record,
    ...(managedConnection ? { managedConnectionId: managedConnection.id } : {}),
  };
}
