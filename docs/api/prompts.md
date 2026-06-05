# Prompts API

Endpoints for prompt template management, version control, and deployment.

## List Prompts

```
GET /api/client/v1/prompts?search=welcome
```

```json
{ "prompts": [{ "key": "welcome-message", "name": "Welcome Message", ... }] }
```

## Get Prompt

```
GET /api/client/v1/prompts/:key?environment=prod&version=2
```

| Query Parameter | Description |
|----------------|-------------|
| `environment` | `dev`, `staging`, or `prod` — resolve version for this environment |
| `version` | Specific version number |

```json
{
  "prompt": { "key": "welcome-message", "name": "Welcome Message", "template": "Hello {{name}}!" },
  "resolvedVersion": { "id": "abc", "version": 3, "name": "v3", "isLatest": true }
}
```

## Render Prompt

```
POST /api/client/v1/prompts/:key/render?environment=prod
```

```json
{
  "data": { "name": "Alice", "company": "Acme Corp" }
}
```

```json
{
  "rendered": "Hello Alice, welcome to Acme Corp!",
  "prompt": { "key": "welcome-message", "name": "Welcome Message", "version": 3, "environment": "prod" }
}
```

## Version History

```
GET /api/client/v1/prompts/:key/versions
```

```json
{
  "prompt": { "key": "welcome-message", "name": "Welcome Message" },
  "versions": [
    { "id": "abc", "version": 3, "name": "v3", "isLatest": true, "createdAt": "..." },
    { "id": "def", "version": 2, "name": "v2", "isLatest": false, "createdAt": "..." }
  ]
}
```

## Compare Versions

```
GET /api/client/v1/prompts/:key/compare?fromVersionId=abc&toVersionId=def
```

Returns a side-by-side comparison of two prompt versions.

## Deployments

### List Deployments

```
GET /api/client/v1/prompts/:key/deployments
```

### Deploy Action

```
POST /api/client/v1/prompts/:key/deployments
```

```json
{
  "action": "promote",
  "environment": "staging",
  "versionId": "abc",
  "note": "Deploying v3 to staging"
}
```

### Actions

| Action | Description | `versionId` Required |
|--------|-------------|---------------------|
| `promote` | Set version as active in environment | Yes |
| `plan` | Schedule a version for future activation | Yes |
| `activate` | Activate a planned deployment | No |
| `rollback` | Revert to previous version | No |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Missing required fields |
| 401 | Invalid API token |
| 404 | Prompt not found |
| 409 | Version conflict |
