# Session files

People can attach documents and images to a session. The agent reads them in the turn, or, when they are long, page by page with read-only tools, and it can look at an image again whenever it needs to. Files belong to one session, live for a set number of days and go when the session is deleted.

A session file is an ordinary file in a **bucket of your project** (the Document Store). You choose the bucket; nothing is stored anywhere you did not choose, and **nothing is written to the server's disk** unless the bucket you pick is on a local-disk provider on purpose.

## In Studio

The paperclip in the session composer attaches files. Each file appears as a chip with its size; a chip in orange means no text could be extracted from it, so the agent can only see that it exists. Attached files are shown on the message they were sent with. Send the message and the chips go with it. The paperclip is only there when the agent has files switched on and a bucket chosen; if that bucket later stops working, the upload says which one.

## Settings

**Configure → Files**, per agent. Files are **off** until you switch them on and choose a bucket.

| Setting | Default | What it does |
| --- | --- | --- |
| Let people attach files | off | Off: the agent takes no attachments. A connected (external) agent never does. |
| Bucket | none | **Required when on.** A bucket of the agent's project that is active and whose provider is active and assigned to the project. Saving is refused otherwise. |
| Folder | `agent-sessions` | Root folder inside the bucket. A file is stored at `<folder>/<agentKey>/<sessionId>/<unique name>`. Letters, digits and `. _ - /` only (at most 200 characters). |
| Files per session | 10 | A session holds at most this many files. |
| Largest file (MB) | 20 | Larger uploads are refused (413). The platform's `FILE_UPLOAD_MAX_MB` is the ceiling. |
| Allowed file types | any | MIME types; `image/*` works. |
| Put in the message up to (tokens) | 30000 | See below. Estimated as characters / 4. |
| Page size when reading (characters) | 20000 | Size of a page of `session_files_read`. |
| Keep files for (days) | 30 | The file is deleted this long after upload. |
| Attach new uploads to the next message | on | Files uploaded to a session that no message has carried yet go with the next message. |
| Pictures per model request | 6 | How many images one request to the model carries. The newest win; an older one becomes a note that names it (the agent can look again, see below). |
| Picture bytes per model request | 12000000 | The same limit in bytes (before base64), oldest dropped first. |
| Show earlier pictures again | 2 | When the agent's own context no longer holds the pictures of your last *N* messages that had one, they are shown again with the next message. 0 = never. |

An agent saved before files had a bucket setting, or with files switched on but no bucket, **takes no attachments**: the paperclip is hidden and an upload is refused with `403 attachments_disabled` ("Files are not set up for this agent").

### Where the files are

They are normal Document Store files (**Files** in the sidebar): same drivers (S3 and compatible, or local disk), same markdown conversion, same project file quotas. In the bucket, **Session files** are told apart from the rest, and a session file shows the session it belongs to, when it expires and who uploaded it. Open the bucket's folders to see `agent-sessions/<agent>/<session>/…`.

A bucket an agent keeps session files in **cannot be deleted or disabled** (409) until you choose another bucket for that agent — whether its draft or its *published* version still names it (the version API callers and portals run keeps writing there even after you moved the draft). If the bucket or its provider stops working later, an upload is refused with `409 storage_unavailable`, naming the bucket; the retention cleanup drops the record of an expired file whose bucket is gone for good (and logs `session_file_orphaned` for the object left behind) instead of retrying it every hour. Changing the agent's bucket affects new files only; earlier files stay readable in the bucket they were stored in.

### Who can choose the bucket

Choosing or changing the bucket needs **write access to Files** (the Document Store); the list of buckets to pick from needs **read access to Files** — without it the Files section says so instead of showing an empty list. Saving the agent with the bucket it already has asks nothing of Files. An API token is held to the same rule, within its own scope.

Two things to know when you choose: **portal users get the settings of the agent's *published* version**, not the draft, so a new bucket reaches them with the next publish; and a bucket on a **server-disk** provider keeps files on one server's disk — fine for a single node, not for a cluster that scales out.

## What the agent sees

- **Documents.** The file is converted to markdown (the original is kept). If the text of all the files attached to a message is at most the inline limit, it goes in the user turn as `<document name="…" id="…">…</document>` blocks. If not, the turn carries a short note listing the files and their page counts, and the agent reads them with `session_files_read({ fileId, page })`, which returns `{ text, page, pages }`.
- **What was attached.** The attachment block of the turn names **every** attachment, whatever the mix — "The person attached 4 files: 3 documents to read with the tools, 1 image shown below." — also for a message of images only, so the model knows what it was sent even when most of it is in the tools or below as pictures.
- **Images.** Sent to the model as images when the model accepts image input; otherwise the turn says an image was attached that the model cannot read. A chat model accepts images when its **input modalities** say so (Model Hub → the model → input modalities). A model with nothing stored for it is taken to accept images when its id belongs to a known vision family (GPT-4o/4.1/5 and later, o-series except `o1-mini` and `o3-mini`, Claude 3 and later, Gemini, Llama 3.2 Vision and 4, Qwen-VL, Pixtral, Grok vision, Nova, …); a choice you store on the model — including "text only" — always wins over the id.
- **Images travel by reference, not as bytes.** In the agent's context, its saved state and its traces a picture is a short reference (`session-file://<fileId>`) behind a text handle — `[Attached image: "cat.png" (id …)]` — that the model can call it by. The bytes are read from the bucket only at the moment the model is called, once per run, within *Pictures per model request* and *Picture bytes per model request*. Three things follow: a photo no longer makes a conversation look full to the agent (its size estimate counts an image as an image, about 850 tokens, not as the characters of its bytes), so it is not compacted away for nothing; the saved state stays small however many pictures a session holds; and a picture survives into later messages and into a replay of the conversation. A picture whose file is gone is replaced by `[Image "…" is no longer available]`.
- **Looking again.** While the session holds an image and the model accepts images, the agent also has `session_files_view_image({ fileId })`: it returns the picture in a message that follows the tool result, for an image the context no longer shows or one that was left out of a crowded request. `session_files_read` on an image points at it.
- **Files nobody has sent yet.** A file uploaded to the session before the first message, or since the last one, goes with the next message — you do not have to name it. That is how "create a session, upload, ask" works from the API. (The agent's *Attach new uploads to the next message* setting turns this off; the files are then only reachable with the two tools below.)
- **Earlier uploads.** `session_files_list` and `session_files_read` are offered whenever the session holds a file, so a later message can ask about an earlier upload. All the file tools only read, so tool approvals never ask about them.

## API

### Create a session, upload, ask

```http
POST /api/client/v1/agents/sessions
Authorization: Bearer <token>

{ "agent": "support-bot" }
```
```json
{ "id": "6f1c…", "object": "agent.session", "agent": "support-bot", "runtime_status": "idle", … }
```

Upload to it (below), then ask — naming the session, not the files:

```http
POST /api/client/v1/agents/responses

{ "model": "support-bot", "session_id": "6f1c…", "input": "Summarise the contract" }
```

The file goes with that first message, and the user message records it in `attachments`. See [Agent sessions](/guide/agent-sessions) for the session calls.

### Upload

Upload the file as the raw request body, with its MIME type as `Content-Type` and its name in `?name=`:

```http
POST /api/client/v1/agents/sessions/{conversationId}/files?name=contract.pdf
Authorization: Bearer <token>
Content-Type: application/pdf

<bytes>
```

A small file can go as JSON instead: `{ "name": "notes.txt", "content_type": "text/plain", "data": "<base64 or data URL>" }` (`contentType` is accepted too). (A `.json` file goes as `application/octet-stream`; its name still says what it is.)

| Call | |
| --- | --- |
| `POST …/files?name=` | Upload. 201 with the file; 413 too large, 415 type not accepted, 409 too many files, 409 `storage_unavailable` (the agent's bucket cannot take a file now), 429 quota, 403 attachments off or not set up. |
| `GET …/files` | The session's files: `{ "object": "list", "data": [...] }`. |
| `GET …/files/{fileId}/content` | The file's bytes (see below). |
| `DELETE …/files/{fileId}` | Delete one. |

A file, as the client API returns it (the dashboard's calls use `camelCase`):

```json
{
  "id": "6710…", "object": "agent.session.file", "session_id": "6f1c…",
  "name": "contract.pdf", "mime_type": "application/pdf", "size": 183422,
  "conversion_status": "succeeded",
  "bucket_key": "uploads", "path": "agent-sessions/support-bot/6f1c…/contract-1727…-ab12cd34.pdf",
  "created_at": "2026-10-01T12:00:00.000Z", "expires_at": "2026-10-31T12:00:00.000Z",
  "content_url": "/api/client/v1/agents/sessions/6f1c…/files/6710…/content"
}
```

`bucket_key` and `path` say where the file is stored: the bucket in the Document Store and the object's path inside it.

`conversion_status` is `succeeded` when the text could be read, `pending` while it converts, and `failed` or `skipped` when only the original exists (`conversion_error` says why); the agent then knows the file is there but cannot read it. `{conversationId}` is the id inside `resp_{conversationId}`.

### Read a file

```http
GET /api/client/v1/agents/sessions/{conversationId}/files/{fileId}/content
GET /api/client/v1/agents/sessions/{conversationId}/files/{fileId}/content?variant=markdown
```

Returns the original's bytes with the file's own `Content-Type`, or — with `variant=markdown` — the text the platform converted it to (409 `markdown_unavailable` when there is none, as for a picture). Pictures open in place (`Content-Disposition: inline`); everything else is offered as a download (`attachment`), and `?disposition=inline|attachment` asks for the other where it is safe. SVG, HTML and other types that could run code in a browser are **always** a download. The filename in the header is sanitised, and the response is `Cache-Control: private` with `X-Content-Type-Options: nosniff`. A file of another session is a 404. Studio uses the same route to show thumbnails and open files from a session's messages.

The dashboard has the same four under `/api/agents/{agentId}/sessions/{sessionId}/files`. Uploads count toward the project's file quotas like any other file.

Name the files a message uses in the chat body: `attachments: ["<fileId>", …]` (dashboard `/chat`, `/chat/stream`). The user message then records `attachments: [{ fileId, name, mimeType, size }]`.

### Responses API

`input_file` and `input_image` parts of the last user message are used instead of dropped:

```json
{
  "model": "my-agent",
  "session_id": "6f1c…",
  "input": [{ "role": "user", "content": [
    { "type": "input_text", "text": "Compare these" },
    { "type": "input_file", "file_id": "…" },
    { "type": "input_file", "file_data": "data:application/pdf;base64,…", "filename": "a.pdf" },
    { "type": "input_image", "image_url": "data:image/png;base64,…" },
    { "type": "input_image", "image_url": "https://example.com/cat.png" }
  ] }]
}
```

- `file_id` is a file already uploaded to the session you continue — with `session_id`, its alias `conversation` (a string or `{ "id": … }`), or `previous_response_id`.
- `file_data` and a `data:` image are decoded and uploaded to the session first. An `https` image URL is fetched (private addresses are refused) within the agent's size limit and uploaded, provided the server answers with an `image/*` `Content-Type`; any other answer (JSON, HTML, no type) is refused with `415 unsupported_file_type` and nothing is stored. To give the agent a document, send it as `input_file` instead.
- With `background: true`, the run carries the attachments. For `Idempotency-Key`, only the file ids you named identify the request: a file sent inline is stored under a new id each time.

## Where you see them

An attached file is shown wherever the message is: in the session page, in the **session detail** drawer's request inspector (a thumbnail for a picture, a chip with type icon and size for anything else; one that has expired is a muted *expired* chip) and in Observability traces for requests that carry pictures. They are one component, so they look the same everywhere.

## Cleanup

Files past their retention are removed by the hourly cleanup (object, markdown and record). Deleting a session removes its files at once; one that cannot be removed then is retried by the cleanup when it expires. A file that keeps failing does not hold the cleanup up: each sweep goes on to the files behind it. Changing *Keep files for* affects new files only.
