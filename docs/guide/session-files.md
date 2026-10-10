# Session files

People can attach documents and images to a session. The agent reads them in the turn, or, when they are long, page by page with two read-only tools. Files belong to one session, live for a set number of days and go when the session is deleted.

## In Studio

The paperclip in the session composer attaches files. Each file appears as a chip with its size; a chip in orange means no text could be extracted from it, so the agent can only see that it exists. Attached files are shown on the message they were sent with. Send the message and the chips go with it.

## Settings

**Configure → Execution → Attachments**, per agent. Every field is optional; an empty field uses the default shown.

| Setting | Default | What it does |
| --- | --- | --- |
| Accept attached files | on | Off: the agent takes no attachments. A connected (external) agent never does. |
| Files per session | 10 | A session holds at most this many files. |
| Largest file (MB) | 20 | Larger uploads are refused (413). The platform's `FILE_UPLOAD_MAX_MB` is the ceiling. |
| Put in the message up to (tokens) | 30000 | See below. Estimated as characters / 4. |
| Page size when reading (characters) | 20000 | Size of a page of `session_files_read`. |
| Keep files for (days) | 30 | The file is deleted this long after upload. |
| Allowed file types | any | Comma-separated MIME types; `image/*` works. |
| Storage bucket | system | Empty: the project's `conversation-files` bucket on the built-in storage, created the first time it is needed. |

An agent saved before this existed accepts attachments with the defaults.

## What the agent sees

- **Documents.** The file is converted to markdown (the original is kept). If the text of all the files attached to a message is at most the inline limit, it goes in the user turn as `<document name="…" id="…">…</document>` blocks. If not, the turn carries a short note listing the files and their page counts, and the agent reads them with `session_files_read({ fileId, page })`, which returns `{ text, page, pages }`.
- **Images.** Sent to the model as images when the model accepts image input (set on the model: its input modalities, or "multimodal"). Otherwise the turn says an image was attached that the model cannot read.
- **Earlier uploads.** `session_files_list` and `session_files_read` are offered whenever the session holds a file, so a later message can ask about an earlier upload. Both only read, so tool approvals never ask about them.

## API

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
| `POST …/files?name=` | Upload. 201 with the file; 413 too large, 415 type not accepted, 409 too many files, 429 quota, 403 attachments off. |
| `GET …/files` | The session's files: `{ "object": "list", "data": [...] }`. |
| `DELETE …/files/{fileId}` | Delete one. |

A file, as the client API returns it (the dashboard's calls use `camelCase`):

```json
{
  "id": "6710…", "object": "agent.session.file", "session_id": "6f1c…",
  "name": "contract.pdf", "mime_type": "application/pdf", "size": 183422,
  "conversion_status": "succeeded",
  "created_at": "2026-10-01T12:00:00.000Z", "expires_at": "2026-10-31T12:00:00.000Z"
}
```

`conversion_status` is `succeeded` when the text could be read, `pending` while it converts, and `failed` or `skipped` when only the original exists (`conversion_error` says why); the agent then knows the file is there but cannot read it. `{conversationId}` is the id inside `resp_{conversationId}`.

The dashboard has the same three under `/api/agents/{agentId}/sessions/{sessionId}/files`. Uploads count toward the project's file quotas like any other file.

Name the files a message uses in the chat body: `attachments: ["<fileId>", …]` (dashboard `/chat`, `/chat/stream`). The user message then records `attachments: [{ fileId, name, mimeType, size }]`.

### Responses API

`input_file` and `input_image` parts of the last user message are used instead of dropped:

```json
{
  "model": "my-agent",
  "previous_response_id": "resp_…",
  "input": [{ "role": "user", "content": [
    { "type": "input_text", "text": "Compare these" },
    { "type": "input_file", "file_id": "…" },
    { "type": "input_file", "file_data": "data:application/pdf;base64,…", "filename": "a.pdf" },
    { "type": "input_image", "image_url": "data:image/png;base64,…" },
    { "type": "input_image", "image_url": "https://example.com/cat.png" }
  ] }]
}
```

- `file_id` is a file already uploaded to the session you continue with `previous_response_id`.
- `file_data` and a `data:` image are decoded and uploaded to the session first. An `https` image URL is fetched (private addresses are refused) within the agent's size limit and uploaded.
- With `background: true`, the run carries the attachments. For `Idempotency-Key`, only the file ids you named identify the request: a file sent inline is stored under a new id each time.

## Cleanup

Files past their retention are removed by the hourly cleanup (object, markdown and record). Deleting a session removes its files at once; one that cannot be removed then is retried by the cleanup when it expires.
