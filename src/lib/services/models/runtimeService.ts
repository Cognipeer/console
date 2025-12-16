import {
  providerRegistry,
  type ModelProviderRuntime,
} from '@/lib/providers';
import { loadProviderRuntimeData } from '@/lib/services/providers/providerService';
import type { IProviderRecord } from '@/lib/database';

function createLogger(providerKey: string) {
  const scope = `[model:${providerKey}]`;
  return {
    debug: (...args: unknown[]) => console.debug(scope, ...args),
    info: (...args: unknown[]) => console.info(scope, ...args),
    warn: (...args: unknown[]) => console.warn(scope, ...args),
    error: (...args: unknown[]) => console.error(scope, ...args),
  };
}

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

  const logger = createLogger(record.key);

  const runtime = await providerRegistry.createRuntime<ModelProviderRuntime>(
    record.driver,
    {
      tenantId,
      projectId,
      providerKey: record.key,
      credentials,
      settings: record.settings ?? {},
      metadata: record.metadata ?? {},
      logger,
    },
  );

  return {
    runtime,
    record,
  };
}
