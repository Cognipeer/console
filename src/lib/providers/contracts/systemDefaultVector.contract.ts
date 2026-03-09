import {
  S3VectorsClient,
  CreateIndexCommand,
  DeleteIndexCommand,
  ListIndexesCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  DeleteVectorsCommand,
  GetIndexCommand,
  type PutInputVector,
} from '@aws-sdk/client-s3vectors';
import type { DocumentType } from '@smithy/types';
import type { ProviderContract } from '../types';
import type {
  CreateVectorIndexInput,
  VectorIndexHandle,
  VectorProviderRuntime,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '../domains/vector';

/**
 * System Default Vector Provider — SaaS mode
 *
 * Manages per-tenant AWS S3 Vectors indexes automatically.
 * Index naming: cognipeer-{tenantSlug|tenantId}[-suffix]
 * Provides complete data isolation between tenants.
 */

interface SystemDefaultVectorCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface SystemDefaultVectorSettings {
  region: string;
  vectorBucketName?: string;
  vectorBucketArn?: string;
  indexPrefix?: string;
  defaultDimension?: number;
  defaultDistanceMetric?: 'cosine' | 'euclidean';
}

const INDEX_PREFIX_DEFAULT = 'cognipeer';
const DEFAULT_DIMENSION = 3072;

function buildIndexName(prefix: string, tenantSlug: string | undefined, tenantId: string): string {
  const safeTenant = (tenantSlug || tenantId).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return `${prefix}-${safeTenant}`;
}

function buildBucketInput(settings: SystemDefaultVectorSettings) {
  const arn = settings.vectorBucketArn?.trim();
  const name = settings.vectorBucketName?.trim();
  if (arn) return { vectorBucketArn: arn };
  if (name) return { vectorBucketName: name };
  throw new Error('System Default provider requires either a vectorBucketName or vectorBucketArn setting.');
}

function buildS3Filter(filter: Record<string, unknown> | undefined): DocumentType | undefined {
  if (!filter || Object.keys(filter).length === 0) return undefined;

  const conditions = Object.entries(filter)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const ops = Object.keys(value as object);
        if (ops.some((k) => k.startsWith('$'))) {
          return { [key]: value };
        }
      }
      return { [key]: { $eq: value } };
    });

  if (conditions.length === 0) return undefined;
  const result = conditions.length === 1 ? conditions[0] : { $and: conditions };
  return result as DocumentType;
}

export const SystemDefaultVectorProviderContract: ProviderContract<
  VectorProviderRuntime,
  SystemDefaultVectorCredentials,
  SystemDefaultVectorSettings
> = {
  id: 'system-default',
  version: '1.0.0',
  domains: ['vector'],
  display: {
    label: 'System Default (S3 Vectors)',
    description:
      'SaaS-mode multi-tenant vector provider. Automatically creates per-tenant S3 Vectors indexes with full data isolation.',
  },
  form: {
    sections: [
      {
        title: 'AWS Credentials',
        fields: [
          {
            name: 'accessKeyId',
            label: 'Access Key ID',
            type: 'text',
            required: true,
            description: 'AWS IAM access key ID with S3 Vectors permissions.',
            scope: 'credentials',
          },
          {
            name: 'secretAccessKey',
            label: 'Secret Access Key',
            type: 'password',
            required: true,
            scope: 'credentials',
          },
          {
            name: 'sessionToken',
            label: 'Session Token',
            type: 'password',
            required: false,
            description: 'Optional for temporary credentials (assumed roles).',
            scope: 'credentials',
          },
        ],
      },
      {
        title: 'S3 Vectors Bucket',
        fields: [
          {
            name: 'region',
            label: 'AWS Region',
            type: 'text',
            required: true,
            placeholder: 'us-east-1',
            scope: 'settings',
          },
          {
            name: 'vectorBucketName',
            label: 'Bucket Name',
            type: 'text',
            required: false,
            description: 'S3 Vectors bucket name. Required when Bucket ARN is not set.',
            scope: 'settings',
          },
          {
            name: 'vectorBucketArn',
            label: 'Bucket ARN',
            type: 'text',
            required: false,
            description: 'S3 Vectors bucket ARN. Takes priority over Bucket Name.',
            scope: 'settings',
          },
        ],
      },
      {
        title: 'Index Settings',
        fields: [
          {
            name: 'indexPrefix',
            label: 'Index Name Prefix',
            type: 'text',
            required: false,
            placeholder: 'cognipeer',
            description: 'Prefix used when naming per-tenant indexes.',
            scope: 'settings',
          },
          {
            name: 'defaultDimension',
            label: 'Default Dimension',
            type: 'number',
            required: false,
            placeholder: '3072',
            scope: 'settings',
          },
          {
            name: 'defaultDistanceMetric',
            label: 'Distance Metric',
            type: 'select',
            required: false,
            defaultValue: 'cosine',
            options: [
              { label: 'Cosine', value: 'cosine' },
              { label: 'Euclidean', value: 'euclidean' },
            ],
            scope: 'settings',
          },
        ],
      },
    ],
  },
  capabilities: {
    supportsUpsert: true,
    supportsQuery: true,
    supportsDelete: true,
    multiTenant: true,
  },
  async createRuntime({ credentials, settings, tenantId, tenantSlug, providerKey, logger }) {
    if (!credentials?.accessKeyId?.trim()) {
      throw new Error('System Default provider requires an AWS accessKeyId credential.');
    }
    if (!credentials?.secretAccessKey?.trim()) {
      throw new Error('System Default provider requires an AWS secretAccessKey credential.');
    }
    if (!settings?.region?.trim()) {
      throw new Error('System Default provider requires an AWS region setting.');
    }

    const bucketInput = buildBucketInput(settings);
    const dimension = Number(settings.defaultDimension) > 0
      ? Number(settings.defaultDimension)
      : DEFAULT_DIMENSION;
    const distanceMetric = settings.defaultDistanceMetric ?? 'cosine';
    const prefix = settings.indexPrefix?.trim() || INDEX_PREFIX_DEFAULT;

    const client = new S3VectorsClient({
      region: settings.region.trim(),
      credentials: {
        accessKeyId: credentials.accessKeyId.trim(),
        secretAccessKey: credentials.secretAccessKey,
        ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
      },
    });

    const tenantIndexName = buildIndexName(prefix, tenantSlug, tenantId);

    const runtime: VectorProviderRuntime = {
      async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
        const indexName = input.name || tenantIndexName;
        const dim = input.dimension || dimension;
        const metric = input.metric ?? distanceMetric;
        const awsMetric = metric === 'euclidean' ? 'euclidean' : 'cosine';

        try {
          await client.send(new GetIndexCommand({ ...bucketInput, indexName }));
          logger?.info?.('System default index already exists', { providerKey, indexName });
        } catch (err: unknown) {
          const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
          const isNotFound = e.name === 'ResourceNotFoundException' ||
            e.name === 'NotFoundException' ||
            e.$metadata?.httpStatusCode === 404;

          if (!isNotFound) throw err;

          await client.send(
            new CreateIndexCommand({
              ...bucketInput,
              indexName,
              dataType: 'float32',
              dimension: dim,
              distanceMetric: awsMetric,

            }),
          );
          logger?.info?.('System default tenant index created', { providerKey, indexName, tenantId });
        }

        return {
          externalId: indexName,
          name: indexName,
          dimension: dim,
          metric: awsMetric as VectorIndexHandle['metric'],
          metadata: {
            ...input.metadata,
            indexName,
            tenantId,
            tenantSlug,
            provider: 'system-default',
          },
        };
      },

      async deleteIndex({ externalId }: { externalId: string }): Promise<void> {
        await client.send(new DeleteIndexCommand({ ...bucketInput, indexName: externalId }));
        logger?.info?.('System default index deleted', { providerKey, externalId });
      },

      async listIndexes(): Promise<VectorIndexHandle[]> {
        const response = await client.send(new ListIndexesCommand(bucketInput));
        const summaries = response.indexes ?? [];
        const handles: VectorIndexHandle[] = [];

        for (const summary of summaries) {
          if (!summary.indexName) continue;
          try {
            const detail = await client.send(
              new GetIndexCommand({ ...bucketInput, indexName: summary.indexName }),
            );
            const idx = detail.index;
            handles.push({
              externalId: summary.indexArn ?? summary.indexName,
              name: summary.indexName,
              dimension: idx?.dimension ?? dimension,
              metric: ((idx?.distanceMetric ?? distanceMetric) as VectorIndexHandle['metric']),
              metadata: { provider: 'system-default', tenantId },
            });
          } catch {
            handles.push({
              externalId: summary.indexArn ?? summary.indexName,
              name: summary.indexName,
              dimension,
              metric: distanceMetric as VectorIndexHandle['metric'],
              metadata: { provider: 'system-default', tenantId },
            });
          }
        }

        return handles;
      },

      async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]): Promise<void> {
        if (items.length === 0) return;
        const vectors: PutInputVector[] = items.map((item) => {
          const vectorInput: PutInputVector = {
            key: item.id,
            data: {
              float32: item.values.map((v) => Number(v)),
            },
          };
          if (item.metadata != null) {
            vectorInput.metadata = item.metadata as DocumentType;
          }
          return vectorInput;
        });

        await client.send(
          new PutVectorsCommand({ ...bucketInput, indexName: handle.externalId, vectors }),
        );

        logger?.debug?.('System default upserted vectors', { providerKey, count: items.length });
      },

      async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
        const response = await client.send(
          new QueryVectorsCommand({
            ...bucketInput,
            indexName: handle.externalId,
            queryVector: { float32: query.vector.map((v) => Number(v)) },
            topK: query.topK,
            filter: buildS3Filter(query.filter),
          }),
        );

        const vectors = response.vectors ?? [];
        return {
          matches: vectors.map((v) => ({
            id: v.key ?? '',
            score: v.distance ?? 0,
            metadata: v.metadata
              ? Object.fromEntries(
                  Object.entries(v.metadata as Record<string, { stringValue?: string; booleanValue?: boolean; doubleValue?: number }>).map(
                    ([k, val]) => [
                      k,
                      val.stringValue ?? val.booleanValue ?? val.doubleValue ?? null,
                    ],
                  ),
                )
              : undefined,
          })),
        };
      },

      async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await client.send(
          new DeleteVectorsCommand({ ...bucketInput, indexName: handle.externalId, keys: ids }),
        );
        logger?.debug?.('System default deleted vectors', { providerKey, count: ids.length });
      },
    };

    return runtime;
  },
};
