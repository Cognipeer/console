import {
    CreateIndexCommand,
    DeleteIndexCommand,
    DeleteVectorsCommand,
    GetIndexCommand,
    ListIndexesCommand,
    ListVectorsCommand,
    PutVectorsCommand,
    QueryVectorsCommand,
    S3VectorsClient,
    type CreateIndexCommandInput,
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
    VectorListInput,
    VectorListResult,
} from '../domains/vector';

interface AwsS3VectorsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

interface AwsS3VectorsSettings {
    region: string;
    vectorBucketName?: string;
    vectorBucketArn?: string;
    defaultDistanceMetric?: 'cosine' | 'euclidean';
}

type BucketCommandInput = Pick<CreateIndexCommandInput, 'vectorBucketName' | 'vectorBucketArn'>;

interface BucketMetadata {
    bucketName?: string;
    bucketArn?: string;
}

interface RuntimeContext {
    client: S3VectorsClient;
    bucketInput: BucketCommandInput;
    bucketMetadata: BucketMetadata;
    defaultDistanceMetric: 'cosine' | 'euclidean';
}

type AwsDistanceMetric = 'cosine' | 'euclidean';

type IndexSource = {
    indexArn?: string;
    indexName?: string;
    vectorBucketName?: string;
};

function ensurePresent<T>(value: T | null | undefined, message: string): T {
    if (value === null || value === undefined || value === '') {
        throw new Error(message);
    }
    return value;
}

const BUCKET_RESOURCE_PREFIX = 'bucket/';

const BUCKET_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/;

function normalizeBucketArn(rawArn: string): { normalizedArn: string; bucketName?: string } {
    const trimmed = rawArn.trim();
    const bucketSegmentIndex = trimmed.indexOf(BUCKET_RESOURCE_PREFIX);

    if (bucketSegmentIndex === -1) {
        return { normalizedArn: trimmed };
    }

    const bucketNameStart = bucketSegmentIndex + BUCKET_RESOURCE_PREFIX.length;
    let bucketNameEnd = trimmed.indexOf('/', bucketNameStart);

    if (bucketNameEnd === -1) {
        bucketNameEnd = trimmed.length;
    }

    const bucketName = trimmed.slice(bucketNameStart, bucketNameEnd).trim();

    const normalizedArn = `${trimmed.slice(0, bucketSegmentIndex + BUCKET_RESOURCE_PREFIX.length)}${bucketName}`;

    return {
        normalizedArn,
        bucketName: bucketName || undefined,
    };
}

function isValidBucketArn(arn: string): boolean {
    const trimmed = arn.trim();

    if (!trimmed.startsWith('arn:')) {
        return false;
    }

    const segments = trimmed.split(':');

    if (segments.length < 6) {
        return false;
    }

    const service = segments[2];
    if (service !== 's3vectors') {
        return false;
    }

    const resource = segments.slice(5).join(':');
    if (!resource.startsWith(BUCKET_RESOURCE_PREFIX)) {
        return false;
    }

    const bucketName = resource.slice(BUCKET_RESOURCE_PREFIX.length);
    if (!bucketName || bucketName.includes('/')) {
        return false;
    }

    return BUCKET_NAME_PATTERN.test(bucketName);
}

function toAwsDocument(value: unknown): DocumentType | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value === null) {
        return null;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        const result: DocumentType[] = [];
        for (const entry of value) {
            const converted = toAwsDocument(entry);
            result.push(converted ?? null);
        }
        return result;
    }

    if (typeof value === 'object') {
        const result: Record<string, DocumentType> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            const converted = toAwsDocument(entry);
            if (converted !== undefined) {
                result[key] = converted;
            }
        }
        return result;
    }

    return String(value);
}

function resolveBucketInput(settings: AwsS3VectorsSettings): {
    bucketInput: BucketCommandInput;
    bucketMetadata: BucketMetadata;
} {
    const rawArn = settings.vectorBucketArn?.trim();
    const rawBucketName = settings.vectorBucketName?.trim();

    if (rawArn) {
        const { normalizedArn, bucketName: inferredBucketName } = normalizeBucketArn(rawArn);

        if (isValidBucketArn(normalizedArn)) {
            const bucketName = rawBucketName || inferredBucketName;
            return {
                bucketInput: {
                    vectorBucketArn: normalizedArn,
                    vectorBucketName: bucketName,
                },
                bucketMetadata: {
                    bucketArn: normalizedArn,
                    bucketName: bucketName ?? undefined,
                },
            };
        }

        if (rawBucketName) {
            return {
                bucketInput: { vectorBucketName: rawBucketName },
                bucketMetadata: {
                    bucketName: rawBucketName,
                },
            };
        }

        if (inferredBucketName) {
            return {
                bucketInput: { vectorBucketName: inferredBucketName },
                bucketMetadata: {
                    bucketName: inferredBucketName,
                    bucketArn: normalizedArn,
                },
            };
        }

        throw new Error(
            'Invalid vectorBucketArn format. Expected ARN resource-id form "bucket/<bucket-name>".',
        );
    }

    if (rawBucketName) {
        return {
            bucketInput: { vectorBucketName: rawBucketName },
            bucketMetadata: {
                bucketName: rawBucketName,
            },
        };
    }

    throw new Error(
        'AWS S3 Vectors provider requires either a vectorBucketName or vectorBucketArn setting.',
    );
}

function toAwsMetric(metric?: string | null): AwsDistanceMetric {
    if (!metric) {
        return 'cosine';
    }

    const normalized = metric.toLowerCase();
    if (normalized === 'cosine' || normalized === 'euclidean') {
        return normalized;
    }

    throw new Error(`S3 Vectors does not support the distance metric "${metric}".`);
}

function buildHandle(
    from: {
        indexArn: string;
        indexName: string;
        vectorBucketName: string;
        dimension: number;
        distanceMetric: AwsDistanceMetric;
        dataType?: string;
        creationTime?: Date;
    },
    metadata: Record<string, unknown> = {},
    bucketContext: BucketMetadata = {},
): VectorIndexHandle {
    const metadataRecord = { ...metadata } as Record<string, unknown>;
    const ensureString = (value: unknown): string | undefined =>
        typeof value === 'string' && value.trim() !== '' ? value : undefined;

    const combinedMetadata: Record<string, unknown> = {
        ...metadataRecord,
        indexArn: ensureString(metadataRecord.indexArn) ?? from.indexArn,
        indexName: ensureString(metadataRecord.indexName) ?? from.indexName,
        bucketName: ensureString(metadataRecord.bucketName) ?? from.vectorBucketName,
        bucketArn: ensureString(metadataRecord.bucketArn) ?? bucketContext.bucketArn,
        dataType: ensureString(metadataRecord.dataType) ?? from.dataType ?? 'float32',
        creationTime:
            ensureString(metadataRecord.creationTime) ?? from.creationTime?.toISOString(),
        provider: metadataRecord.provider ?? 'aws-s3vectors',
    };

    return {
        externalId: from.indexArn,
        name: from.indexName,
        dimension: from.dimension,
        metric: from.distanceMetric,
        metadata: combinedMetadata,
    };
}

function extractIndexSource(handle: VectorIndexHandle): IndexSource {
    const metadata = handle.metadata ?? {};
    const metaArn = typeof metadata.indexArn === 'string' ? metadata.indexArn : undefined;
    const metaName = typeof metadata.indexName === 'string' ? metadata.indexName : undefined;

    if (metaArn) {
        return { indexArn: metaArn };
    }

    if (handle.externalId.startsWith('arn:')) {
        return { indexArn: handle.externalId };
    }

    if (metaName) {
        return { indexName: metaName };
    }

    return { indexArn: handle.externalId };
}

function isIndexNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }

    const err = error as {
        name?: string;
        code?: string;
        Code?: string;
        message?: string;
        $metadata?: { httpStatusCode?: number };
    };

    const identifiers = [err.name, err.code, err.Code].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
    );

    if (identifiers.some((value) => value === 'ResourceNotFoundException' || value === 'NotFoundException')) {
        return true;
    }

    if (err.$metadata?.httpStatusCode === 404) {
        return true;
    }

    if (typeof err.message === 'string') {
        const normalized = err.message.toLowerCase();
        if (normalized.includes('resource not found') || normalized.includes('index not found')) {
            return true;
        }
    }

    return false;
}

async function fetchIndexHandle(
    client: S3VectorsClient,
    source: IndexSource,
    bucketContext: Pick<RuntimeContext, 'bucketInput' | 'bucketMetadata'>,
): Promise<VectorIndexHandle> {
    const response = await client.send(
        new GetIndexCommand({
            indexName: source.indexName,
            vectorBucketName: bucketContext.bucketInput.vectorBucketName,
        }),
    );

    const index = ensurePresent(response.index, 'Index metadata missing from AWS response.');

    return buildHandle(
        {
            indexArn: ensurePresent(index.indexArn, 'Index ARN missing.'),
            indexName: ensurePresent(index.indexName, 'Index name missing.'),
            vectorBucketName: ensurePresent(index.vectorBucketName, 'Vector bucket missing.'),
            dimension: ensurePresent(index.dimension, 'Index dimension missing.'),
            distanceMetric: ensurePresent(index.distanceMetric, 'Index distance metric missing.') as AwsDistanceMetric,
            dataType: index.dataType,
            creationTime: index.creationTime,
        },
        { metadataConfiguration: index.metadataConfiguration },
        bucketContext.bucketMetadata,
    );
}

function createRuntimeContext(
    credentials: AwsS3VectorsCredentials,
    settings: AwsS3VectorsSettings,
    providerKey: string,
) {
    const accessKeyId = ensurePresent(credentials.accessKeyId, 'AWS accessKeyId is required.');
    const secretAccessKey = ensurePresent(credentials.secretAccessKey, 'AWS secretAccessKey is required.');
    const region = ensurePresent(settings.region, 'AWS region setting is required.');

    const client = new S3VectorsClient({
        region,
        credentials: {
            accessKeyId,
            secretAccessKey,
            sessionToken: credentials.sessionToken,
        },
    });

    const { bucketInput, bucketMetadata } = resolveBucketInput(settings);
    const defaultDistanceMetric = toAwsMetric(settings.defaultDistanceMetric ?? 'cosine');

    return {
        client,
        bucketInput,
        bucketMetadata,
        defaultDistanceMetric,
        providerKey,
    } satisfies RuntimeContext & { providerKey: string };
}

export const AwsS3VectorsProviderContract: ProviderContract<
    VectorProviderRuntime,
    AwsS3VectorsCredentials,
    AwsS3VectorsSettings
> = {
    id: 'aws-s3-vectors',
    version: '1.0.0',
    domains: ['vector'],
    display: {
        label: 'AWS S3 Vectors',
        description: 'Connect to Amazon S3 Vector indexes for similarity search and storage.',
        icon: 'aws',
    },
    form: {
        sections: [
            {
                title: 'AWS Credentials',
                description:
                    'Provide an IAM user or role with permissions for S3 Vectors (CreateIndex, PutVectors, QueryVectors).',
                fields: [
                    {
                        name: 'accessKeyId',
                        label: 'Access Key ID',
                        type: 'text',
                        required: true,
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
                        type: 'text',
                        required: false,
                        description: 'Optional session token for temporary credentials.',
                        scope: 'credentials',
                    },
                ],
            },
            {
                title: 'Vector Bucket Settings',
                fields: [
                    {
                        name: 'region',
                        label: 'Region',
                        type: 'text',
                        placeholder: 'us-east-1',
                        required: true,
                        scope: 'settings',
                    },
                    {
                        name: 'vectorBucketName',
                        label: 'Vector Bucket Name',
                        type: 'text',
                        placeholder: 'my-vector-bucket',
                        description: 'Provide the name of an existing S3 vector bucket. Leave blank to use an ARN instead.',
                        scope: 'settings',
                    },
                    {
                        name: 'vectorBucketArn',
                        label: 'Vector Bucket ARN',
                        type: 'text',
                        placeholder: 'arn:aws:s3vectors:region:account:bucket/name',
                        description: 'Optional. If provided, overrides the bucket name.',
                        scope: 'settings',
                    },
                    {
                        name: 'defaultDistanceMetric',
                        label: 'Default Distance Metric',
                        type: 'select',
                        required: false,
                        options: [
                            { label: 'Cosine', value: 'cosine' },
                            { label: 'Euclidean', value: 'euclidean' },
                        ],
                        defaultValue: 'cosine',
                        scope: 'settings',
                    },
                ],
            },
        ],
    },
    capabilities: {
        'vector.supportsUpsert': true,
        'vector.supportsQuery': true,
        'vector.metrics': ['cosine', 'euclidean'],
        'vector.dataType': 'float32',
        'vector.provider': 'aws-s3vectors',
    },
    async createRuntime({ credentials, settings, providerKey, logger }) {
        const runtimeContext = createRuntimeContext(credentials, settings, providerKey);
        const { client, bucketInput, bucketMetadata, defaultDistanceMetric } = runtimeContext;

        const runtime: VectorProviderRuntime = {
            async createIndex(input: CreateVectorIndexInput) {
                const metric = toAwsMetric(input.metric ?? defaultDistanceMetric);

                let existingHandle: VectorIndexHandle | null = null;

                try {
                    existingHandle = await fetchIndexHandle(
                        client,
                        { indexName: input.name, vectorBucketName: bucketInput.vectorBucketName },
                        runtimeContext,
                    );
                } catch (error) {
                    if (!isIndexNotFoundError(error)) {
                        throw error;
                    }
                }

                if (existingHandle) {
                    logger?.info?.('Reusing existing AWS S3 vector index', {
                        providerKey,
                        indexName: input.name,
                        externalId: existingHandle.externalId,
                    });

                    return existingHandle;
                }

                const command = new CreateIndexCommand({
                    vectorBucketName: bucketInput.vectorBucketName,
                    indexName: input.name,
                    dataType: 'float32',
                    dimension: input.dimension,
                    distanceMetric: metric,
                    metadataConfiguration: {
                        nonFilterableMetadataKeys: ['_content'],
                    },
                });
                await client.send(command);

                const fetchErrors: unknown[] = [];
                let handle: VectorIndexHandle | null = null;

                const attemptFetch = async (source: IndexSource) => {
                    try {
                        return await fetchIndexHandle(client, source, runtimeContext);
                    } catch (error) {
                        fetchErrors.push(error);
                        return null;
                    }
                };

                for (let attempt = 0; attempt < 3 && !handle; attempt += 1) {
                    handle = await attemptFetch({ indexName: input.name });

                    if (!handle && attempt < 2) {
                        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
                    }
                }

                if (!handle) {
                    try {
                        const summaries = await client.send(
                            new ListIndexesCommand({
                                ...bucketInput,
                                prefix: input.name,
                            }),
                        );

                        const match = (summaries.indexes ?? []).find(
                            (summary) => summary.indexName === input.name,
                        );

                        if (match?.indexArn) {
                            handle = await attemptFetch({ indexArn: match.indexArn });
                        }
                    } catch (listError) {
                        fetchErrors.push(listError);
                    }
                }

                if (!handle) {
                    const bucketName = ensurePresent(
                        bucketMetadata.bucketName,
                        'Vector bucket name is required when AWS index metadata cannot be fetched.',
                    );

                    handle = buildHandle(
                        {
                            indexArn: input.name,
                            indexName: input.name,
                            vectorBucketName: bucketName,
                            dimension: input.dimension,
                            distanceMetric: metric,
                            dataType: 'float32',
                            creationTime: new Date(),
                        },
                        {
                            initializationState: 'pending-sync',
                        },
                        bucketMetadata,
                    );

                    logger?.warn?.('Falling back to locally constructed AWS index handle', {
                        providerKey,
                        indexName: input.name,
                        errors: fetchErrors.map((error) =>
                            error instanceof Error ? error.message : String(error),
                        ),
                    });
                }

                logger?.info?.('Created AWS S3 vector index', {
                    providerKey,
                    indexName: input.name,
                    externalId: handle.externalId,
                });

                return handle;
            },
            async deleteIndex({ externalId }) {
                const source: IndexSource = externalId.startsWith('arn:')
                    ? { indexArn: externalId }
                    : { indexName: externalId };

                await client.send(
                    new DeleteIndexCommand({
                        ...bucketInput,
                        ...source,
                    }),
                );

                logger?.info?.('Deleted AWS S3 vector index', {
                    providerKey,
                    externalId,
                });
            },
            async listIndexes() {
                const response = await client.send(
                    new ListIndexesCommand({
                        ...bucketInput,
                    }),
                );

                const summaries = response.indexes ?? [];
                const handles: VectorIndexHandle[] = [];

                for (const summary of summaries) {
                    if (!summary.indexArn) {
                        continue;
                    }

                    try {
                        const handle = await fetchIndexHandle(
                            client,
                            { indexArn: summary.indexArn },
                            runtimeContext,
                        );
                        handles.push(handle);
                    } catch (error) {
                        logger?.warn?.('Failed to fetch AWS index detail', {
                            providerKey,
                            indexArn: summary.indexArn,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }

                return handles;
            },
            async upsertVectors(handle: VectorIndexHandle, items: VectorUpsertItem[]) {
                if (!items.length) {
                    return;
                }

                const source = extractIndexSource(handle);
                const vectors: PutInputVector[] = items.map((item) => {
                    const metadata = toAwsDocument(item.metadata);

                    const vectorInput: PutInputVector = {
                        key: item.id,
                        data: {
                            float32: item.values.map((value) => Number(value)),
                        },
                    };

                    if (metadata !== undefined) {
                        vectorInput.metadata = metadata;
                    }

                    return vectorInput;
                });

                await client.send(
                    new PutVectorsCommand({
                        indexArn: source.indexArn,
                        vectors,
                    }),
                );

                logger?.debug?.('Upserted vectors into AWS index', {
                    providerKey,
                    count: items.length,
                    index: handle.externalId,
                });
            },
            async deleteVectors(handle: VectorIndexHandle, ids: string[]) {
                if (!ids.length) {
                    return;
                }

                const source = extractIndexSource(handle);

                await client.send(
                    new DeleteVectorsCommand({
                        indexArn: source.indexArn,
                        keys: ids,
                    }),
                );

                logger?.debug?.('Deleted vectors from AWS index', {
                    providerKey,
                    count: ids.length,
                    index: handle.externalId,
                });
            },
            async queryVectors(handle: VectorIndexHandle, query: VectorQueryInput): Promise<VectorQueryResult> {
                const source = extractIndexSource(handle);
                const response = await client.send(
                    new QueryVectorsCommand({
                        indexArn: source.indexArn,
                        topK: query.topK,
                        queryVector: {
                            float32: query.vector.map((value) => Number(value)),
                        },
                        filter: toAwsDocument(query.filter),
                        returnMetadata: true,
                        returnDistance: true,
                    }),
                );

                const matches = (response.vectors ?? []).map((vector) => ({
                    id: ensurePresent(vector.key, 'Vector key missing from query response.'),
                    score: vector.distance ?? 0,
                    metadata: (vector.metadata as Record<string, unknown>) ?? {},
                }));

                return {
                    matches,
                    usage: {
                        providerKey,
                        provider: 'aws-s3vectors',
                        index: handle.externalId,
                        resultCount: matches.length,
                    },
                } satisfies VectorQueryResult;
            },

            async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
                const source = extractIndexSource(handle);
                const limit = input?.limit ?? 100;
                const nextToken = input?.cursor || undefined;

                const response = await client.send(
                    new ListVectorsCommand({
                        indexArn: source.indexArn,
                        maxResults: limit,
                        nextToken,
                        returnMetadata: true,
                        returnData: true,
                    }),
                );

                const items: VectorListResult['items'] = (response.vectors ?? []).map((vec) => ({
                    id: vec.key ?? '',
                    values: vec.data?.float32 ? Array.from(vec.data.float32) : [],
                    metadata: (vec.metadata as Record<string, unknown>) ?? undefined,
                }));

                return {
                    items,
                    nextCursor: response.nextToken ?? undefined,
                };
            },
    };

        return runtime;
    },
};
