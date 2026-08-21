import {
    AzureKeyCredential,
    SearchClient,
    SearchIndexClient,
    type SearchIndex,
    type SearchField,
} from '@azure/search-documents';
import type { ProviderContract } from '../types';
import {
    VectorFilterError,
    type VectorFilterOperator,
} from '../domains/vectorFilter';
import { toAzureMetadataKeyValues, toAzureODataFilter } from './vectorFilterTranslators';
import {
    DEFAULT_RRF_K,
    describeHybrid,
    extractVectorText,
    hybridCandidateCount,
    normalizeFusedScore,
} from '../domains/vectorHybrid';
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
    metadata_kv?: string[];
    metadata_keys?: string[];
    content?: string;
}

const ID_FIELD = 'id';
const VECTOR_FIELD = 'vector';
const METADATA_FIELD = 'metadata';
// Azure cannot filter inside the metadata JSON blob, so filterable indexes also
// carry flattened `key=value` pairs and a key list alongside it.
const METADATA_KV_FIELD = 'metadata_kv';
const METADATA_KEYS_FIELD = 'metadata_keys';
const FILTER_SCHEMA_VERSION = 'kv-v1';
// Azure cannot run a keyword query against the metadata blob either — that
// field is stored, not searchable — so hybrid indexes carry the chunk text in a
// searchable column of its own.
const CONTENT_FIELD = 'content';
const CONTENT_SCHEMA_VERSION = 'text-v1';

/** Operators expressible over the flattened string collections. */
const AZURE_FILTER_OPERATORS: VectorFilterOperator[] = [
    '$eq',
    '$ne',
    '$in',
    '$nin',
    '$exists',
    '$and',
    '$or',
    '$not',
];

function hasFilterableSchema(handle: VectorIndexHandle): boolean {
    return handle.metadata?.filterSchema === FILTER_SCHEMA_VERSION;
}

function hasSearchableSchema(handle: VectorIndexHandle): boolean {
    return handle.metadata?.contentSchema === CONTENT_SCHEMA_VERSION;
}

function requireFilterableSchema(handle: VectorIndexHandle): void {
    if (hasFilterableSchema(handle)) return;
    throw new VectorFilterError(
        `Azure AI Search index "${handle.externalId}" was created before filterable metadata `
        + 'was supported, so metadata filters cannot be pushed down. Recreate the index and '
        + 'reingest its documents to enable filtering.',
    );
}

// Azure AI Search document keys may only contain letters, digits, underscore (_),
// dash (-), or equal sign (=). Caller-supplied vector ids (e.g. Knowledge Engine's
// "module:documentId:chunkIndex") routinely violate that, so unsafe ids are stored
// under a marked, URL-safe Base64 form and transparently decoded on the way out.
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_\-=]+$/;
const ENCODED_KEY_PREFIX = '_b64_';

function encodeVectorId(id: string): string {
    if (SAFE_KEY_PATTERN.test(id) && !id.startsWith(ENCODED_KEY_PREFIX)) {
        return id;
    }
    return ENCODED_KEY_PREFIX + Buffer.from(id, 'utf8').toString('base64url');
}

function decodeVectorId(key: string): string {
    if (!key.startsWith(ENCODED_KEY_PREFIX)) {
        return key;
    }
    try {
        return Buffer.from(key.slice(ENCODED_KEY_PREFIX.length), 'base64url').toString('utf8');
    } catch {
        return key;
    }
}

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
        'vector.filterOperators': AZURE_FILTER_OPERATORS,
        'vector.filterRaw': true,
        'vector.supportsHybrid': true,
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
                        {
                            name: METADATA_KV_FIELD,
                            type: 'Collection(Edm.String)',
                            searchable: false,
                            filterable: true,
                            sortable: false,
                            facetable: false,
                            retrievable: false,
                        } as SearchField,
                        {
                            name: METADATA_KEYS_FIELD,
                            type: 'Collection(Edm.String)',
                            searchable: false,
                            filterable: true,
                            sortable: false,
                            facetable: false,
                            retrievable: false,
                        } as SearchField,
                        {
                            name: CONTENT_FIELD,
                            type: 'Edm.String',
                            // Not retrievable: the same text already comes back
                            // inside the metadata blob, and a second copy per
                            // hit is pure bandwidth.
                            searchable: true,
                            filterable: false,
                            sortable: false,
                            facetable: false,
                            retrievable: false,
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
                        filterSchema: FILTER_SCHEMA_VERSION,
                        contentSchema: CONTENT_SCHEMA_VERSION,
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

                    const filterable = index.fields?.some((f) => f.name === METADATA_KV_FIELD);
                    const searchable = index.fields?.some((f) => f.name === CONTENT_FIELD);

                    handles.push({
                        externalId: index.name,
                        name: index.name,
                        dimension,
                        metric,
                        metadata: {
                            provider: 'azure-ai-search',
                            ...(filterable ? { filterSchema: FILTER_SCHEMA_VERSION } : {}),
                            ...(searchable ? { contentSchema: CONTENT_SCHEMA_VERSION } : {}),
                        },
                    });
                }

                return handles;
            },

            async upsertVectors(
                handle: VectorIndexHandle,
                items: VectorUpsertItem[],
            ): Promise<void> {
                const client = getSearchClient(handle.externalId);

                const filterable = hasFilterableSchema(handle);
                const searchable = hasSearchableSchema(handle);

                const documents: AzureSearchDocument[] = items.map((item) => {
                    const document: AzureSearchDocument = {
                        [ID_FIELD]: encodeVectorId(item.id),
                        [VECTOR_FIELD]: item.values,
                        [METADATA_FIELD]: JSON.stringify(item.metadata ?? {}),
                    };

                    // Older indexes have no filterable columns; writing them
                    // would be rejected as unknown fields.
                    if (filterable) {
                        const { keys, pairs } = toAzureMetadataKeyValues(item.metadata);
                        document[METADATA_KV_FIELD] = pairs;
                        document[METADATA_KEYS_FIELD] = keys;
                    }

                    if (searchable) {
                        document[CONTENT_FIELD] = extractVectorText(item.metadata) ?? '';
                    }

                    return document;
                });

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

                let odataFilter: string | undefined;
                if (query.filter) {
                    requireFilterableSchema(handle);
                    odataFilter = toAzureODataFilter(
                        query.filter,
                        METADATA_KV_FIELD,
                        METADATA_KEYS_FIELD,
                    );
                }

                const text = query.text?.trim();
                // An index created before the searchable column existed has
                // nothing for the keyword channel to match, and Azure would
                // still switch to RRF scoring — dense results on a rank scale,
                // labelled hybrid. Stay dense and say so instead.
                const fused = Boolean(text) && hasSearchableSchema(handle);

                // A non-undefined searchText is exactly what puts Azure into
                // hybrid/RRF scoring; keeping it undefined is what preserves
                // the raw cosine similarity of a pure vector search.
                const searchResults = await client.search(fused ? text : undefined, {
                    ...(odataFilter ? { filter: odataFilter } : {}),
                    vectorSearchOptions: {
                        queries: [
                            {
                                kind: 'vector',
                                vector: query.vector,
                                // The vector channel has to reach past the final
                                // slice for the fusion to reorder anything.
                                kNearestNeighborsCount: fused
                                    ? hybridCandidateCount(query.topK)
                                    : query.topK,
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

                    const score = result.score ?? 0;

                    matches.push({
                        id: decodeVectorId(doc[ID_FIELD]),
                        // Azure fuses server-side and hands back its own RRF
                        // score, ~0.016 — off the scale every caller thresholds
                        // against until it is mapped back.
                        score: fused ? normalizeFusedScore(score, DEFAULT_RRF_K) : score,
                        metadata,
                    });
                }

                if (!text) {
                    return { matches };
                }

                // Azure fuses with RRF whatever the caller asked for, so report
                // the mode that actually ran rather than the one requested.
                return {
                    matches,
                    usage: describeHybrid(
                        fused
                            ? { ran: true, mode: 'rrf' }
                            : { ran: false, reason: 'index-schema' },
                    ),
                };
            },

            async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
                if (ids.length === 0) return;

                const client = getSearchClient(handle.externalId);
                await client.deleteDocuments(ID_FIELD, ids.map(encodeVectorId));

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
                        id: decodeVectorId(doc[ID_FIELD]),
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
