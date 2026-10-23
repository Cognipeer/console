# Files API

The Files API works with the [Document Store](/guide/files): the file storage providers of a project, its buckets, and the files in them. Every call takes an API token (`Authorization: Bearer cpeer_…`) and works in the project the token belongs to. Paths on this page are relative to `/api/client/v1`.

| Method and path | What it does |
|-----------------|--------------|
| `GET /files/providers` | List file providers |
| `POST /files/providers` | Create a file provider |
| `GET /files/buckets` | List buckets |
| `GET /files/buckets/:bucketKey` | Get one bucket |
| `GET /files/buckets/:bucketKey/objects` | List the files (and folders) of a bucket |
| `POST /files/buckets/:bucketKey/objects` | Upload a file |
| `GET /files/buckets/:bucketKey/objects/:objectKey` | Get a file's record |
| `GET /files/buckets/:bucketKey/objects/:objectKey/download` | Download a file or its Markdown copy |
| `DELETE /files/buckets/:bucketKey/objects/:objectKey` | Delete a file |

Creating, changing and deleting buckets, editing a provider, **Test connection**, importing objects that are already in a provider and downloading several files as a zip are done in the console. See [File storage](/guide/files).

## Providers

A provider is a connection to a store: S3-compatible storage, Amazon S3, Azure Blob Storage, MongoDB GridFS or the server's disk. A bucket keeps its files on one provider.

### List file providers

```
GET /files/providers?driver=s3-compatible-files&status=active
```

| Query | Description |
|-------|-------------|
| `driver` | Only providers of this driver (see the table below). |
| `status` | `active`, `disabled` or `errored`. |

A provider, abridged:

```json
{
  "providers": [
    {
      "_id": "6713e4d0a1b2c3d4e5f60700",
      "key": "minio-archive",
      "type": "file",
      "driver": "s3-compatible-files",
      "label": "Archive (MinIO)",
      "status": "active",
      "settings": {
        "endpoint": "https://minio.internal:9000",
        "bucket": "archive",
        "usePathStyleEndpoint": true
      },
      "hasCredentials": true,
      "driverCapabilities": { "supportsMarkdownConversion": true, "supportsBulkListing": true },
      "createdAt": "2026-10-20T08:00:00.000Z",
      "updatedAt": "2026-10-20T08:00:00.000Z"
    }
  ]
}
```

Credentials are never returned: `hasCredentials` says whether any are stored. `lastTest` holds the result of the last **Test connection** run in the console (`ok`, `at`, `latencyMs`, `message`) and is absent when there is none or when the connection has changed since.

### Create a file provider

```
POST /files/providers
```

| Field | Required | Description |
|-------|----------|-------------|
| `key` | Yes | The provider's key. It is unique in the organization, across every kind of provider: a key that is already used answers `409` (`duplicate_key`). It also names the provider's folder in the store, so it has to be one name: not `.` or `..`, and with no `/`, `\` or control character (`400 provider_settings_invalid`, `field` `key`). |
| `driver` | Yes | One of the drivers below. |
| `label` | Yes | The name shown in the console. |
| `credentials` | Yes | An object with the driver's credentials. Send `{}` for a driver that has none. Stored encrypted and never returned. |
| `settings` | No | An object with the driver's settings. |
| `description` | No | Free text. |
| `status` | No | `active` (default) or `disabled`. |
| `metadata` | No | An object of your own. |
| `capabilitiesOverride` | No | A list of capability names stored with the provider. |

The provider is assigned to the project of the token. It answers `201` with `{ "provider": { … } }` in the shape of the list above.

| Driver | Credentials | Settings |
|--------|-------------|----------|
| `s3-compatible-files` | `accessKeyId`, `secretAccessKey` (both required); `sessionToken` | `endpoint` and `bucket` (required); `region` (default `us-east-1`); `usePathStyleEndpoint` (default `true`); `prefix`; `createBucketIfMissing` (default `false`); `caCertificate`; `allowInsecureTls` |
| `aws-s3-files` | `accessKeyId`, `secretAccessKey` (both required); `sessionToken` | `bucket` (required); `region` (required for Amazon S3, optional with an `endpoint`); `prefix`; `endpoint`; `usePathStyleEndpoint` (default: on when `endpoint` is set); `caCertificate`; `allowInsecureTls` |
| `azure-blob-files` | One of `accountKey`, `sasToken`, `connectionString` or `clientSecret`, as `authMethod` says | `container` (required); `authMethod` (`accountKey`, `sas`, `connectionString` or `entra`); `accountName`; `prefix`; `createContainer`; `endpoint`; `entraTenantId` and `clientId` (for `entra`); `authorityHost`; `apiVersion`; `caCertificate`; `allowInsecureTls` |
| `mongodb-gridfs-files` | `uri` (optional: the console's own MongoDB connection is used when it is left out) | `database`; `bucketName`; `chunkSizeBytes` |
| `local-filesystem` | none | `basePath`; `subdirectory` |

`authMethod` of an Azure provider may be left out when exactly one credential is sent. The two settings of `local-filesystem` have rules of their own: `basePath`, a directory of the server that runs the console, is accepted only on a self-hosted install (`DEPLOYMENT_MODE=onprem`) and only when the person the call acts for is an owner or an admin (the token's owner, or the user a [delegating token](/guide/authentication#acting-for-a-user) acts for), and is refused otherwise (`400 provider_settings_invalid`, `field` `basePath`); leave it out to use the built-in data directory. `subdirectory` has to be a relative folder inside the base directory, with no `..`, no leading `/` or `\` and no drive letter (`field` `subdirectory`). What each field means, which values are accepted and how to set up the store are on the [File storage](/guide/files#storage-providers) page. A driver id the console does not know is stored but fails when the provider is used, so check the spelling (`aws-s3-files` is Amazon S3; there is no plain `s3` driver).

```json
{
  "key": "minio-archive",
  "driver": "s3-compatible-files",
  "label": "Archive (MinIO)",
  "credentials": { "accessKeyId": "archive-service", "secretAccessKey": "…" },
  "settings": {
    "endpoint": "https://minio.internal:9000",
    "bucket": "archive",
    "usePathStyleEndpoint": true
  }
}
```

```json
{
  "key": "azure-files",
  "driver": "azure-blob-files",
  "label": "Company files (Azure)",
  "credentials": { "accountKey": "…" },
  "settings": {
    "authMethod": "accountKey",
    "accountName": "companystorage",
    "container": "cognipeer-files"
  }
}
```

The route checks the credentials and settings but does not connect to the store, so a new provider can still turn out to be unreachable. **Test connection** in the console tries it step by step: [Testing a connection](/guide/files#testing-a-connection).

A value the console refuses answers `400` with the name of the field to change:

```json
{
  "error": "Bucket name must be 3-63 characters long.",
  "code": "provider_settings_invalid",
  "field": "bucket"
}
```

| `code` | Meaning |
|--------|---------|
| `provider_settings_invalid` | A setting or credential is missing, malformed or not allowed with the other values. `field` names it. |
| `provider_endpoint_not_allowed` | The address is not allowed in this deployment: the hosted service accepts public addresses and the private networks its operator has opened for your organization, while a self-hosted install accepts private ones unless it blocks them. On the hosted service, loopback, link-local and cloud-metadata addresses are never accepted. `field` names the setting that holds the address. See [Which endpoints a provider may use](/guide/files#which-endpoints-a-provider-may-use). |

A missing `key`, `driver`, `label` or `credentials` answers `400` with `{ "error": "key is required" }`. A key that another provider of the organization already uses answers `409` with `code: "duplicate_key"`:

```json
{
  "error": "Provider with key \"minio-archive\" already exists.",
  "code": "duplicate_key"
}
```

A key that cannot name a folder (`.`, `..`, or one that holds `/`, `\` or a control character) answers `400` with `code: "provider_settings_invalid"` and `field: "key"`.

## Buckets

### List buckets

```
GET /files/buckets
```

```json
{
  "buckets": [
    {
      "id": "6713e4d0a1b2c3d4e5f60718",
      "tenantId": "66f1c0a2e4b0a1b2c3d4e5f6",
      "projectId": "66f1c0a2e4b0a1b2c3d4e5f7",
      "key": "contracts",
      "name": "Contracts",
      "description": "Signed contracts",
      "providerKey": "minio-archive",
      "status": "active",
      "createdBy": "66f1c0a2e4b0a1b2c3d4e5f8",
      "createdAt": "2026-10-20T08:05:00.000Z",
      "updatedAt": "2026-10-20T08:05:00.000Z",
      "provider": {
        "key": "minio-archive",
        "driver": "s3-compatible-files",
        "label": "Archive (MinIO)",
        "status": "active"
      }
    }
  ],
  "count": 1
}
```

| Field | Description |
|-------|-------------|
| `key` | The bucket's key: what you put in the path. |
| `status` | `active`, or `disabled`. A disabled bucket takes no new files (`409 bucket_inactive`) but still lists and gives its files back. |
| `providerKey` | The provider that stores the files. |
| `provider` | That provider's view (as in the provider list); absent when the provider no longer exists. |
| `prefix` | The folder inside the provider's storage. When it is not set, the bucket key is the folder. |

### Get a bucket

```
GET /files/buckets/:bucketKey
```

Answers `{ "bucket": { … } }`, or `404` with `code: "bucket_not_found"`.

## Files

A file has a **record** in the console's database and an **object** in the provider's storage. The record is what the API returns.

```json
{
  "id": "6713e4d0a1b2c3d4e5f60730",
  "tenantId": "66f1c0a2e4b0a1b2c3d4e5f6",
  "projectId": "66f1c0a2e4b0a1b2c3d4e5f7",
  "providerKey": "minio-archive",
  "bucketKey": "contracts",
  "key": "2026/q3/report.pdf",
  "name": "report.pdf",
  "size": 482113,
  "contentType": "application/pdf",
  "checksum": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "metadata": { "department": "sales" },
  "markdownStatus": "succeeded",
  "markdownKey": "2026/q3/report.md",
  "markdownSize": 18211,
  "markdownContentType": "text/markdown",
  "createdBy": "66f1c0a2e4b0a1b2c3d4e5f8",
  "createdAt": "2026-10-20T08:14:03.221Z",
  "updatedAt": "2026-10-20T08:14:04.017Z"
}
```

| Field | Description |
|-------|-------------|
| `id` | The record's id. |
| `key` | The file's key inside the bucket. Pass it as `:objectKey` in the paths below. It can hold slashes (see [Keys](#keys)). |
| `name` | The file name as it was uploaded. |
| `size`, `contentType` | Size in bytes and content type of the original. |
| `checksum` | SHA-256 of the original, as hex. |
| `etag` | The store's entity tag, when it gives one. |
| `metadata` | The metadata sent with the upload. |
| `markdownStatus` | `pending`, `succeeded`, `failed` or `skipped`. See [Markdown copies](#markdown-copies). |
| `markdownKey`, `markdownSize`, `markdownContentType` | The Markdown copy the file has, if any, whatever the status of its latest conversion. A copy made earlier stays while a new conversion is `pending` and when that one ends `failed` or `skipped`, and `variant=markdown` still downloads it. Uploading to the same key again removes it. |
| `markdownError` | Why a conversion failed or was skipped. |
| `origin` | `import` for an object that was already in the provider and was registered in the console, `agent_output` for a file an agent wrote; absent for an upload. |
| `purpose`, `conversationId`, `agentKey`, `expiresAt`, `uploadedBy` | Set on a file that belongs to an agent session. See [Session files](#session-files). |
| `createdBy`, `updatedBy`, `createdAt`, `updatedAt` | Who and when. `createdBy` is `api` when the call ran without a user. |

### List files

```
GET /files/buckets/:bucketKey/objects?search=report&limit=50&cursor=abc
```

| Query | Description |
|-------|-------------|
| `search` | Part of the file name, not case-sensitive. |
| `prefix` | List **one folder**: its files and its sub-folders. A trailing `/` is added when it is missing; `prefix=` (empty) is the bucket root. With `search`, it narrows the search to everything under the prefix, however deep. |
| `purpose` | `conversation` keeps only the files of agent sessions, `other` only the rest. |
| `limit` | Entries per page, 50 by default. A folder listing holds at most 200. In a folder listing sub-folders and files count together. |
| `cursor` | The `nextCursor` of the previous page. |

Without `prefix` the answer is the flat list of every file in the bucket:

```json
{ "count": 12, "files": [ … ], "nextCursor": "6713e4d0a1b2c3d4e5f60740" }
```

With `prefix` it is one folder, found from the file keys, the way an object store lists with a `/` delimiter:

```
GET /files/buckets/contracts/objects?prefix=2026/
```

```json
{
  "count": 3,
  "prefix": "2026/",
  "folders": ["2026/q1/", "2026/q2/"],
  "files": [ { "key": "2026/summary.pdf", … } ]
}
```

`folders` are full paths ending in `/`. `nextCursor` is left out on the last page. A disabled bucket and a provider that cannot be reached still list, because the list comes from the console's database.

### Upload a file

```
POST /files/buckets/:bucketKey/objects
```

The request is JSON, not multipart. The file travels base64-encoded in `data`, so the body is about a third larger than the file.

| Field | Required | Description |
|-------|----------|-------------|
| `fileName` | Yes | The name of the file. Directories in it are dropped (use `keyHint` for folders), control characters and leading dots are removed, and it is cut to 255 characters. |
| `data` | Yes | The content as base64. A data URL (`data:application/pdf;base64,…`) is accepted too. An empty string stores an empty file. |
| `contentType` | No | The MIME type, such as `application/pdf`. A value that is not of the form `type/subtype` is refused (`invalid_content_type`). Required when the deployment limits the upload types (`FILE_UPLOAD_ALLOWED_MIME_TYPES`). |
| `keyHint` | No | The key to store the file under. See [Keys](#keys). |
| `convertToMarkdown` | No | `true` makes a Markdown copy before the call returns. Default `false`. See [Markdown copies](#markdown-copies). |
| `metadata` | No | An object of your own; a text or a list is refused with `400`. Values may be any text, in any language. |

```bash
{
  printf '{"fileName":"report.pdf","contentType":"application/pdf","keyHint":"2026/q3/","data":"'
  base64 < report.pdf | tr -d '\n'
  printf '"}'
} > body.json

curl -X POST "https://gateway.example.com/api/client/v1/files/buckets/contracts/objects" \
  -H "Authorization: Bearer cpeer_your_token_here" \
  -H "Content-Type: application/json" \
  --data-binary @body.json
```

```ts
import { readFile } from 'node:fs/promises';

const res = await fetch(`${base}/files/buckets/contracts/objects`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    fileName: 'report.pdf',
    contentType: 'application/pdf',
    keyHint: '2026/q3/',
    data: (await readFile('report.pdf')).toString('base64'),
  }),
});
const { file } = await res.json(); // 201
```

The answer is `201` with the record of the new file:

```json
{ "file": { "id": "…", "key": "2026/q3/report-1760947200123-3f9a1c2e.pdf", "name": "report.pdf", "size": 482113, … }, "message": "File uploaded successfully" }
```

A bucket that does not exist, or that is disabled, is refused before anything is counted against the quotas.

#### Keys

The key is the file's address inside the bucket and the `:objectKey` of the other calls.

- Without `keyHint` the key is generated from the file name: lowercase letters (accents are dropped, so `Şubat Özeti` becomes `subat-ozeti`), digits, `-` and `_`, then a timestamp and a short random id, then the extension (`report-1760947200123-3f9a1c2e.pdf`). Two uploads never meet. The name is at most 200 bytes of UTF-8: a longer file name is shortened before the timestamp (which is never cut), and an extension is kept up to 32 bytes.
- A `keyHint` that ends in `/` names a **folder**. The file is stored in it under a generated name, as above.
- Any other `keyHint` is the **whole key**. Uploading to a key that already has a file replaces that file.
- A `keyHint` is text of at most 512 characters, with no `.` or `..` segment, no control characters and no unpaired surrogate (half of a character that has no UTF-8 form, which a JSON string can carry but no store can keep). Backslashes become `/`, repeated slashes become one, and a leading `/` is dropped. A `keyHint` that breaks these rules is refused with `400` before the upload is counted, with one of these messages: `keyHint cannot contain "." or ".." segments.`, `keyHint cannot contain control characters.`, `keyHint cannot contain unpaired surrogate characters.`, `keyHint must be text.` and `keyHint must be at most 512 characters.`
- The store limits the whole object name, which also holds the provider's folders in front of the key: 1024 bytes on Amazon S3, 1024 characters and 254 path segments on Azure Blob. A key that does not fit, or holds something the store does not take (a name part over 255 bytes on MinIO and on a local disk, say), is refused with `400 invalid_request` and a message that says so.

#### Metadata

`metadata` is stored with the record and, where the store allows, with the object. S3 and Azure limit the size of object metadata, and what does not fit is left off the object, never off the record. Metadata comes back in the record and in the `X-File-Metadata` header of a download. The header is left out when the metadata is too large for one (see [Download a file](#download-a-file)), so read the record when you need all of it.

#### Quotas

The project's quota policies are applied: the file size, files per request, request and upload rates, the number of files and the storage bytes. A refused upload answers `429` with a sentence in `error` and no `code`.

### Get a file

```
GET /files/buckets/:bucketKey/objects/:objectKey
```

Answers `{ "file": { … } }`, or `404` with `bucket_not_found` or `file_not_found`.

`:objectKey` is **one path segment**: a key that holds slashes is sent with them percent-encoded, as `encodeURIComponent` does.

```bash
curl "https://gateway.example.com/api/client/v1/files/buckets/contracts/objects/2026%2Fq3%2Freport.pdf" \
  -H "Authorization: Bearer cpeer_your_token_here"
```

```ts
const url = `${base}/files/buckets/contracts/objects/${encodeURIComponent(file.key)}`;
```

### Download a file

```
GET /files/buckets/:bucketKey/objects/:objectKey/download?variant=original
```

| Query | Description |
|-------|-------------|
| `variant` | `original` (default) or `markdown`. Any other value is refused with `400`. |

The answer is the file's bytes. Headers:

| Header | Value |
|--------|-------|
| `Content-Type` | The stored content type, `application/octet-stream` when there is none. |
| `Content-Disposition` | `attachment`, with the file name as an ASCII fallback and, percent-encoded, as `filename*`. |
| `Content-Length` | The size in bytes. |
| `ETag` | The store's entity tag, when it gives one. |
| `X-Content-Type-Options` | Always `nosniff`. |
| `Cache-Control` | Always `private, no-store`: the file is for the caller who asked for it, so a shared cache or a proxy does not keep it. |
| `X-File-Metadata` | The file's metadata as JSON, when the file has any. Every character outside printable ASCII is escaped as `\uXXXX`, so the value is plain ASCII and `JSON.parse` reads it back unchanged. It is left out when the escaped JSON is longer than 8,192 characters, because clients refuse very large response headers; the file's record (`metadata`) always has it all. |

`variant=markdown` of a file that has no Markdown copy answers `400` with `code: "markdown_unavailable"` (the Document Store answers `409` for the same case). A disabled bucket still gives its files back. An object larger than the server reads into memory at once is refused with `413 object_too_large`.

### Delete a file

```
DELETE /files/buckets/:bucketKey/objects/:objectKey
```

Deletes the stored object, its Markdown copy and then the record. An object that is already gone from the provider does not stop the delete.

```json
{ "message": "File deleted successfully", "bucketKey": "contracts", "objectKey": "2026/q3/report.pdf" }
```

A disabled bucket keeps its files (`409 bucket_inactive`).

## Markdown copies

`convertToMarkdown: true` turns a document into text the Knowledge Engine can ingest. The copy is stored next to the original, which is never changed: `notes.txt` gets `notes.md`, and `notes.txt.md` when that name is taken.

- On this API the conversion runs **before the response**, so the copy can be downloaded right away and a large document makes the call slower. The console's own upload converts in the background.
- The upload itself succeeds even when the conversion does not. Read `file.markdownStatus`: `succeeded`, `failed` (with `markdownError`) or `skipped`.
- Ask for a copy only of the formats the converter has a reader for: `.pdf`, `.doc`, `.docx`, `.pptx`, `.xlsx`, `.xls`, `.epub`, `.msg`, `.html`, `.htm`, `.xml`, `.rss`, `.atom`, `.txt`, `.csv`, `.json`, `.yaml`, `.yml` and `.ipynb`. For any other file the copy is of no use: an image yields only its size and format, an archive is unpacked in memory, and a binary file is read as text.
- A document that unpacks to more than 100 MB, or is made of more than 5000 parts, is not opened and ends as `failed`.

## Session files

Files attached to agent sessions are ordinary files in the bucket the agent names, under `<folder>/<agentKey>/<sessionId>/`. They carry `purpose: "conversation"`, `conversationId`, `agentKey`, `expiresAt` and `uploadedBy`. Whoever started the session sees its files; for the sessions of others the token's owner needs the Agents permissions described in [Authorization](/guide/authorization#sessions-and-approvals). A listing leaves the other files out and fills the page from the following ones, so a page is not short while the bucket goes on. Fetching or downloading such a file by its key needs the permission to view the session, and deleting it, or uploading to its key (a `keyHint` that names the whole key), needs the permission to change it; without it the call is refused with `403 session_forbidden`. These refusals, and `503 authorization_unavailable` when the permission engine cannot decide, use the client API's nested error form:

```json
{
  "error": {
    "type": "permission_error",
    "message": "This session was started by someone else, and you are not allowed to view it.",
    "code": "session_forbidden",
    "decision_id": "7c0f6b2e-5d1a-4c1e-9a53-0d9b8a1f2e44"
  }
}
```

See [Session files](/guide/session-files) and [Who sees a session](/guide/agent-sessions#who-sees-a-session).

## Limits

| Limit | Value |
|-------|-------|
| File size | 50 MB by default (`FILE_UPLOAD_MAX_MB`). A larger file is refused with `413 file_too_large`. |
| Request body | The file as base64 plus 64 KiB. A larger body is refused with the same code before it is read. |
| Largest object read at once | The larger of twice the upload limit and 100 MB. |
| Upload types | Any, unless `FILE_UPLOAD_ALLOWED_MIME_TYPES` lists them. `415 content_type_not_allowed` otherwise. |
| `keyHint` | 512 characters. |
| Object name | Set by the store and counted with the provider's folders: 1024 bytes on Amazon S3, 1024 characters and 254 path segments on Azure Blob. |
| Listing | 50 entries per page by default, 200 at most in a folder listing. |

## Errors

Errors are JSON. A refusal of the Files API has the form `{ "error": "…", "code": "…" }`, and the message is written to be shown. Quota refusals and a few request checks have no `code`. The refusals about a session's file (`session_forbidden` and `authorization_unavailable` below) come from the session permission check that the agent routes use, and have the client API's nested form `{ "error": { "type": "…", "message": "…", "code": "…" } }`: read `error.code` for those (see [Session files](#session-files)).

| Status | `code` | Meaning |
|--------|--------|---------|
| 400 | `invalid_request` | Upload: the body is not valid JSON, or not a JSON object, or the store refuses the key (see [Keys](#keys)). |
| 400 | `invalid_content_type` | `contentType` is not of the form `type/subtype`. |
| 400 | `markdown_unavailable` | `variant=markdown` of a file with no Markdown copy. |
| 400 | `provider_settings_invalid`, `provider_endpoint_not_allowed` | Creating a provider: a value is refused. `field` names it. |
| 400 | none | A required field is missing (`fileName is required`, `data is required (base64 or data URL)`), a `keyHint` is not valid, `metadata` is not an object, or `variant` is unknown. |
| 401 | none | The API token is missing or not valid. |
| 403 | `session_forbidden` | The file belongs to an agent session that somebody else started, and the token's owner may not view it (get, download) or change it (upload to its key, delete). Nested form, with `error.decision_id`. |
| 404 | `bucket_not_found`, `file_not_found` | The bucket or the file does not exist in the project. |
| 409 | `bucket_inactive` | The bucket is disabled. It takes no uploads and no deletes. |
| 409 | `bucket_deleting` | The bucket's files are being deleted. |
| 409 | `duplicate_key` | Creating a provider: another provider of the organization already has this key. |
| 409 | `provider_inactive`, `provider_unassigned`, `provider_missing`, `provider_invalid` | The bucket's provider is switched off, not assigned to the project, gone, or not a file provider. |
| 413 | `file_too_large` | The file, or the request body, is over the upload limit. |
| 413 | `object_too_large` | A download of an object larger than the server reads at once. |
| 415 | `content_type_not_allowed` | The content type is not in the deployment's allow-list. |
| 429 | none | A project quota or rate limit. `error` says which. |
| 502 | `storage_failure` | The store refused or failed the call. `error` is a sentence made for people (a missing bucket, wrong credentials, an unreachable host). When the cause is a provider setting, including an address the deployment no longer allows, `field` names it. |
| 503 | `storage_unavailable` | The provider has been failing and calls to it are paused for a short time. Retry in a moment. |
| 503 | `authorization_unavailable` | The permission engine could not decide, so the call was refused (never allowed); retry after the `Retry-After` delay. The check on a session's file, which a listing also makes, answers in the nested form; the permission gate's own answer is flat, with `code` and `decisionId` at the top level. |
| 504 | `storage_timeout` | The store did not answer in time. |

A `502` carries a sentence made for people: it holds no credentials, no raw answer of the store and no server path. The details stay in the server log. See [Troubleshooting](/guide/files#troubleshooting) for what the common messages mean, and [Resilience](/guide/files#resilience) for how retries and pauses work.

## See also

- [File storage](/guide/files): the Document Store screens, how to set up each kind of store, the endpoint rules, **Test connection** and troubleshooting.
- [Session files](/guide/session-files): how agents keep their attachments in a bucket.
- [OpenAPI specification](./openapi): the machine-readable description of these routes.
