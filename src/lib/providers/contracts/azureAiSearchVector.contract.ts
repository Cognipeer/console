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
} from '../domains/vector';

interface AzureAiSearchCredentials {
    apiKey: string;
    subscriptionId?: string;
    subscription?: string;
}

interface AzureAiSearchSettings {
    foundryProjectEndpoint: string;
    resourceGroup?: string;
    location?: string;
    projectResourceId?: string;
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
                    {
                        name: 'subscriptionId',
                        label: 'Subscription ID',
                        type: 'text',
                        required: false,
                        description: 'Azure subscription ID. Optional, used for resource identification.',
                        scope: 'credentials',
                    },
                    {
                        name: 'subscription',
                        label: 'Subscription',
                        type: 'text',
                        required: false,
                        description: 'Azure subscription display name.',
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
                        name: 'location',
                        label: 'Location',
                        type: 'text',
                        required: false,
                        placeholder: 'eastus',
                        description: 'Azure region where the resource is deployed (e.g. eastus, westeurope).',
                        scope: 'settings',
                    },
                    {
                        name: 'resourceGroup',
                        label: 'Resource Group',
                        type: 'text',
                        required: false,
                        description: 'Azure resource group that contains the search service.',
                        scope: 'settings',
                    },
                    {
                        name: 'projectResourceId',
                        label: 'Project Resource ID',
                        type: 'text',
                        required: false,
                        placeholder: '/subscriptions/{subId}/resourceGroups/{rg}/providers/...',
                        description: 'Full Azure resource ID of the AI project or search service. Optional.',
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
                    [ID_FIELD]: item.id,
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

                const searchResults = await client.search('*', {
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
                        id: doc[ID_FIELD],
                        score: result.score ?? 0,
                        metadata,
                    });
                }

                return { matches };
            },

            async deleteVectors(handle: VectorIndexHandle, ids: string[]): Promise<void> {
                if (ids.length === 0) return;

                const client = getSearchClient(handle.externalId);
                await client.deleteDocuments(ID_FIELD, ids);

                logger?.debug('Azure AI Search vectors deleted', {
                    providerKey,
                    indexName: handle.externalId,
                    count: ids.length,
                });
            },
        };

        return runtime;
    },
};
