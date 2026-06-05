# Config API

Endpoints for managing secrets, API keys, and configuration values organized in groups with encryption at rest.

## Config Groups

Config groups are containers that organize related config items. Create a group first, then add items to it.

### List Config Groups

```
GET /api/client/v1/config/groups?tags=api,openai&search=credentials
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `tags` | string | Comma-separated tag filter |
| `search` | string | Search by name, key, or description |

### Create Config Group

```
POST /api/client/v1/config/groups
```

```json
{
  "name": "OpenAI Credentials",
  "key": "cfg-grp-openai",
  "description": "All OpenAI related secrets and settings",
  "tags": ["api", "openai"]
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable name |
| `key` | string | No | Unique key (auto-generated from name if omitted) |
| `description` | string | No | Description |
| `tags` | string[] | No | Categorization tags |
| `metadata` | object | No | Custom metadata |

**Status:** 201

### Get Config Group (with items)

```
GET /api/client/v1/config/groups/:groupKey
```

Returns the group with all its items. Secret values are masked.

### Update Config Group

```
PATCH /api/client/v1/config/groups/:groupKey
```

```json
{
  "name": "OpenAI Production Credentials",
  "tags": ["api", "openai", "production"]
}
```

### Delete Config Group

```
DELETE /api/client/v1/config/groups/:groupKey
```

Permanently removes the group **and all its items**. Audit log entries are recorded.

## Config Items

Items belong to a group and hold the actual configuration values.

### List Items in a Group

```
GET /api/client/v1/config/groups/:groupKey/items?isSecret=true&tags=api&search=key
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `isSecret` | boolean | Filter by secret/non-secret |
| `tags` | string | Comma-separated tag filter |
| `search` | string | Search by name, key, or description |

### Create Config Item

```
POST /api/client/v1/config/groups/:groupKey/items
```

```json
{
  "name": "API Key",
  "key": "cfg-openai-api-key",
  "description": "Production OpenAI key",
  "value": "sk-...",
  "valueType": "string",
  "isSecret": true,
  "tags": ["api", "openai"]
}
```

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable name |
| `key` | string | No | Unique key (auto-generated from name if omitted) |
| `description` | string | No | Description |
| `value` | string | Yes | Configuration value |
| `valueType` | string | No | `string` (default), `number`, `boolean`, `json` |
| `isSecret` | boolean | No | Encrypt value at rest (default: false) |
| `tags` | string[] | No | Categorization tags |
| `metadata` | object | No | Custom metadata |

**Status:** 201

### Get Config Item

```
GET /api/client/v1/config/items/:key
```

Returns the config item. Secret values are masked (shown as `••••••••`).

### Update Config Item

```
PATCH /api/client/v1/config/items/:key
```

```json
{
  "value": "sk-new-...",
  "tags": ["api", "openai", "v2"]
}
```

All fields are optional. When updating a secret value, the new value is encrypted automatically.

### Delete Config Item

```
DELETE /api/client/v1/config/items/:key
```

Permanently removes the config item. An audit log entry is recorded.

## Resolve (Decrypt Secrets)

```
POST /api/client/v1/config/resolve
```

```json
{
  "keys": ["cfg-openai-api-key", "cfg-db-connection-string"]
}
```

Returns decrypted values for the requested keys. Maximum 50 keys per request.

**Response:**

```json
{
  "configs": {
    "cfg-openai-api-key": {
      "value": "sk-...",
      "valueType": "string",
      "version": 3
    },
    "cfg-db-connection-string": {
      "value": "mongodb://...",
      "valueType": "string",
      "version": 1
    }
  }
}
```

## Audit Logs

### List Audit Logs

```
GET /api/client/v1/config/items/:key/audit?limit=50&skip=0
```

Returns the audit trail for a config item, including create, update, delete, and read actions.

**Response:**

```json
{
  "logs": [
    {
      "_id": "...",
      "configKey": "cfg-openai-api-key",
      "action": "update",
      "version": 3,
      "performedBy": "user@example.com",
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

## Security

- **Encryption:** Secret values are encrypted using AES-256-GCM
- **Masking:** Secret values are never returned in plain text via list/get endpoints
- **Audit trail:** All operations (create, read, update, delete) are logged
- **Tenant isolation:** Config items are scoped to tenant and project
