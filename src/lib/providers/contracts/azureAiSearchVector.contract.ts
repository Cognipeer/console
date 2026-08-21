import {
    AzureKeyCredential,
    SearchClient,
    SearchIndexClient,
    type SearchIndex,
    type SearchField,
} from '@azure/search-documents';
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

interface AzureAiSearchCredentials {
    apiKey: string;
}

interface AzureAiSearchSettings {
    foundryProjectEndpoint: string;
    defaultDistanceMetric?: 'cosine' | 'euclidean' | 'dotProduct';
    serviceVersion?: string;
}

type AzureVectorMetric = 'cosine' | 'euclidean' | 'dotProduct';

interface AzureSearchDocument {
    id: string;
    vector: number[];
    metadata: string;
}

const ID_FIELD = 'id';
const VECTOR_FIELD = 'vector';
const METADATA_FIELD = 'metadata';

function toAzureMetric(metric: 'cosine' | 'dot' | 'euclidean'): AzureVectorMetric {
    switch (metric) {
        case 'cosine': return 'cosine';
        case 'dot': return 'dotProduct';
        case 'euclidean': return 'euclidean';
        default: return 'cosine';
    }
}

function fromAzureMetric(metric: string): 'cosine' | 'dot' | 'euclidean' {
    switch (metric) {
        case 'cosine': return 'cosine';
        case 'dotProduct': return 'dot';
        case 'euclidean': return 'euclidean';
        default: return 'cosine';
    }
}

function normalizeEndpoint(endpoint: string): string {
    return endpoint.trim().replace(/\/$/, '');
}

// Azure AI Search document keys only allow letters, digits, underscore, dash,
// or equals sign — app-level vector IDs (e.g. "moduleKey:documentId:chunkIndex")
// contain colons, so round-trip them through a URL-safe base64 key on the wire.
function encodeKey(id: string): string {
    return Buffer.from(id, 'utf-8').toString('base64url');
}

function decodeKey(key: string): string {
    // Only decode keys we actually encoded. base64url decoding never throws, so
    // an externally-written key would silently turn into mojibake — round-trip
    // it and fall back to the raw key when it isn't one of ours.
    try {
        const decoded = Buffer.from(key, 'base64url').toString('utf-8');
        return encodeKey(decoded) === key ? decoded : key;
    } catch {
        return key;
    }
}

export const AzureAiSearchVectorProviderContract: ProviderContract<
    VectorProviderRuntime,
    AzureAiSearchCredentials,
    AzureAiSearchSettings
> = {
    id: 'azure-ai-search',
    version: '1.0.0',
    domains: ['vector'],
    display: {
        label: 'Azure AI Search',
        description: 'Connect to Azure AI Search for vector similarity search and storage.',
        icon: 'azure',
    },
    form: {
        sections: [
            {
                title: 'Azure AI Credentials',
                description:
                    'Provide an API key with permissions to manage indexes and documents in your Azure AI Search service.',
                fields: [
                    {
                        name: 'apiKey',
                        label: 'API Key',
                        type: 'password',
                        required: true,
                        scope: 'credentials',
                    },
                ],
            },
            {
                title: 'Service Configuration',
                description: 'Configure the Azure AI Search service endpoint and resource details.',
                fields: [
                    {
                        name: 'foundryProjectEndpoint',
                        label: 'Microsoft Foundry Project Endpoint',
                        type: 'text',
                        required: true,
                        placeholder: 'https://myservice.search.windows.net',
                        description:
                            'The endpoint URL of your Azure AI Search service or Microsoft Foundry project.',
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
                            { label: 'Dot Product', value: 'dotProduct' },
                        ],
                        defaultValue: 'cosine',
                        scope: 'settings',
                    },
                    {
                        name: 'serviceVersion',
                        label: 'API Version',
                        type: 'select',
                        required: false,
                        options: [
                            { label: '2023-11-01 (GA — default)', value: '2023-11-01' },
                            { label: '2024-05-01-preview', value: '2024-05-01-preview' },
                            { label: '2024-07-01 (GA)', value: '2024-07-01' },
                            { label: '2024-11-01-preview', value: '2024-11-01-preview' },
                        ],
                        defaultValue: '2023-11-01',
                        description: 'Azure AI Search REST API version. Use 2023-11-01 for maximum compatibility.',
                        scope: 'settings',
                    },
                ],
            },
        ],
    },
    capabilities: {
        'vector.supportsUpsert': true,
        'vector.supportsQuery': true,
        'vector.metrics': ['cosine', 'euclidean', 'dot'],
        'vector.dataType': 'float32',
        'vector.provider': 'azure-ai-search',
    },
    async createRuntime({ credentials, settings, providerKey, logger }) {
        const endpoint = normalizeEndpoint(settings.foundryProjectEndpoint);
        const credential = new AzureKeyCredential(credentials.apiKey);
        // Default to 2023-11-01 — first GA version with vector search, broadest availability.
        // The SDK default (2025-09-01) is unsupported on most existing services.
        const serviceVersion = settings.serviceVersion ?? '2023-11-01';
        const indexClient = new SearchIndexClient(endpoint, credential, { serviceVersion });
        const defaultMetric: AzureVectorMetric = settings.defaultDistanceMetric ?? 'cosine';

        function getSearchClient(indexName: string): SearchClient<AzureSearchDocument> {
            return new SearchClient<AzureSearchDocument>(endpoint, indexName, credential, { serviceVersion });
        }

        const runtime: VectorProviderRuntime = {
            async createIndex(input: CreateVectorIndexInput): Promise<VectorIndexHandle> {
                const algoName = `${input.name}-hnsw`;
                const profileName = `${input.name}-profile`;
                const metric = toAzureMetric(input.metric ?? (defaultMetric as 'cosine' | 'dot' | 'euclidean'));

                const indexDef: SearchIndex = {
                    name: input.name,
                    fields: [
                        {
                            name: ID_FIELD,
                            type: 'Edm.String',
                            key: true,
                            filterable: true,
                            retrievable: true,
                            searchable: false,
                            sortable: false,
                            facetable: false,
                        } as SearchField,
                        {
                            name: VECTOR_FIELD,
                            type: 'Collection(Edm.Single)',
                            searchable: true,
                            filterable: false,
                            sortable: false,
                            facetable: false,
                            retrievable: true,
                            vectorSearchDimensions: input.dimension,
                            vectorSearchProfileName: profileName,
                        } as SearchField,
                        {
                            name: METADATA_FIELD,
                            type: 'Edm.String',
                            searchable: false,
                            filterable: false,
                            sortable: false,
                            facetable: false,
                            retrievable: true,
                        } as SearchField,
                    ],
                    vectorSearch: {
                        algorithms: [
                            {
                                name: algoName,
                                kind: 'hnsw',
                                parameters: { metric },
                            },
                        ],
                        profiles: [
                            {
                                name: profileName,
                                algorithmConfigurationName: algoName,
                            },
                        ],
                    },
                };

                const created = await indexClient.createIndex(indexDef);

                logger?.info('Azure AI Search index created', {
                    providerKey,
                    indexName: created.name,
                });

                return {
                    externalId: created.name,
                    name: created.name,
                    dimension: input.dimension,
                    metric: input.metric ?? 'cosine',
                    metadata: {
                        provider: 'azure-ai-search',
                        endpoint,
                        algoName,
                        profileName,
                    },
                };
            },

            async deleteIndex(input): Promise<void> {
                await indexClient.deleteIndex(input.externalId);

                logger?.info('Azure AI Search index deleted', {
                    providerKey,
                    externalId: input.externalId,
                });
            },

            async listIndexes(): Promise<VectorIndexHandle[]> {
                const handles: VectorIndexHandle[] = [];

                for await (const index of indexClient.listIndexes()) {
                    const vectorField = index.fields?.find(
                        (f) => f.name === VECTOR_FIELD,
                    ) as (SearchField & { vectorSearchDimensions?: number }) | undefined;

                    const dimension = vectorField?.vectorSearchDimensions ?? 0;

                    const algoName = `${index.name}-hnsw`;
                    const algo = index.vectorSearch?.algorithms?.find(
                        (a) => a.name === algoName,
                    ) as { parameters?: { metric?: string } } | undefined;

                    const metric = fromAzureMetric(algo?.parameters?.metric ?? 'cosine');

                    handles.push({
                        externalId: index.name,
                        name: index.name,
                        dimension,
                        metric,
                        metadata: { provider: 'azure-ai-search' },
                    });
                }

                return handles;
            },

            async upsertVectors(
                handle: VectorIndexHandle,
                items: VectorUpsertItem[],
            ): Promise<void> {
                const client = getSearchClient(handle.externalId);

                const documents: AzureSearchDocument[] = items.map((item) => ({
                    [ID_FIELD]: encodeKey(item.id),
                    [VECTOR_FIELD]: item.values,
                    [METADATA_FIELD]: JSON.stringify(item.metadata ?? {}),
                }));

                await client.mergeOrUploadDocuments(documents);

                logger?.debug('Azure AI Search vectors upserted', {
                    providerKey,
                    indexName: handle.externalId,
                    count: items.length,
                });
            },

            async queryVectors(
                handle: VectorIndexHandle,
                query: VectorQueryInput,
            ): Promise<VectorQueryResult> {
                const client = getSearchClient(handle.externalId);

                const searchResults = await client.search(undefined, {
                    vectorSearchOptions: {
                        queries: [
                            {
                                kind: 'vector',
                                vector: query.vector,
                                kNearestNeighborsCount: query.topK,
                                fields: [VECTOR_FIELD],
                            },
                        ],
                    },
                    select: [ID_FIELD, METADATA_FIELD] as (keyof AzureSearchDocument)[],
                    top: query.topK,
                });

                const matches: VectorQueryResult['matches'] = [];

                for await (const result of searchResults.results) {
                    const doc = result.document;

                    let metadata: Record<string, unknown> = {};
                    try {
                        metadata = JSON.parse(doc[METADATA_FIELD] ?? '{}');
                    } catch {
                        // ignore malformed metadata
                    }

                    matches.push({
                        id: decodeKey(doc[ID_FIELD]),
                        score: result.score ?? 0,
                        metadata,
                    });
                }

                return { matches };
            },

            async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
                if (ids.length === 0) return;

                const client = getSearchClient(handle.externalId);
                await client.deleteDocuments(ID_FIELD, ids.map(encodeKey));

                logger?.debug('Azure AI Search vectors deleted', {
                    providerKey,
                    indexName: handle.externalId,
                    count: ids.length,
                });
            },

            async listVectors(handle: VectorIndexHandle, input?: VectorListInput): Promise<VectorListResult> {
                const limit = input?.limit ?? 100;
                const skip = input?.cursor ? parseInt(input.cursor, 10) : 0;

                const client = getSearchClient(handle.externalId);

                const searchResults = await client.search('*', {
                    select: [ID_FIELD, VECTOR_FIELD, METADATA_FIELD] as (keyof AzureSearchDocument)[],
                    top: limit,
                    skip,
                    includeTotalCount: true,
                });

                const items: VectorListResult['items'] = [];

                for await (const result of searchResults.results) {
                    const doc = result.document;
                    let metadata: Record<string, unknown> = {};
                    try {
                        metadata = JSON.parse(doc[METADATA_FIELD] ?? '{}');
                    } catch {
                        // ignore malformed metadata
                    }
                    items.push({
                        id: decodeKey(doc[ID_FIELD]),
                        values: Array.isArray(doc[VECTOR_FIELD]) ? doc[VECTOR_FIELD] : [],
                        metadata,
                    });
                }

                const nextOffset = skip + items.length;
                const total = searchResults.count ?? undefined;
                const hasMore = total !== undefined ? nextOffset < total : items.length === limit;

                return {
                    items,
                    nextCursor: hasMore ? String(nextOffset) : undefined,
                    total: total !== undefined ? Number(total) : undefined,
                };
            },
        };

        return runtime;
    },
};
