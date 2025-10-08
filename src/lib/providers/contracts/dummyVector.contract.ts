import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '../domains/vector';

interface DummyVectorCredentials {
  apiKey: string;
}

interface DummyVectorSettings {
  defaultDimension?: number;
}

interface DummyVectorRuntimeState {
  indexes: Map<string, VectorIndexHandle>;
}

function createHandle(
  input: CreateVectorIndexInput,
  runtimeState: DummyVectorRuntimeState,
): VectorIndexHandle {
  const metric = input.metric ?? 'cosine';
  const externalId = `dummy-${Math.random().toString(36).slice(2, 10)}`;
  const handle: VectorIndexHandle = {
    externalId,
    name: input.name,
    dimension: input.dimension,
    metric,
    metadata: input.metadata,
  };
  runtimeState.indexes.set(externalId, handle);
  return handle;
}

function mockQueryResult(
  query: VectorQueryInput,
  indexes: Map<string, VectorIndexHandle>,
): VectorQueryResult {
  const matches = Array.from(indexes.values()).map((index, idx) => ({
    id: `${index.externalId}-${idx}`,
    score: Math.max(0, 1 - idx * 0.1),
    metadata: {
      index: index.name,
      dimension: index.dimension,
    },
  }));

  return {
    matches: matches.slice(0, query.topK),
    usage: {
      dummy: true,
      queriedAt: new Date().toISOString(),
    },
  };
}

export const DummyVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  DummyVectorCredentials,
  DummyVectorSettings
> = {
  id: 'dummy-vector',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'Dummy Vector Provider',
    description:
      'Test provider that simulates vector index operations without external dependencies.',
  },
  form: {
    sections: [
      {
        title: 'Authentication',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'text',
            required: true,
            description: 'Any non-empty value will satisfy the dummy provider.',
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'defaultDimension',
            label: 'Default Dimension',
            type: 'number',
            required: false,
            description:
              'Optional default dimension used when one is not specified for new indexes.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  capabilities: {
    supportsUpsert: true,
    supportsQuery: true,
  },
  async createRuntime({ providerKey, credentials, settings, logger }) {
    if (!credentials?.apiKey) {
      throw new Error('Dummy vector provider requires an apiKey credential.');
    }

    const runtimeState: DummyVectorRuntimeState = {
      indexes: new Map<string, VectorIndexHandle>(),
    };

    const runtime: VectorProviderRuntime = {
      async createIndex(input) {
        const dimension = input.dimension || settings?.defaultDimension || 1536;
        const handle = createHandle(
          { ...input, dimension },
          runtimeState,
        );
        logger?.info?.('Dummy provider created index', {
          providerKey,
          externalId: handle.externalId,
        });
        return handle;
      },
      async deleteIndex({ externalId }) {
        runtimeState.indexes.delete(externalId);
        logger?.info?.('Dummy provider deleted index', {
          providerKey,
          externalId,
        });
      },
      async listIndexes() {
        return Array.from(runtimeState.indexes.values());
      },
      async upsertVectors(handle, items: VectorUpsertItem[]) {
        logger?.debug?.('Dummy provider upserted vectors', {
          providerKey,
          externalId: handle.externalId,
          count: items.length,
        });
      },
      async deleteVectors(handle, ids: string[]) {
        logger?.debug?.('Dummy provider deleted vectors', {
          providerKey,
          externalId: handle.externalId,
          count: ids.length,
        });
      },
      async queryVectors(handle, query: VectorQueryInput) {
        logger?.debug?.('Dummy provider query', {
          providerKey,
          externalId: handle.externalId,
        });
        return mockQueryResult(query, runtimeState.indexes);
      },
    };

    return runtime;
  },
};
