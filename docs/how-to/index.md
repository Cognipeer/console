# How-To

Task-shaped guides. Each page takes one job end to end — the click-path through
the dashboard first, then the same job over the client API, then the things that
will bite you. Pick the row that matches what you are trying to do today.

These pages do not restate reference material. Where a page needs a field
definition, an endpoint contract or a data model, it links into the
[Guide](/guide/getting-started) and the [API reference](/api/overview).

## The guides

| Guide | What you get | You need |
|---|---|---|
| [Connect an OpenAI-compatible client](/how-to/connect-openai-client) | Open WebUI, LiteLLM, Cursor or the official OpenAI SDK talking to Console instead of the upstream provider. | An API token; at least one `llm` model in the Model Hub. |
| [Create your first model](/how-to/first-model) | A provider, a model with real pricing on it, and a first chat completion — about five minutes. | Credentials for one model provider (an OpenAI key, an Azure deployment, a vLLM URL). |
| [Add a guardrail and a PII policy](/how-to/guardrail-and-pii) | An input and output safety policy bound to a model or an agent, plus a reusable PII policy with a test panel. | An LLM model — the content-moderation and prompt-shield checks call one. Nothing else. |
| [Trace an existing agent](/how-to/trace-an-existing-agent) | An agent you already run reporting sessions, turns, tool calls and token counts into Agent Observability, in two lines of code. | An agent already running (LangChain, LangGraph, OpenAI Agents, Claude Agent SDK, Vercel AI, n8n or plain OTLP); an API token with `tracing` access. |
| [Crawl a website into the Knowledge Engine](/how-to/crawl-a-site) | A scheduled crawler that fetches pages, converts them, and feeds a Knowledge Engine module you can retrieve from. | A Knowledge Engine module, which in turn needs an embedding model and a vector index. |
| [Automate a browser task](/how-to/automate-a-browser-task) | A headless browser profile, a driven session, and extract / snapshot / screenshot / PDF output — then the same browser exposed to an agent over MCP. | An API token. A file bucket if you want screenshots and PDFs kept. |
| [Build and publish an agent](/how-to/build-and-publish-an-agent) | An agent with a system prompt, tools or MCP servers, guardrails, a Knowledge Engine attachment, and a published version that `POST /agents/responses` resolves to. | An LLM model. Tools or MCP servers if the agent has to do more than talk. |
| [Optimize token usage](/how-to/optimize-token-usage) | The whole closed loop — instrument, measure, sample real traffic, build an eval, cut tokens, prove quality held. **The long one**; set aside an afternoon. | An agent already in production and traced; enough traffic in the window to sample from. |
| [Build a dataset from production traffic](/how-to/dataset-from-production-traffic) | A PII-safe evaluation dataset sampled from gateway logs or agent traces — or imported from an OpenAI, gateway, Bedrock or Langfuse export. | Traffic in the sampling window; at least one PII category selected, which the wizard enforces. |
| [Route requests with a Dynamic LLM](/how-to/route-with-dynamic-llm) | A Dynamic LLM that sends cheap requests to a cheap model and hard ones to a strong one, by rules or by a decider model. | At least two LLM models to route between. |

Every guide above runs on a community install; none of them require an
Enterprise licence. One sub-feature is the exception: an MCP server whose stdio
package runs in **persistent sandbox execution** is Enterprise-gated and the API
rejects it with HTTP 402 otherwise. The Enterprise-only services — Realtime,
Cluster, GPU Fleet, Agent Sandbox, Aegis and Prompt Optimizer — are out of scope
here; of those, [Agent Sandbox](/guide/sandbox), [Cluster](/guide/cluster) and
[GPU Fleet](/guide/gpu-fleet/overview) have Guide pages.

## Conventions

These hold on every page in this section.

| Convention | Detail |
|---|---|
| Base path | The client API is `https://<your-host>/api/client/v1`. No trailing slash, no second `/v1`. The dashboard's own `/api/*` routes authenticate with a browser session and cannot be driven with a token — scripts always use `/api/client/v1`. |
| Auth | `Authorization: Bearer cpeer_…`. Tokens are minted under **Settings → API Tokens** with **Create Token**; the secret is `cpeer_` followed by 64 hex characters and is displayed once, because only its SHA-256 hash and a 16-character prefix are stored. |
| Project binding | A token is permanently bound to the project that was active when it was created — the project pill in the header, whose menu is headed **Switch project**. Switching project in the UI afterwards does not move the token. One project, one token. |
| Permissions | Access is checked against the *token owner's* permissions, so a token can never do more than the member who created it. Grant that member the service before wondering why a call returns 403. |
| The `model` field | On `/chat/completions`, `/embeddings` and the audio routes, what a client sends as `model` is the model's **key** from the Model Hub, never its display name. The key is the small monospace string under the display name in the **Name** column, and it is what `GET /api/client/v1/models` returns as `data[].id`. Three routes reuse the field for something else: `/moderations` takes a guardrail key, and `/responses` and `/agents/responses` take an agent key. |

## Looking for reference instead?

If you want field definitions, endpoint contracts and data models rather than a
task to follow, go to the [Guide](/guide/getting-started) for per-service
documentation and the [API reference](/api/overview) for the wire format.
