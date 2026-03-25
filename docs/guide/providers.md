# Providers

The provider system is a contract-driven abstraction that supports multiple AI service providers (OpenAI, Anthropic, Google, AWS Bedrock, Pinecone, Qdrant, etc.) through a unified interface.

## Architecture

```
ProviderContract          ProviderRegistry          Service Layer
  (definition)       →     (registration)       →    (runtime usage)
  
  id, version              listDescriptors()          createRuntime()
  domains                  getContract()              runtime.chat()
  display                  getFormSchema()            runtime.embed()
  form                                                runtime.query()
  createRuntime()
```

## Provider Domains

Each provider contract declares which domains it supports:

| Domain | Interface | Operations |
|--------|-----------|------------|
| `model` | `ModelProviderRuntime` | Chat completions, embeddings |
| `vector` | `VectorProviderRuntime` | Index CRUD, vector upsert/query/delete |
| `file` | `FileProviderRuntime` | Bucket management, upload/download |
| `datasource` | `DatasourceProviderRuntime` | External data connections |

## Contract Structure

```typescript
interface ProviderContract<TRuntime, TCredentials, TSettings> {
  id: string;                    // Unique identifier (e.g., 'openai')
  version: string;               // Semantic version
  domains: ProviderDomain[];     // Supported domains
  display: ProviderDisplayConfig; // UI label, description, icon
  capabilities?: Record<string, boolean>;
  form: ProviderFormSchema;      // Credential/settings form definition
  createRuntime(context: ProviderContext): TRuntime;
}
```

### Example Contract

```typescript
// src/lib/providers/contracts/openai.ts
export const openaiContract: ProviderContract<...> = {
  id: 'openai',
  version: '1.0.0',
  domains: ['model'],
  display: {
    label: 'OpenAI',
    description: 'GPT-4, GPT-3.5, DALL-E, Whisper',
    icon: 'openai',
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          { name: 'apiKey', label: 'API Key', type: 'password', required: true, scope: 'credentials' },
        ],
      },
    ],
  },
  createRuntime(context) {
    return new OpenAIRuntime(context);
  },
};
```

## Provider Registry

The singleton registry manages all contracts:

```typescript
import { providerRegistry } from '@/lib/providers/registry';

// List available providers for a domain
const drivers = providerRegistry.listDescriptors('vector');

// Get form schema for UI rendering
const schema = providerRegistry.getFormSchema('pinecone');

// Create runtime instance
const runtime = providerRegistry.createRuntime('openai', context);
```

Contracts are auto-registered from `CORE_PROVIDER_CONTRACTS` on first access (lazy initialization).

## Provider Configuration Lifecycle

### 1. Discovery

```typescript
// List available vector drivers
const drivers = await listVectorDrivers();
// Returns: [{ id: 'pinecone', display: {...} }, { id: 'qdrant', ... }]
```

### 2. Configuration

```typescript
// Create a provider config for a tenant
await createVectorProvider({
  tenantDbName, tenantId, projectId,
  driver: 'pinecone',
  name: 'Production Vectors',
  credentials: { apiKey: 'pk-...' },
  settings: { environment: 'gcp-starter' },
});
```

Credentials are encrypted with `PROVIDER_ENCRYPTION_SECRET` before storage.

### 3. Runtime Usage

```typescript
// Load stored config and create runtime
const { runtime, index } = await buildRuntimeContext(tenantDbName, providerKey);
const results = await runtime.query(indexName, queryVector, { topK: 10 });
```

## Form Schema

The form schema drives the UI for configuring providers:

```typescript
interface ProviderFormField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'number' | 'select' | 'switch';
  required?: boolean;
  scope?: 'credentials' | 'settings' | 'metadata';
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}
```

The `ProviderFormRenderer` component auto-renders forms from this schema.

## Adding a New Provider

1. **Create contract** under `src/lib/providers/contracts/`:
```typescript
export const myProviderContract = {
  id: 'my-provider',
  version: '1.0.0',
  domains: ['model'],
  display: { label: 'My Provider' },
  form: { sections: [...] },
  createRuntime(ctx) { return new MyProviderRuntime(ctx); },
};
```

2. **Register** in `CORE_PROVIDER_CONTRACTS`:
```typescript
export const CORE_PROVIDER_CONTRACTS = [
  ...existingContracts,
  myProviderContract,
];
```

3. **Implement runtime** with the domain interface (e.g., `ModelProviderRuntime`)

4. **Test** that the form renders in the UI and the runtime works correctly

## Stored Configuration

Provider configs are stored in the tenant database as `IProviderRecord`:

| Field | Description |
|-------|-------------|
| `key` | Unique provider key per tenant |
| `type` | Provider domain |
| `driver` | Contract ID |
| `name` | Display name |
| `credentialsEnc` | Encrypted credentials |
| `settings` | Provider-specific settings |
| `status` | `active` or `inactive` |
