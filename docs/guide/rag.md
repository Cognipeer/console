# Knowledge Engine

The Knowledge Engine (Retrieval-Augmented Generation / RAG) service provides end-to-end document ingestion, chunking, embedding, and semantic retrieval. It surfaces in the console as **Data → Knowledge Engine**.

## Knowledge Engine

A *Knowledge Engine module* is the configuration unit that ties a chunking strategy, an embedding model, and a vector index together. The Knowledge Engine screen lists every module configured for the active project, with counters for modules, documents indexed, and chunk count.

![Knowledge Engine list](/screenshots/rag/01-rag-list.png)

When the project is empty the screen shows the onboarding CTA — clicking **Create module** opens a multi-step form where you choose the source datasource, pick chunking parameters (size, overlap, splitter), select an embedding model from [Model Hub](/guide/model-hub), point the output at a vector index (see [Vector Stores](/guide/vector-stores)), and — optionally — attach a [Reranker](/guide/reranker) to re-order results before they reach the LLM.

When a reranker is attached, retrieval becomes a two-stage pipeline: the vector store returns top-K candidates and the reranker scores them down to the final top-N. This is the recommended way to plug Cohere Rerank, Jina, Voyage, or any cross-encoder onto an existing Knowledge Engine module without changing the embedding model or vector store.

## Architecture

```
Document → Chunk → Embed → Vector Store
                              ↓
Query   → Embed → Vector Search → (Reranker?) → Return Matches
```

## Concepts

| Concept | Description |
|---------|-------------|
| **Knowledge Engine Module** | Configuration container linking chunking strategy, embedding model, and vector index |
| **Document** | A text or file ingested into a module |
| **Chunk** | A segment of a document after splitting |
| **Query Log** | Audit record of retrieval queries |

## Service Functions

| Function | Description |
|----------|-------------|
| `createRagModule()` | Create module with chunk/embed config |
| `updateRagModule()` | Update module settings |
| `deleteRagModule()` | Delete module and associated data |
| `getRagModule()` | Get by key |
| `listRagModules()` | List modules for tenant |
| `ingestDocument()` | Text ingestion: chunk → embed → store |
| `ingestFile()` | File ingestion: convert → chunk → embed → store |
| `queryRag()` | Semantic retrieval |
| `deleteRagDocument()` | Delete document and its vectors |
| `reingestDocument()` | Re-chunk and re-embed existing document |
| `listRagDocuments()` | List documents in a module |
| `listRagQueryLogs()` | Query audit log |

## Module Configuration

```json
{
  "name": "Support Knowledge Base",
  "key": "support-kb",
  "embeddingModelKey": "text-embedding-ada-002",
  "vectorProviderKey": "vectors-prod",
  "vectorIndexKey": "support-index",
  "rerankerKey": "support-rerank",
  "chunkConfig": {
    "strategy": "recursive",
    "chunkSize": 1000,
    "chunkOverlap": 200
  }
}
```

`rerankerKey` is optional. When present, the matching reranker (see [Reranker](/guide/reranker)) runs after vector search and before the response is returned.

## Text Ingestion

```
POST /api/client/v1/rag/modules/:key/ingest
Authorization: Bearer <token>
```

```json
{
  "fileName": "product-faq.txt",
  "content": "Long document text here...",
  "contentType": "text/plain",
  "metadata": { "source": "docs", "version": "2.0" }
}
```

**Pipeline:**
1. Split text into chunks using configured strategy
2. Generate embeddings for each chunk
3. Upsert vectors to the vector index
4. Store document and chunk metadata

## File Ingestion

Submit a file for automatic processing:

1. File is converted to Markdown (using `@cognipeer/to-markdown`)
2. Markdown is chunked according to module config
3. Chunks are embedded and stored

## Querying

```
POST /api/client/v1/rag/modules/:key/query
Authorization: Bearer <token>
```

```json
{
  "query": "How do I reset my password?",
  "topK": 5,
  "filter": { "source": "docs" }
}
```

**Pipeline:**
1. Embed the query text
2. Perform vector similarity search
3. Return matching chunks with scores and metadata

**Response:**

```json
{
  "matches": [
    {
      "content": "To reset your password, navigate to...",
      "score": 0.92,
      "metadata": { "source": "docs", "documentTitle": "Product FAQ" }
    }
  ]
}
```

## Re-ingestion

When a document is updated or chunking config changes, use `reingestDocument()` to:

1. Remove existing vectors for the document
2. Re-chunk with current settings
3. Re-embed and store new vectors

## Dependencies

The Knowledge Engine pipeline integrates several gateway services:

- **Inference Service** — For generating embeddings
- **Vector Service** — For storing and querying vectors
- **File Service** — For file conversion (optional)

## Metadata Filtering

Queries accept a `filter` in the console's canonical filter language, which the
gateway pushes down to the vector store — see
[Vector Stores → Metadata Filtering](./vector-stores.md#metadata-filtering) for the
operator list and per-provider support.

A module can also carry its own filter configuration:

| Setting | Effect |
| --- | --- |
| `defaultFilter` | ANDed into every query against the module. Lets several sources share one vector index while each module retrieves only its own slice. |
| `filterableFields` | Metadata keys callers may filter on. A query touching any other key is rejected with `400`. The list is also surfaced to agents and MCP clients as the `filter` argument's documentation, so a model knows what it may narrow by. |

```bash
curl -X POST "$CONSOLE_URL/api/client/v1/rag/modules/support-kb/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "how do I reset my password?",
    "topK": 5,
    "filter": { "source": "crawler", "depth": { "$lte": 2 } }
  }'
```

A filter the underlying vector store cannot push down is rejected rather than
ignored, so a filtered query never silently returns unfiltered passages.

## Attaching knowledge bases to an agent

An agent can search several Knowledge Engine modules. In the agent editor, add one row per module under **Knowledge Engine**:

| Field | Meaning |
|---|---|
| `key` | The Knowledge Engine module. |
| `description` | Tells the model when to use it ("Use for: HR policies"). Strongly recommended with more than one module. |
| `topK`, `minScore` | Optional per-module overrides. When unset, the module's own defaults apply. |
| `filter` | Optional fixed metadata filter, AND-ed with any filter the model supplies. |
| `enabled` | Set to `false` to keep the row but stop using it. |

`knowledgeToolMode` chooses the tool surface:

- `combined` (default): one `knowledge_search` queries every enabled module at once. Hits are merged by score (best 10 overall) and tagged `[kb: <key>, documentId: ..., file: ..., score: 0.xx]`. One `knowledge_read_document` / `knowledge_read_document_lines` pair takes an optional `kb` argument; the document must belong to a bound module.
- `separate`: each module gets its own tools, suffixed with the module key (`knowledge_search_<key>`, `knowledge_read_document_<key>`, ...), with the description added to the tool description.

The older single `knowledgeEngineKey` still works and is treated as one binding; when both are present, `knowledgeBindings` wins. Modules not visible to the agent's project are skipped with a warning.

## Access control

A knowledge base can decide who reads each of its documents. Access control is **off by default** and switched on
per knowledge base. A knowledge base that leaves it off works as before: everyone who can read the knowledge base
reads every document in it.

```
PATCH /api/client/v1/rag/modules/:key
Authorization: Bearer <token>
```

```json
{ "access": { "enabled": true } }
```

Changing `access` needs Knowledge Engine `admin`. Switching access control on hides nothing by itself: the top level
of the knowledge base stays open to everyone until its permissions are changed.

### How permissions apply

Permissions sit on the knowledge base itself (its top level), on a folder or on a document. A folder or a document
uses the permissions of the folder it is in, and so on up to the top level, unless it has its own (`mode: "own"`),
which replace what it would inherit.

- The top level without entries is open to everyone who can read the knowledge base.
- A folder or a document with its own permissions and no entries is read by nobody, apart from the exception for
  administrators below.
- A document in a folder that no longer exists is read by nobody, apart from that exception.

An entry names who may read:

| Principal | Who |
|---|---|
| `everyone` | Everyone who can read the knowledge base |
| `user:<id>` | A console user |
| `group:<id>` | A console group |
| `token:<id>` | An API token, for calls with no person behind them |
| `email:<address>` | The console person with this e-mail address |
| `x:<directory>:u:<id>` | A user of an [external directory](#external-directories) |
| `x:<directory>:g:<id>` | A group of an external directory |
| `x:<directory>:all` | Every member of an external directory, not its guests |

A folder or a document holds at most 1000 entries. An entry may carry a `label` of up to 200 characters, which is
shown and never used to decide. The users, groups, tokens and directories an entry names must exist
(`400 principal_unknown`).

### Who reads what

| Caller | Reads |
|---|---|
| A person: a session, a run they started, a call that acts for them | What their user, e-mail address, groups and matched directory identities are named on |
| An API token with no person behind it | What is open to everyone, and what names the token |
| No person: a trigger, the agent steps of a flow | What is open to everyone |
| Ingest, re-indexing, connector syncs | Every document |

A flow runs as its owner, but no person is asking, so its agent steps and the tools they call read as no one in
particular. The flow editor's playground reads as the person at the screen.

The people who administer a knowledge base (Knowledge Engine `admin` in its project) read every document in searches,
answers, agent tools and document reads, unless the knowledge base turns that off with `"adminBypass": false`. In
the management views (document lists, folders, permissions) they always see every document, so they can set
permissions. Calls of the client API never get this exception.

Reads are checked on every path: queries and searches, answers, the client API, agent knowledge tools, the knowledge
base MCP tools, and document detail, content, lines and export. The check happens while the vector store is searched,
before a [reranker](/guide/reranker) or the score threshold sees a passage. A document the caller may not read is left
out of lists and answers `404`, like a missing one. A knowledge base with access control is listed without
`totalDocuments` and `totalChunks` for a caller whose reads are checked (an API token always is).

### Folders

Folders form a tree in each knowledge base, with access control on or off. An ingest or a re-ingest can place a
document with `folderId`, or with a `folderPath` such as `Finance/Budgets` whose missing folders are created. The
dashboard routes (session authentication, in the active project) manage folders:

| Route | Does |
|---|---|
| `GET /api/rag/modules/:key/folders` | Lists the folders |
| `POST /api/rag/modules/:key/folders` | Creates one: `{ "name": "Budgets", "parentId": "<folder id>" }` (`parentId: null`: the top level) |
| `PATCH /api/rag/modules/:key/folders/:folderId` | Renames it (`name`) or moves it (`parentId`) |
| `DELETE /api/rag/modules/:key/folders/:folderId` | Deletes it, when it holds no folder and no document (`409 folder_not_empty`) |
| `POST /api/rag/modules/:key/documents/move` | Moves up to 500 documents: `{ "documentIds": ["..."], "folderId": "<folder id>" }` |
| `PATCH /api/rag/modules/:key/documents/:documentId` | Moves one document: `{ "folderId": null }` puts it at the top level |

They need Knowledge Engine `write`. With access control on, only the administrators of the knowledge base, and an
API token with Knowledge Engine `admin`, create, change and delete folders and move documents (`403 access_denied`).
Anyone else lists only the folders they may read and the folders above them, and their ingest places a new document
only in a folder they can read, without creating one. A folder name has 1 to 200 characters, with no `/` and no
control characters. Folders nest at most 64 levels (`400 folder_too_deep`), two folders under one parent cannot share
a name (`409 folder_exists`), and a folder cannot move below itself (`409 folder_cycle`).

### Setting permissions

```
GET /api/rag/modules/:key/acl?node=folder:<folder id>
PUT /api/rag/modules/:key/acl
```

```json
{
  "node": "folder:65f0c2a1e4b0a1b2c3d4e5f6",
  "mode": "own",
  "entries": [
    { "principal": "group:65f0c2a1e4b0a1b2c3d4e5f7", "label": "Finance" },
    "email:ada@example.com"
  ]
}
```

`node` is `module` (the default, the top level), `folder:<id>` or `document:<id>`. `mode: "inherit"` drops the own
permissions of a folder or a document; the top level always has its own. The answer holds the node's own `entries`
and the `effective` ones, those of the nearest node with its own, with `openToEveryone: true` when that is the top
level without entries. Both routes need Knowledge Engine `admin`. An ingest or a re-ingest can set a document's own
permissions with `acl` (`{ "mode": "own", "entries": [...] }`), which needs `admin` too.

To check one person, `GET /api/rag/modules/:key/access/explain?userId=<id>&documentId=<id>` answers whether a console
user of the project can read the document (`readable`), which node decides (`effectiveNode`), and which of the
person's keys its entries name (`grantedBy`). Knowledge Engine admins of the whole workspace also see who the person
is: their e-mail address, groups, every key and how the directories matched them.

### External directories

An external directory holds the users and groups of another system, such as the people and groups a SharePoint
source reads from its site's directory, so that permissions can name them (`x:<directory>:...`). Directories belong to the workspace, not to
one project, and only its Knowledge Engine admins manage them. A person holds the keys of the directory users they
are matched to:

1. The directory's `userMatch` rules, in order, compare one of the person's values (`email`, or `externalId`: their
   SSO or LDAP id) with a field of the directory's users (`email`, `upn`, `id` or `attr:<name>`). The first rule that
   finds users decides. Without rules a person is matched by `email` to `email`, then by `email` to `upn`. The matched
   users' groups count too (nested ones included), and so does `x:<directory>:all` for members, not guests.
2. A console group whose external id is the id of a directory group stands for that group, unless the directory turns
   it off (`"matchGroupsByExternalId": false`).
3. A link connects a console user or group to a directory user or group by hand.

An **external** account (a person of a host application, see [Authorization](/guide/authorization)) is matched by
groups and links only, not by the rules.

The users of a directory are reported by an integration, such as a SharePoint source of the Connectors module
(Enterprise). Without one, an `externalId` to `id` rule still matches a person by their SSO or LDAP id, and links
work too. A change of rules or links applies to the next query (a person's keys are kept for up to 15 seconds); no
document is rewritten.

| Route | Does |
|---|---|
| `GET /api/rag/identity/domains` | Lists the directories |
| `PUT /api/rag/identity/domains/:domainKey` | Creates or changes one: `label`, `userMatch`, `matchGroupsByExternalId` |
| `DELETE /api/rag/identity/domains/:domainKey` | Deletes one, with the permissions that name it |
| `GET /api/rag/identity/domains/:domainKey/users` | Lists its users (`search`, `limit`, `offset`) |
| `GET /api/rag/identity/links` | Lists the links (`domain`, `consoleKind`, `consoleId`) |
| `POST /api/rag/identity/links` | Adds one: `domain`, `externalKind` and `externalId`, `consoleKind` and `consoleId` (each kind `user` or `group`) |
| `DELETE /api/rag/identity/links/:linkId` | Removes one |

A directory key has up to 64 lower-case letters, digits, `.`, `_` and `-`, and starts with a letter or a digit. A
directory cannot be deleted while it is all that the top level of a knowledge base names (`409 domain_in_use`): give
that knowledge base other permissions first. What a connector source maintains (its directory, its folders, and
their documents and permissions) is changed only by that source (`409 domain_managed_by_source`,
`folder_managed_by_source`, `document_managed_by_source`, `acl_managed_by_source`).

### Work that used documents not open to everyone

Work that read documents not open to everyone is shown in full only to the person who asked and to the
administrators of those knowledge bases: sessions, background runs, reminders, traces, model logs, and evaluation,
red-team and analysis results. With `adminBypass: false` it is the person who asked alone, and an API token never
counts as an administrator. Anyone else sees such a row without its content, opening it answers
`403 session_restricted`, and only those people answer its pending approvals. Snapshots leave such sessions out, and
the EU AI Act compliance report leaves out such red-team attempts. While an agent works with such documents, it
writes no memory that other people share.

### Other services

- A crawler sends pages into a knowledge base with access control only when one of its administrators sets the
  crawler up (`403 kb_access_controlled` otherwise). There a page replaces only a page the same crawler sent.
- An evaluation run on a RAG target reads as the person who started it. Generating a dataset from a knowledge base
  uses only documents open to everyone.
- The stored files and the vector index of a knowledge base with access control are read through the knowledge base.
  The file routes serve its files, and the vector routes query and copy its index, only to its administrators while
  the admin exception is on, and never to an API token. Anyone else gets `404` for a file and
  `403 kb_access_controlled` for the index, and no other knowledge base can be put on that index.
