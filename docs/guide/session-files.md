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
| Largest file (MB) | 20 | Larger uploads are refused (413). The platform's `FILE_UPLOAD_MAX_MB` is the ceiling. A picture is also held to *Picture bytes per model request* below: one bigger than a whole request could never be shown to the model, so it is refused (413) when it arrives. |
| Allowed file types | any | MIME types; `image/*` works. |
| Put in the message up to (tokens) | 30000 | See below. Estimated as characters / 4. |
| Page size when reading (characters) | 20000 | Size of a page of `session_files_read`. |
| Keep files for (days) | 30 | The file is deleted this long after upload. |
| Attach new uploads to the next message | on | Files uploaded to a session that no message has carried yet go with the next message. |
| Pictures per model request | 6 | How many images one request to the model carries. The newest win; an older one becomes a note that names it (the agent can look again, see below). |
| Picture bytes per model request | 12000000 | The same limit in bytes (before base64), oldest dropped first. Providers set their own per-image caps (Anthropic's is 5 MB), so set this to the smallest cap among the models the agent uses. |
| Show earlier pictures again | 2 | When the agent's own context no longer holds the pictures of your last *N* messages that had one, they are shown again with the next message. 0 = never. |
| Let the agent create files | on when uploads are on and a bucket is set; off otherwise | The agent writes text files for the person with `session_files_create` / `session_files_append`, [no sandbox needed](#without-a-sandbox-session-files-create-and-session-files-append). With uploads off it stays off until you turn it on (it needs the bucket). |
| Files per turn / Largest file written (MB) | 10 (at most 20) / 2 (at most 10) | The limits of those files. |

An agent saved before files had a bucket setting, or with files switched on but no bucket, **takes no attachments**: the paperclip is hidden and an upload is refused with `403 attachments_disabled` ("Files are not set up for this agent").

### Where the files are

They are normal Document Store files (**Files** in the sidebar): same drivers (S3 and compatible, or local disk), same markdown conversion, same project file quotas. In the bucket, **Session files** are told apart from the rest, and a session file shows the session it belongs to, when it expires and who uploaded it. Open the bucket's folders to see `agent-sessions/<agent>/<session>/…`.

A bucket an agent keeps session files in **cannot be deleted or disabled** (409) until you choose another bucket for that agent — whether its draft or its *published* version still names it (the version API callers and portals run keeps writing there even after you moved the draft). If the bucket or its provider stops working later, an upload is refused with `409 storage_unavailable`, naming the bucket; the retention cleanup drops the record of an expired file whose bucket is gone for good (and logs `session_file_orphaned` for the object left behind) instead of retrying it every hour. Changing the agent's bucket affects new files only; earlier files stay readable in the bucket they were stored in.

### Who can choose the bucket

Choosing or changing the bucket is a Files decision about **that bucket**: the person needs write access to it (`file-bucket.update`, by default Write on *Files*; a rule on one bucket applies). The list of buckets to pick from needs **read access to Files** — without it the Files section says so instead of showing an empty list — and shows only the buckets the person may look at (`file-bucket.get`); a bucket they may see but not name is shown disabled with the reason. Saving the agent with the bucket it already has asks nothing of Files. An API token is held to the same rules, within its own scope. A refusal answers `403 files_write_required` with a `decisionId` that **Authorization → Access check** can replay; if the permission engine cannot decide, the answer is `503 authorization_unavailable`.

### Who can see a session's files

A session file is the session's: whoever started the session sees and manages its files; anybody else needs *Agent · View others' sessions* (read: list, open, download) or *Agent · Act on others' sessions* (upload, delete) — see [Sessions and approvals](/guide/authorization#sessions-and-approvals). The same holds when the file is reached through the Document Store or the client Files API: a bucket listing leaves out the files of sessions the caller may not view.

Two things to know when you choose: **portal users get the settings of the agent's *published* version**, not the draft, so a new bucket reaches them with the next publish; and a bucket on a **server-disk** provider keeps files on one server's disk — fine for a single node, not for a cluster that scales out.

## What the agent sees

- **Documents.** The file is converted to markdown (the original is kept). If the text of all the files attached to a message is at most the inline limit, it goes in the user turn as `<document name="…" id="…">…</document>` blocks. If not, the turn carries a short note listing the files and their page counts, and the agent reads them with `session_files_read({ fileId, page })`, which returns `{ text, page, pages }`.
- **What was attached.** The attachment block of the turn names **every** attachment, whatever the mix — "The person attached 4 files: 3 documents to read with the tools, 1 image shown below." — also for a message of images only, so the model knows what it was sent even when most of it is in the tools or below as pictures.
- **Images.** Sent to the model as images when the model accepts image input; otherwise the turn says an image was attached that the model cannot read. Only **PNG, JPEG, GIF and WebP** are sent as pictures. Any other `image/*` file (TIFF, SVG, HEIC, BMP, …) is stored like a document with no text: the turn says it was attached and that its format is not supported by the model, and `session_files_read` / `session_files_view_image` say the same — it is never put in a request, where the provider would reject it (and, since pictures come back on later turns, reject every later one too). A chat model accepts images when its **input modalities** say so (Model Hub → the model → input modalities). A model with nothing stored for it is taken to accept images when its id belongs to a known vision family (GPT-4o/4.1/5 and later, o-series except `o1-mini` and `o3-mini`, Claude 3 and later, Gemini, Llama 3.2 Vision and 4, Qwen-VL, Pixtral, Grok vision, Nova, …); a choice you store on the model — including "text only" — always wins over the id. (Models saved by the older forms carry a plain "text only" that was never a choice, written on every save; those are read as "nothing stored" until someone sets the input types again in Model Hub.)
- **Images travel by reference, not as bytes.** In the agent's context, its saved state and its traces a picture is a short reference (`session-file://<fileId>`) behind a text handle — `[Attached image: "cat.png" (id …)]` — that the model can call it by. The bytes are read from the bucket only at the moment the model is called, once per run, within *Pictures per model request* and *Picture bytes per model request*. Three things follow: a photo no longer makes a conversation look full to the agent (its size estimate counts an image as an image, about 850 tokens, not as the characters of its bytes), so it is not compacted away for nothing; the saved state stays small however many pictures a session holds; and a picture survives into later messages and into a replay of the conversation. A picture whose file is gone is replaced by `[Image "…" is no longer available]`.
- **Looking again.** While the session holds an image and the model accepts images, the agent also has `session_files_view_image({ fileId })`: it returns the picture in a message that follows the tool result, for an image the context no longer shows or one that was left out of a crowded request. `session_files_read` on an image points at it.
- **Files nobody has sent yet.** A file uploaded to the session before the first message, or since the last one, goes with the next message — you do not have to name it. That is how "create a session, upload, ask" works from the API. (The agent's *Attach new uploads to the next message* setting turns this off; the files are then only reachable with the two tools below.)
- **Earlier files.** `session_files_list` and `session_files_read` are offered when the session holds a file and the agent takes uploads **or** can write files (both switches are in *Configure → Files*), so a later message can ask about an earlier upload or about a file the agent wrote. These tools only read, so tool approvals never ask about them.

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

A `multipart/form-data` body works too (for a browser form or `curl -F file=@contract.pdf`): the first file part is stored, with its filename and type (a part without a type is stored as `text/plain`: send one, or use `?name=`); `?name=` overrides the name. A small file can go as JSON instead: `{ "name": "notes.txt", "content_type": "text/plain", "data": "<base64 or data URL>" }` (`contentType` is accepted too). (A `.json` file goes as `application/octet-stream`; its name still says what it is.)

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

Returns the original's bytes with the file's own `Content-Type`, or — with `variant=markdown` — the text the platform converted it to (409 `markdown_unavailable` when there is none, as for a picture). Pictures open in place (`Content-Disposition: inline`); everything else is offered as a download (`attachment`), and `?disposition=inline|attachment` asks for the other where it is safe. SVG, HTML and other types that could run code in a browser are **always** a download. The filename in the header is sanitised, and the response is `Cache-Control: private` with `X-Content-Type-Options: nosniff`. A file of another session is a 404. The route takes byte ranges: one `Range: bytes=…` (`a-b`, `a-` or `-n`) is answered `206 Partial Content` with a `Content-Range`, a range that starts past the end `416`, and several ranges (or another unit) are ignored and the whole file is sent; every answer says `Accept-Ranges: bytes`. Studio uses the same route to show thumbnails and open files from a session's messages.

The dashboard has the same four under `/api/agents/{agentId}/sessions/{sessionId}/files`. Uploads count toward the project's file quotas like any other file.

Name the files a message uses in the chat body: `attachments: ["<fileId>", …]` (dashboard `/chat`, `/chat/stream`). The user message then records `attachments: [{ fileId, name, mimeType, size }]`.

### Responses API

`input_file` and `input_image` parts of the last user message are used instead of dropped. This changes what earlier releases did with them (they were ignored and only the text ran): an agent that takes no attachments now answers a request that carries such a part with `403 attachments_disabled` and runs nothing, rather than answering without the file. Clients that sent these parts by habit should stop sending them, or switch files on for the agent.

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

### Chat completions and A2A

- **Chat completions.** On a call to an agent, `image_url` parts and `file` parts (`file_data`, `file_id`) of the last user message become files of the session, like the Responses parts above (`403` when the agent takes no attachments); a message of only an image is valid.
- **A2A.** The `file` parts of a message (`bytes`, base64, or an `http(s)` `uri`, fetched with the same private-address protection) are stored as session files, on `message/send` and `message/stream`; the agent's card lists the file types it accepts. A `data` part is read as the agent's [inputs](/api/agents#typed-inputs-and-structured-output).

## Where you see them

An attached file is shown wherever the message is: in the session page, in the **session detail** drawer's request inspector (a thumbnail for a picture, a chip with type icon and size for anything else; one that has expired is a muted *expired* chip) and in Observability traces for requests that carry pictures. They are one component, so they look the same everywhere. In a trace of an agent session, a picture the request names by reference (`session-file://…`) is drawn as a thumbnail from the session's content route, under the session's own access check; if the route refuses you or the file is gone (retention, deletion), the picture is shown as a chip with its name instead. A trace that is not an agent session's lists such pictures by name only.

## Files the agent produces

Two ways, and they can be used together: the agent writes a text file with a tool (no sandbox needed), or an agent with a [sandbox](/guide/sandbox) leaves files in `/outputs/`. Either way the files are stored as session files (origin `agent_output`) and delivered on the answer the same way.

### Without a sandbox: `session_files_create` and `session_files_append`

An agent that has an attachments bucket can write text files for the user. The *Let the agent create files* switch in **Configure → Files** turns it on and sets two limits. It is **on by default when the agent takes uploads and a bucket is chosen**. With uploads off, choose a bucket and switch it on yourself: outputs do not need uploads, and stay off until you do.

- **`session_files_create({ filename, content, mime_type? })`** creates a file and returns `{ file_id, filename, mime_type, size_bytes, download_url }`. Allowed types: `.md .csv .txt .json .html .xml .yaml .yml`; the MIME type is derived from the extension, and a `mime_type` that disagrees is refused. The name is sanitized (no directories, no odd characters) and a name already used in the session becomes `name-1.ext`.
- **`session_files_append({ file_id, content })`** adds text to the end of a file this agent created in this session (so a long file can be built in parts). It refuses a file the person uploaded, a file of another session, and any file that is not one of the text types.
- **Limits.** *Files per turn* (default 10, at most 20) and *Largest file* (default 2 MB, at most 10 MB), enforced on save and at run time. The files also go through the same checks an upload does: the project's file quota, total file count and storage limit. They do not count toward the *Max files per session* of the person's uploads.
- **Approvals.** Both tools follow the agent's *per-tool* approval setting when one is set and are otherwise never asked about.
- **Delivery.** A file created or appended to in a turn is attached to that turn's answer, and a file the agent wrote never rides along on the person's next message. The agent's prompt gets a short section naming the tools and the limits.
- **Reading back.** `session_files_list` and `session_files_read` are offered when outputs are on too, so the agent can read a file it wrote earlier.
- **Discovery.** `GET /client/v1/agents/{key}` reports `attachments.outputs`: `{ enabled, max_files_per_turn, max_file_size_mb, types }`, true to the rule above (`enabled` is false while uploads are off and outputs were not turned on).

### With a sandbox: `/outputs/`

An agent with a [sandbox](/guide/sandbox) is told to write the files meant for the user to `/outputs/` (the folder is created on demand). At the end of each turn the platform saves the new or changed files there as session files and attaches them to the answer. The agent needs no preview link to hand a file over.

- **Bucket required.** Outputs are stored in the agent's attachments bucket (the same one uploads use) and follow its *Max file size* and *Keep files for*. The *Accept attachments* switch does not need to be on. Without a bucket nothing is collected and the agent is not told about `/outputs/`.
- **Limits.** At most 20 files per turn; a file over the size limit is skipped with a warning. A file is delivered again only when its size or modification time changes.
- **Never fails the turn.** A file that cannot be saved is logged and listed in the message's `warnings`; the answer is returned as usual.
- **Where you see them.** On the assistant message's `attachments` (each marked `origin: "agent_output"`), and in the file list of the session.
- **API.** The `/responses` body gets an `output_files` array (`id`, `name`, `mime_type`, `size`, `download_url`) and `file_path` annotations (`file_id`, `filename`) on the `output_text`. `download_url` is the session file content route, `/api/client/v1/agents/sessions/{id}/files/{fileId}/content` (relative to the server origin). Both fields are absent when the turn produced no files.
- **Other surfaces.** The same files ride on every way to call the agent, additively and only when there are files:
  - *Chat completions:* `output_files` on the body, `file_path` annotations on `message.annotations`; a streamed reply puts them as `files` on the closing chunk.
  - *A2A:* each file is an extra artifact with a `file` part (`name`, `mimeType`, `uri` = the absolute download URL; fetch it with the same credentials), on `message/send`, `tasks/get` and `tasks/resubscribe`, and, on `message/stream`, as artifact events just before the final status event.
  - *Resumed turns:* a turn that continues after an approval or client-tool answer collects `/outputs/` too.
  - *Event log:* an `agent.output_file` event per file, just before `agent.message`, so a live stream can show the file chip as the turn ends.
  - *History:* `GET /client/v1/agents/sessions/{id}/messages` (`?limit`, `?after=<index>`) lists the transcript; each message's `attachments` give `id`, `name`, `mime_type`, `size`, `origin` (`user_upload` or `agent_output`) and `download_url`, and `output_files` repeats the agent's. A client that reloads a session still shows the files.

## Cleanup

Files past their retention are removed by the hourly cleanup (object, markdown and record). Deleting a session removes its files at once; one that cannot be removed then is retried by the cleanup when it expires. A file that keeps failing does not hold the cleanup up: each sweep goes on to the files behind it. Changing *Keep files for* affects new files only.
