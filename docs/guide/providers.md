# Providers

The provider system is a contract-driven abstraction that supports multiple AI service providers (OpenAI, Anthropic, Google, AWS Bedrock, Pinecone, Qdrant, etc.) through a unified interface. Provider definitions live in code; the operator-facing surface for *configuring* them is **Admin → Providers** in the console.

## Operator view

Every provider configuration shows up as a row in the providers screen, scoped to either the tenant or a single project. The four counter cards summarise the registry state at a glance: how many are configured, how many are active, how many are erroring, and how many distinct domains your tenant uses.

![Providers list](/screenshots/providers/01-providers-list.png)

Adding a new configuration is a two-step flow. The first step lists every driver that's available in this build — provider contracts are compiled in, so seeing OpenAI, Anthropic, Bedrock, Vertex AI, Ollama, ChromaDB, Qdrant, and others here means the corresponding contracts are loaded.

The cards on the picker are not hard-coded. They come from `src/config/service-catalog.json` and are filtered through `src/lib/services/serviceCatalog.ts`. Multiple catalog entries can map to the same backend driver — e.g. Anthropic, Groq, and DeepSeek all surface as separate cards but resolve to the `openai-compatible` driver. See the [Service Catalog](./service-catalog.md) guide for how to add or rebrand entries.

![Add provider — service picker](/screenshots/providers/02-add-provider-domain.png)

Use the **domain filter** dropdown to narrow the list — for example, when you're wiring up inference you typically only care about `model` domain contracts.

![Add provider — filtered to Model domain](/screenshots/providers/03-add-provider-driver.png)

After picking a driver, the dialog auto-fills the right-hand panel and renders the credential and settings fields defined by the driver's contract. The **PRE-FLIGHT** checklist on the right turns green as each requirement is satisfied; the **Create provider** action only enables once the form is valid.

## Private networks on SaaS

On SaaS, Console refuses provider endpoints on private addresses unless the operator of the installation has opened that network for the organization. That covers model, embedding, image, speech, moderation, decision and file providers, the hosts inside a GridFS connection string, and the endpoints in an Azure connection string. A MinIO or Ceph store, a MongoDB for GridFS or a model server inside a customer's network can be used over a VPN or peering the operator has set up, once that network is opened for the organization.

A self-hosted installation allows private endpoints by default, so it needs none of this. It follows the rules below only when it sets `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` to `true` explicitly. A self-hosted installation that runs on MongoDB sets `DEPLOYMENT_MODE=onprem` ([Configuration](/guide/configuration#deployment-mode)); without it Console treats the installation as SaaS. Other outbound calls (webhooks, tools, MCP servers, alert channels, browser sessions, the crawler, OCR webhooks and imports) are not covered here; they follow `OUTBOUND_HTTP_*` only.

### What the operator does

On a hosted Console the operator is the team that runs it: send them your workspace slug (**Admin → License**) and the address ranges of your endpoints.

1. **Connect the networks.** Set up a VPN or network peering between Console's cluster and the customer's network, with the routes and firewall rules on both sides that let Console reach the endpoints. If providers use host names, the cluster's DNS must resolve them (for example through a forwarder to the customer's DNS); otherwise use IP addresses.
2. **Open the range.** On every Console process, set [`PROVIDER_PRIVATE_NETWORKS`](/guide/configuration#provider-private-networks) to the organization's tenant ID and the ranges it may use, and `PROVIDER_PRIVATE_NETWORKS_DENY` to the cluster's pod and service ranges and any other internal range:

   ```bash
   PROVIDER_PRIVATE_NETWORKS="64f0c0ffee1234567890abcd=10.50.0.0/16,fd12:3456::/48;*=100.64.10.0/24"
   PROVIDER_PRIVATE_NETWORKS_DENY="10.244.0.0/16,10.96.0.0/12"
   ```

   Open the narrowest range that covers the customer's endpoints. Ranges are IPv4 or IPv6 CIDRs (a bare address means one host); host names are not accepted. `*` in place of a tenant ID opens the ranges for every organization, so use it only for networks every organization may reach.
3. **Restart** every replica. Both values are read once, when Console starts, on every process (a `worker` node included). The startup log states how many organizations and ranges were opened and lists each entry that could not be read; such an entry opens nothing, and an entry of the deny list that cannot be read opens nothing for anyone until it is fixed.
4. **Check.** The organization adds the provider under **Admin → Providers** with the private address and presses **Test connection**, which applies the same rule. A refused endpoint answers `400` with code `provider_endpoint_not_allowed` and the name of the field; the message never includes credentials or the configured ranges.

A public address always passes. A private address passes only inside a range opened for the organization and outside the addresses below. A host name is resolved and every address it returns must pass. For a file provider the same rule applies again each time its storage client is built and a connection is opened.

### Addresses that are never opened

No setting opens these, even when an opened range contains them. A range that overlaps them is logged as a warning at startup, and the overlapping part stays refused.

| Kind | Addresses |
|------|-----------|
| IPv4 | `0.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `168.63.129.16/32`, `100.100.100.200/32`, `192.0.0.0/24`, `224.0.0.0/3`, `255.255.255.255` |
| IPv6 | `::/128`, `::1/128`, `fe80::/10`, `ff00::/8`, `fd00:ec2::254/128` |
| IPv6 forms that carry an IPv4 address | IPv4-translated `::ffff:0:a.b.c.d`, IPv4-compatible `::a.b.c.d`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16` and Teredo `2001::/32`. The plain IPv4-mapped form `::ffff:a.b.c.d` is the exception: it is matched as its IPv4 address, against the opened ranges and this list alike. |
| Console itself | Every address of the machine's network interfaces (read at startup), and `KUBERNETES_SERVICE_HOST` when it is an IP address. |
| The deny list | Every range in `PROVIDER_PRIVATE_NETWORKS_DENY`. |
| Names | `localhost`, `*.localhost` and `localhost.localdomain`, without a DNS lookup. `*.local` and `*.internal` are refused without a lookup too, except for an organization that has opened networks: there they are resolved and judged by their addresses like any other name. |

### One organization at a time

Opened ranges belong to the tenant ID in the entry. An organization cannot use another organization's ranges; only `*` entries are shared.

The tenant ID is the organization's `id` as the API returns it, `tenant.id` in the response of `POST /api/auth/login`: 24 hexadecimal characters on MongoDB, a UUID on SQLite. It is neither the slug nor the `tenant_<slug>` database name. On MongoDB it is the `_id` of the organization's document in the `tenants` collection of the main database (`MAIN_DB_NAME`, `console_main` by default). Find it from the organization's workspace slug, which an administrator sees under **Admin → License** (**Workspace slug**):

```js
db.getSiblingDB("console_main").tenants.find({ slug: "acme" }, { companyName: 1 })
// { _id: ObjectId('64f0c0ffee1234567890abcd'), companyName: 'Acme' }
```

The same value is the path segment right after `/api/public/mcp/`, `/api/public/a2a/` or `/api/public/hooks/` in the public endpoint URLs the dashboard shows.

### `mongodb+srv` connection strings

A `mongodb+srv://` connection string, such as the **Connection URI** of a GridFS provider, is accepted on SaaS when every host in its SRV record passes the check above. Console resolves the SRV record (`_mongodb._tcp.<host>`, or the service the `srvServiceName` option names) when the provider is saved and when you press **Test connection**, and judges each target like any other host. A record with no answer, a lookup that fails or takes longer than five seconds, or a record that names more than 64 hosts refuses the string; the message never repeats it. When Console connects, every connection the driver opens and every server the cluster announces is checked the same way. A local socket stays refused.

### TLS verification and plain http

**Skip TLS verification** (S3-compatible storage, Amazon S3 with a custom endpoint, Azure Blob; for GridFS the connection-string options `tlsInsecure`, `tlsAllowInvalidCertificates` and `tlsAllowInvalidHostnames`) and plain `http://` endpoints (S3-compatible storage, Amazon S3 with a custom endpoint, Azure Blob) are the provider's own choice on every deployment. The rules above apply to them either way: the endpoint has to be public or inside an opened network. Microsoft Entra ID sign-in needs https, so a provider that combines it with an `http://` endpoint is refused when it is saved. With `http://` the requests and the data travel unencrypted, and a skipped certificate check accepts any certificate. Prefer an `https://` endpoint and, for a private CA, paste its certificate into **CA certificate (PEM)**: it is trusted for that provider only and verification stays on.

### What stays self-hosted only

Three things in a MongoDB connection string refer to the server that runs Console rather than to a customer's network, so a self-hosted installation can use them and SaaS cannot:

| In the connection string | On SaaS |
|--------------------------|---------|
| Certificate files (`tlsCAFile`, `tlsCertificateKeyFile`, `tlsCRLFile`) | Refused: they are files on the server that runs Console. The GridFS provider has no CA certificate field: on SaaS the certificate of its MongoDB server has to chain to a CA that Console already trusts, unless the connection string turns verification off (see above). |
| A local socket | Refused: it names a socket of the server that runs Console. A self-hosted installation refuses it too when it blocks private networks explicitly. |
| A sign-in method that uses the identity of the server (`MONGODB-OIDC`, `GSSAPI`, `MONGODB-X509`, `MONGODB-AWS` without the key in the string) | Refused: put a user name and password in the connection string. A self-hosted installation refuses these too when it blocks private networks explicitly. |

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
| `file` | `FileProviderRuntime` | Object upload, download, delete, listing and metadata; an optional end-to-end connection check and `close()` |
| `datasource` | _(no runtime interface)_ | Domain value for external data connections; no runtime is instantiated |

### File drivers

| Driver id | Label | Stores files in |
|-----------|-------|-----------------|
| `s3-compatible-files` | S3-compatible storage | MinIO, Ceph RGW, SeaweedFS, Garage, Cloudflare R2, Backblaze B2, Wasabi and other stores with an S3 API at an endpoint of their own |
| `aws-s3-files` | Amazon S3 | An Amazon S3 bucket (providers set up before the S3-compatible driver may still carry a custom endpoint) |
| `azure-blob-files` | Azure Blob Storage | An Azure Blob container, in any Azure cloud, on Azure Stack Hub or in Azurite |
| `mongodb-gridfs-files` | MongoDB GridFS | MongoDB, for installations without an object store |
| `local-filesystem` | Local filesystem | A directory on the server (built in) |

`s3-compatible-files` and `aws-s3-files` share one runtime; what differs is the form (the endpoint is required and path-style addressing is on by default for the first). The catalog entries of the picker map onto these ids: the "S3-compatible storage" card answers to MinIO, Ceph, R2 and similar search terms. Each driver's settings, sign-in methods and limits are described in [Files](/guide/files#storage-providers).

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
  // Strict check of what is about to be saved or tested; throws ProviderSettingsError
  validateSettings?(input: { credentials: TCredentials; settings: TSettings; isOnPrem: boolean; tenantId?: string; allowHostPaths?: boolean }): void | Promise<void>;
  // File providers only: where the objects live, for display (settings only, never credentials)
  describeStorageLocation?(input: { settings: TSettings; tenantId: string; providerKey: string }): string | null;
}
```

### Example Contract

```typescript
// src/lib/providers/contracts/modelContracts.ts
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
const schema = providerRegistry.getFormSchema('postgres');

// Create runtime instance
const runtime = providerRegistry.createRuntime('openai', context);
```

Contracts are auto-registered from `CORE_PROVIDER_CONTRACTS` on first access (lazy initialization).

## Provider Configuration Lifecycle

### 1. Discovery

```typescript
// List available vector drivers
const drivers = await listVectorDrivers();
// Returns: [{ id: 'sqlite-vector', display: {...} }, { id: 'postgres', ... }]
```

### 2. Configuration

```typescript
// Create a provider config for a tenant
await createVectorProvider({
  tenantDbName, tenantId, projectId,
  driver: 'postgres',
  name: 'Production Vectors',
  credentials: { connectionString: 'postgres://...' },
  settings: { schema: 'public' },
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
  defaultValue?: unknown;
  // Show the field only while another field of the form holds one of these values
  visibleWhen?: { field: string; equals: string | string[] };
}
```

The `ProviderFormRenderer` component auto-renders forms from this schema. `visibleWhen` is presentation only: Azure Blob Storage uses it to show just the credential fields of the selected sign-in method. Fields that are not shown are neither validated nor submitted, the runtime ignores the values of fields that do not apply, and the server does not evaluate `visibleWhen`.

## Validation and Connection Tests

A contract can refuse a configuration it cannot work with before anything is stored. `validateSettings` receives the credentials and the settings that are about to be saved, plus `isOnPrem` (some options are for self-hosted installations only), `tenantId` (the organization, whose opened private networks a driver that vets the addresses in its settings needs; without it none are opened) and `allowHostPaths` (set by the route, never by the request body, when the caller is an owner or an admin: the local-disk driver refuses a **Base directory**, a directory of the server, without it and on a hosted deployment), and throws `ProviderSettingsError(field, message)` for the first problem it finds. It runs:

- when a provider is **created**;
- when a provider is **updated**, on what the update will store: the settings replace the stored ones, and credentials left blank keep the stored values;
- before **Test connection** creates a runtime.

`createRuntime` stays lenient for rows that are already stored, so a provider that works keeps working after an upgrade. The one exception is a folder name: the local-disk driver applies its **Subdirectory** rule (a relative folder, no `..`, no leading `/` or `\`, no drive letter) and the rule that its provider key stays inside the organization's folder every time it builds a runtime, so a stored provider that breaks one of them fails until it is edited.

Before the driver's own checks, a **new** provider's key is checked for every provider type. The key names the provider's folder in the store, so it has to be one name: not `.` or `..`, and with no `/`, `\` or control character (`provider_settings_invalid`, field `key`). A key that another provider of the organization already has answers `409` with `code: "duplicate_key"`; provider keys are unique across the organization, whatever the kind of provider.

For the domains whose endpoints a person types in (model, embedding, image, speech, moderation, decision and file providers), the endpoint policy runs as well: a private or loopback address is refused on the hosted service, and on a self-hosted install only when the deployment blocks private networks. A private address inside a network the operator has opened for the organization passes (see [Private networks on SaaS](#private-networks-on-saas)); loopback, link-local and metadata addresses never do. See [Deployment mode](/guide/configuration#deployment-mode).

Both refusals answer `400` with a body the form can act on:

```json
{ "error": "Region is required for Amazon S3 (for example eu-central-1).", "code": "provider_settings_invalid", "field": "region" }
```

`code` is `provider_settings_invalid` or `provider_endpoint_not_allowed`, and `field` names the form field, which the form marks. The same mapping serves the dashboard routes and the client API.

**Test connection** (`POST /api/providers/test` for a form that is not saved yet, `POST /api/providers/:id/test` for a saved provider) is the cheapest authenticated request a driver supports and never saves anything; a failed connection is a normal `200` answer with `ok: false`. A file runtime may implement `checkConnection`, which then replaces the bare listing with the steps list, write, read back and delete, so the answer says which of them work. A runtime that opens connections also implements `close()`, which the test calls when it is done. See [Files](/guide/files#testing-a-connection).

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
| `key` | Unique provider key per tenant (a new key cannot be `.` or `..`, or hold `/`, `\` or a control character; see [Validation and Connection Tests](#validation-and-connection-tests)) |
| `type` | Provider domain |
| `driver` | Contract ID |
| `label` | Display name |
| `credentialsEnc` | Encrypted credentials |
| `settings` | Provider-specific settings |
| `status` | `active`, `disabled`, or `errored` |
