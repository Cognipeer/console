# Connect an OpenAI-compatible client

Console speaks the OpenAI wire protocol. Anything that lets you set a base URL
and an API key — Open WebUI, LiteLLM, Cursor, the official `openai` SDKs — can
call your models through Console instead of calling a provider directly. The
traffic then picks up project scoping, guardrails, usage accounting and spend
attribution on the way through.

This page goes from a fresh tenant to a working client: pick the project, read a
model key, mint a token, verify with `curl`, then point the client at it. The
gateway is a community feature; no Enterprise licence is involved.

## What you end up with

Three values. Every client on this page wants the same three.

| Setting | Value |
|---|---|
| Base URL | `https://<your-console-host>/api/client/v1` — no trailing slash, no extra `/v1`, not `/api/v1` |
| API key | a Console API token: `cpeer_` followed by 64 hex characters |
| Model name | the model's **key** from Model Hub — not its display name, not the provider's model id |

The token carries the tenant *and* the project. Neither is ever read from the
request body, so a client that is configured once keeps talking to the same
project until you replace the token.

## Prerequisites

- A Console account with the role `owner`, `admin`, `project_admin` or `user` —
  those four roles may mint tokens.
- At least one model of category `llm` in the target project. If you have none,
  work through [Create your first model](/how-to/first-model) first.
- The token owner needs Model Hub `read` **and** `write`: listing models is a
  `GET` (`read`), and a chat completion is a `POST` (`write`). RBAC is evaluated
  against the user who created the token. See
  [Authentication](/guide/authentication) for the role table.

## Step 1 — Select the project

The token you are about to create is bound to whichever project is active in the
browser at that moment, permanently. Set it first.

The project selector sits in the top bar and shows the active project's name;
its menu is headed **Switch project**.

## Step 2 — Read the model key

Open **Model Hub** (`/dashboard/models`). The sub-nav has an **LLM** filter if
the list is long.

In the **Name** column, each row shows the display name in bold with a small
monospace string underneath. That string is the model key, and it is the only
value `model` accepts.

![Model Hub with model keys visible under each display name](/screenshots/how-to/connect/02-model-hub-keys.png)

Look at the **Name** column: "Support Assistant — Mini" is the display name,
`chat-mini` underneath it is the key you send as `model`. The **Type** column
shows the category — you want `llm` rows for chat completions.

## Step 3 — Create the API token

Open the account menu in the top bar and choose **Settings**. In the left nav
under **Settings**, choose **API Tokens** (`/dashboard/tokens`, page eyebrow
"Configure · API Tokens").

![The API Tokens screen with the Create Token button](/screenshots/how-to/connect/01-api-tokens.png)

Look at the top right of the grid for the **Create Token** button, and at the
grid rows: each shows the label with a truncated `cpeer_…` prefix underneath.
Only a SHA-256 hash and that 16-character prefix are stored — the full secret is
not recoverable from this screen.

1. Select **Create Token**.
2. Fill in **Token Label** — minimum 3 characters. Name it after the client
   ("Open WebUI", "LiteLLM prod"). The grid shows only **Label**, **Created** and
   **Last Used**, so the label is the only thing that tells one token from
   another once the secret is gone.
3. Select **Create Token** in the footer.
4. The panel switches to **Your New API Token**. Under the orange **Important!**
   alert, **Your API Token:** holds the secret. Copy it now — the alert is
   literal: `This is the only time you'll see this token. Make sure to copy it
   now!`
5. Select **I've Copied My Token**.

Deleting a token here is immediate in the database but not instant on the wire —
see the gotchas below.

## Step 4 — Verify from a shell

Before touching a client, prove the three values work. Replace the host and the
token.

```bash
export COGNIPEER_BASE_URL="https://console.example.com/api/client/v1"
export COGNIPEER_API_KEY="cpeer_..."

curl -s "$COGNIPEER_BASE_URL/models" \
  -H "Authorization: Bearer $COGNIPEER_API_KEY" | jq '.data'
```

The response carries both an OpenAI-shaped list and Console's own richer list:

```json
{
  "object": "list",
  "data": [
    { "id": "chat-mini", "object": "model", "created": 1755216000, "owned_by": "my-provider" }
  ],
  "models": [ { "key": "chat-mini", "name": "Support Assistant — Mini", "category": "llm", "…": "…" } ]
}
```

`data[].id` is the model key. `owned_by` is the provider key, or `cognipeer`
when the model has no provider. OpenAI clients read `data` and ignore `models`;
`models` carries the full Console model record, with any provider credentials in
`settings` masked.

`GET /models` returns **every** category — embeddings, rerankers, STT, TTS and
OCR models sit in the same list. Narrow it with a query parameter when you are
driving it yourself:

```bash
curl -s "$COGNIPEER_BASE_URL/models?category=llm" \
  -H "Authorization: Bearer $COGNIPEER_API_KEY" | jq -r '.data[].id'
```

Then send a completion:

```bash
curl -s "$COGNIPEER_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $COGNIPEER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chat-mini",
    "messages": [{ "role": "user", "content": "Say hello in one sentence." }]
  }'
```

The non-streaming response is a standard `chat.completion` object plus one
non-standard top-level field, `request_id`. Keep it: it is the correlation key
for the request in Console's logs.

Streaming is server-sent events terminated by `data: [DONE]`, with
`X-Request-Id` on the response headers:

```bash
curl -N "$COGNIPEER_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $COGNIPEER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chat-mini",
    "stream": true,
    "messages": [{ "role": "user", "content": "Count to five." }]
  }'
```

If all three calls work, every client below is a configuration exercise.

## Step 5 — Point a client at it

### Python — official `openai` SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://console.example.com/api/client/v1",
    api_key="cpeer_...",
)

resp = client.chat.completions.create(
    model="chat-mini",                     # the Model Hub key
    messages=[{"role": "user", "content": "Say hello in one sentence."}],
)
print(resp.choices[0].message.content)

# Streaming. Guard on `choices` — the terminal usage frame carries an empty
# `choices` array, exactly as OpenAI's own stream does.
for chunk in client.chat.completions.create(
    model="chat-mini",
    messages=[{"role": "user", "content": "Count to five."}],
    stream=True,
):
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

### JavaScript / TypeScript — official `openai` SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://console.example.com/api/client/v1',
  apiKey: process.env.COGNIPEER_API_KEY,
});

const resp = await client.chat.completions.create({
  model: 'chat-mini',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
});
console.log(resp.choices[0].message.content);
```

For Console-specific features beyond the OpenAI surface — RAG modules, web
search, agents — use the [Console SDK](/guide/sdk-integration) rather than the
`openai` package.

### LiteLLM

Console is an `openai/`-prefixed provider to LiteLLM. Map each Console model
key to whatever public name you want your callers to use.

```yaml
# config.yaml
model_list:
  - model_name: gpt-4o-mini                      # the name your callers send
    litellm_params:
      model: openai/chat-mini                    # openai/<Console model key>
      api_base: https://console.example.com/api/client/v1
      api_key: os.environ/COGNIPEER_API_KEY

  - model_name: text-embedding-3-small
    litellm_params:
      model: openai/embed-demo
      api_base: https://console.example.com/api/client/v1
      api_key: os.environ/COGNIPEER_API_KEY
```

```bash
export COGNIPEER_API_KEY="cpeer_..."
litellm --config config.yaml
```

Declare models explicitly rather than relying on model discovery — that keeps
non-chat categories out of your chat namespace, which is the failure mode
described under [Gotchas](#gotchas).

### Open WebUI

Open WebUI can be configured at start-up or through its admin screens. Both do
the same thing.

At start-up:

```bash
docker run -d -p 3000:8080 \
  -e OPENAI_API_BASE_URL="https://console.example.com/api/client/v1" \
  -e OPENAI_API_KEY="cpeer_..." \
  -v open-webui:/app/backend/data \
  --name open-webui --restart always \
  ghcr.io/open-webui/open-webui:main
```

Through the UI — the labels below belong to **Open WebUI's own admin interface**,
not Console's, and Open WebUI has moved them between releases; if a name does
not match your build, look for the equivalent section:

1. **Admin Panel → Settings → Connections**, in the **OpenAI API** section, add
   a connection.
2. **API Base URL** = `https://console.example.com/api/client/v1`. No trailing
   slash and no extra `/v1`.
3. **API Key** = the `cpeer_` token.
4. Use the connection's verify control to confirm Open WebUI can reach `/models`,
   then save and reload the page.
5. **Admin Panel → Settings → Models** — hide every entry that is not an LLM.
   Console returns the whole model catalogue and Open WebUI lists all of it; an
   embedding or TTS model left visible will fail the moment a user picks it.
6. Optional: point **Admin Panel → Settings → Documents** (embeddings) and
   **Admin Panel → Settings → Audio** (speech-to-text and text-to-speech) at the
   same base URL and key, choosing the Console keys of your `embedding`, `stt`
   and `tts` models. Those hit [`/embeddings`](/api/embeddings) and
   [`/audio/transcriptions`, `/audio/translations`, `/audio/speech`](/api/audio)
   respectively.

## Gotchas

::: warning Read these before filing a bug
- **`/models` returns every category.** Embedding, rerank, STT, TTS and OCR
  models appear alongside LLMs. Selecting one for chat returns HTTP **500** with
  `Model is not configured for chat completions`. Hide non-LLM entries in the
  client, or filter with `?category=llm` when you drive the endpoint yourself.
- **An unknown model key is a 500, not a 404.** The body is
  `{"error":{"message":"Model with key <key> not found","type":"server_error"}}`.
  A typo in the model name looks like a server fault. Check the key against
  `GET /models` first.
- **The `Bearer` prefix is case-sensitive.** The edge check matches `Bearer `
  exactly; `bearer cpeer_…` returns **401** before the token is ever looked up.
  The message is `Missing or invalid Authorization header. Use: Bearer <token>`.
- **Parameters outside the forwarded set are dropped.** The gateway forwards a
  fixed set of request parameters; anything outside it is discarded unless the
  model has **Forward unrecognised caller parameters** enabled
  (`settings.allowUnknownPassthrough`, off by default). Dropped by default:
  `n`, `logit_bias`, `user`, `logprobs`.
- **`usage` only rides on a stream when you ask for it.** Send
  `stream_options: {"include_usage": true}` and the counts arrive on a final
  `{"choices": [], "usage": {…}}` frame, as OpenAI specifies. Without it, no
  frame carries `usage` — billing and quota are still accounted for
  server-side. A model that lists `stream_options` under **Also reject these**,
  or has it auto-detected as unsupported, suppresses the frame, and client-side
  token counters then read zero.
- **Streaming stays on when your request carries `tools`.** If an upstream
  genuinely cannot stream tool calls, set `disableStreamingWithTools: true` in
  that model's **Settings** JSON; the gateway then answers a streamed
  tool-carrying request in a single frame for that model only.
- **Token authentication is cached for 60 seconds.** A deleted or newly
  permission-changed token can keep working for up to a minute. Expiry is
  re-checked on every request and is not subject to the cache.
- **There is no legacy `/completions` endpoint.** Only `/chat/completions`.
  Clients that fall back to the text-completion API will 404.
- **`/api/models/v1` is a dead prefix.** It appears in some older material. It
  is allowlisted but nothing serves it. The base URL is `/api/client/v1`.
- **A token is bound to one project.** It was fixed at creation time from the
  active project and cannot be repointed. A client that needs a second project
  needs a second token.
- **Upstream 4xx responses keep their real status.** A provider rejecting a
  parameter reaches your client as a 400, not a masked 500, so a permanent
  failure stops looking like a transient one. Retry on 429 and on 5xx; do not
  retry the other 4xx codes. Console does not currently set a `Retry-After`
  header on 429s, so use your client's own backoff rather than waiting for one.
- **A blocked guardrail returns HTTP 400** with a non-standard body:
  `{"error":{"type":"guardrail_block","message":…,"action":…,"findings":[…],"guardrail_key":…}}`.
  Generic OpenAI clients will surface it as an opaque bad request. See
  [Guardrails](/guide/guardrails).
:::

## Where to go next

- [Chat Completions API](/api/chat-completions) and [Embeddings
  API](/api/embeddings) for the full request and response reference.
- [Model Inference](/guide/inference) for how a request is resolved, retried and
  priced.
- [Model Hub](/guide/model-hub) for the model list, detail tabs and runtime
  settings.
- [Authentication](/guide/authentication) for the token format and user roles.
- [API Reference Overview](/api/overview) for everything outside the
  OpenAI-compatible surface.
