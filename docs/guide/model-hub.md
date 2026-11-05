# Model Hub

The Model Hub is the operational console for every inference endpoint your tenant exposes — chat completions, embeddings, and multimodal models — across all configured providers. It is the only place where you wire a provider credential to a logical model name, set pricing, configure guardrails, and watch live usage.

Each model you publish here becomes addressable through the OpenAI-compatible runtime described in [Model Inference](/guide/inference). The `model` field clients send in `/v1/chat/completions` is matched against the **key** column you see in this UI.

## Overview

The landing page summarises everything deployed in the active project: total endpoints split by category (LLM / Embedding / Multimodal), provider count, recent usage analytics, and per-model status badges.

![Model Hub overview](/screenshots/model-hub/01-model-hub-overview.png)

What to look for on this screen:

- **Total models / LLM / Embedding / Multimodal** counters reflect the active project only. Switch projects from the header pill (top right) to see another scope.
- The **status badge** in the table is a hardcoded "Active" indicator — models do not carry a status field. When a request names a model key the runtime can't resolve, it throws and the call surfaces as an HTTP 500 from `/v1/chat/completions`.
- **Calls, Avg latency, Spend, Pricing** are sourced from the rolling tracing window. The default is "Total" but the date-range picker above the table narrows the report.
- **Browse providers** jumps to the provider list (described below). **Create Model** opens the provider catalog and then the deployment dialog, both described in [Deploy a model](#deploy-a-model).

## Providers

Before you can deploy a model you need at least one provider configuration. Providers carry the credentials (API keys, endpoints, regions) and are scoped to either the tenant or a single project.

![Providers list](/screenshots/model-hub/02-providers.png)

Provider rows show:

- **Type** — `Model` for inference providers, `File` for object storage, `Vector` for vector stores, `Datasource` for ingestion connectors. The Model Hub only consumes `Model` providers; the others power adjacent features but appear in the same list for convenience.
- **Driver** — the contract implementation that backs the configuration (e.g. `openai-compatible`, `local-filesystem`). Multiple configurations can share a driver (typical when the same OpenAI-compatible endpoint is split across departments with different keys).
- **Status** — `active` means the runtime accepts requests for any model attached to this provider. `errored` provider configurations cause all linked models to fail pre-flight.

Use **Add provider** to register a new credential set. The form fields are driven by the provider contract (see [Providers](/guide/providers) for the contract structure), so each driver shows its own credential schema.

## Deploy a model

Clicking **Create Model** on the Model Hub first opens the provider catalog, which lists the models the selected provider serves (see [Add a model from the provider catalog](#add-a-model-from-the-provider-catalog)). Picking a model there, or choosing **Enter custom model**, opens the deployment dialog. Everything required to make a model addressable through the runtime is on a single screen, with a live pre-flight panel on the right.

![Deploy model dialog](/screenshots/model-hub/03-create-model-modal.png)

Fields, top to bottom:

1. **Provider** — choose any active provider whose driver supports the model domain. The summary panel on the right reflects driver, key, and status as soon as you pick one.
2. **Identity**
   - **Display name** (required) — what shows up in the table and in tracing.
   - **Key** (optional) — the value clients pass in the `model` field of API requests. If you leave it blank, the system derives one from the display name.
   - **Model ID** (required) — the provider-side identifier (e.g. `gpt-4o-mini`, `claude-sonnet-4-6`). This is what the runtime forwards upstream after auth and quota checks. While you type, the field suggests the provider's models of the chosen category from the same listing as the catalog; any other value can still be entered. The edit screen offers the same suggestions.
   - **Category** — `LLM` or `Embedding`. Picking Embedding hides chat-only fields below.
3. **Capabilities** — context window, maximum output tokens, input/output modalities, reasoning, structured output, and tool-call support. These values form the model's explicit capability profile and are published by the OpenAI-compatible discovery endpoint; clients do not need to infer features from the alias name.
4. **Pricing & limits** — pricing is captured per 1M tokens with separate input/output/cached buckets. Spend reports in the overview and in tracing both read from these numbers, so keep them in sync with the upstream contract.

The right column gives a **pre-flight checklist** that flips from grey to green as each requirement is met. The **Create model** button only enables when all checks pass.

### Add a model from the provider catalog

**Create Model** opens the **Add model** catalog: the models the selected provider can serve, asked from the provider itself, so the model ID, a display name, the category, the limits and, where known, the price come from the provider instead of being typed in by hand.

The catalog opens on the provider you came from: one you just added, or the provider named by `?addModelsFor=<key>`. Otherwise it opens on the first active provider of the project. The **Provider** picker lists every model provider of the project, and disabled providers cannot be picked. A project without model providers shows **Add provider** instead.

#### Where the list comes from

| Driver | Listed from |
|---|---|
| `openai` | Live: the provider's `GET /v1/models`. |
| `openai-compatible` | Live: `GET <base URL>/models`. Whatever extra details the server sends are read too: prices (OpenRouter, Together), context windows (OpenRouter, Groq, Mistral, Together, vLLM) and capability flags (OpenRouter, Mistral). A server without that route (404, 405 or 501) has no list. |
| `together` | Live: Together's model list, with Together's own prices. |
| `anthropic` | Live: `GET /v1/models` of the configured base URL, following pages. An endpoint without the route (404) has no list. |
| `azure` | Live: the deployments of the Azure OpenAI resource. The entry is the deployment name, shown with the model it serves. When Azure does not list deployments (400 or 404; newer API versions removed the route), only the deployment configured on the provider is offered. |
| `bedrock` | Live: the region's foundation models that can be called on demand, plus the system-defined cross-region inference profiles, signed with the provider's AWS credentials. Legacy models are marked **Deprecated**. |
| `cohere` | Live: the models with a rerank endpoint. A built-in list is shown when the call fails or returns nothing. |
| `mistral-ocr` | Live: the OCR models of the Mistral API. A built-in list is shown when the call fails or returns nothing. |
| `azure-document-intelligence` | Live: the document models of the resource. The prebuilt models are shown when the call fails or returns nothing. |
| `vertex` | Reference catalog: the Vertex AI chat and embedding models of the market price feed, since Vertex has no list route the console can call with the provider's key. A built-in list is shown when the feed cannot be loaded. |
| `google-document-ai` | The processor configured on the provider. |
| `jina-ai`, `voyage-ai`, `alibaba-modelstudio`, `typesafe`, `aws-textract` | A built-in list, since these APIs have no list route. |

The line under the provider says which it is: **Live from *provider* · listed *time***, **From the reference catalog**, or **Built-in list**.

A live listing is made in real time with the credentials stored on the provider, under the same outbound rules as **Test connection**: the endpoint policy of the gateway applies, redirects are not followed, and a request stops after 15 seconds (the whole listing after about 20). The dashboard keeps a listing for five minutes, so the catalog and the **Model ID** suggestions of the create and edit forms share one call. **List again** (the refresh button next to the source line) asks the provider again.

Only models the driver can serve under one of its categories are listed. Realtime, video and legacy completion models, for example, are left out, and a notice says how many. A listing holds at most 2,000 models.

#### Reading a row

Each row shows the name, the model ID, the category and, when known: the context window, whether the model accepts images, calls tools or reasons, the price per 1M input and output tokens, **Deprecated** when the provider marks the model as legacy, and **Added** when the project already has it.

- **Prices.** A price the provider lists itself (OpenRouter, Together) wins. Otherwise the price comes from the market reference catalog, the same feed as **Fill from catalog**, together with limits and capability flags the provider did not send. An approximate reference match is shown with `≈` and never filled in for you. The reference catalog is waited for at most 2.5 seconds; when it is not ready, a notice says some prices and limits may be missing.
- **Filters.** Search by name or model ID, narrow by category (only categories present in the listing are offered, with counts), and switch on **Hide already added**. At most 300 rows are rendered; refine the search to reach the rest.
- **Added.** A model of the project that already uses this provider and model ID is marked **Added**, and hovering shows its keys. Its checkbox is off, so the same model is not added twice by accident. **Configure** on the row still opens the create form to add a second copy on purpose, for example with other defaults.

#### Pick one, several, or enter your own

- **One model.** Select it and choose **Continue**, or use **Configure** on its row. The create form opens filled in with the model ID, a display name, the category, the context window and maximum output, the tool, vision, reasoning and structured-output flags, and the price when it is the provider's own or an exact or normalized reference match. Review it and choose **Create model**. **Back to catalog** returns to the list.
- **Several models.** Select them and choose **Add *N* models**. The confirmation says how many have no known price: those are created with 0 prices, and their usage is recorded at no cost until you set one (see *Pricing defaults to zero* in [Create your first model](/how-to/first-model)). The models are then created one after another with the default settings, each with a key generated from its name, and a notification reports how many were added and the first error, if any.
- **Enter custom model.** This opens the empty create form with the provider preselected. Use it for a fine-tune, a private deployment, a model the list does not show, or a provider without a list.

#### When the provider cannot list

When a listing fails, the catalog says why: the provider refused the credentials, could not be reached, did not answer in time, or returned an error; the gateway's outbound network policy does not allow its address; the stored credentials could not be read; or the provider settings are incomplete. It then offers **Try again** and **Enter a model manually**. The detail line never contains a credential value or the provider's response body. When the provider has no list at all, such as an OpenAI-compatible server without `/models`, the catalog says so and offers **Enter a model manually**. A model entered by hand works exactly like one picked from the list.

#### Permissions

Listing a provider's models needs **Write** on the `models` service, although it only reads: each listing spends the provider's stored credentials on a call to the provider, and only the create and edit flows use it. A member with **Read** only is refused with `403`. The dashboard calls `GET /api/models/providers/{providerKey}/catalog`. A provider outside the active project answers `404`, and a disabled provider answers `409` with `code: "provider_disabled"`. A listing that the provider refused is still a `200`, with the reason in the catalog's `error`.

## Inspecting a model

Clicking a row from the overview opens the model's detail screen. This is the surface engineers use most often when something looks off in production: it combines the operational view (latency, error rate, recent calls) with everything required to reproduce a request.

![Model detail page](/screenshots/model-hub/04-model-detail.png)

The page is organised in tabs:

- **Overview** (shown above) — performance over the chosen window, a ready-to-paste `curl` against the local runtime, recent requests, and the static metadata panel on the right (pricing, settings, status, timestamps).
- **Playground** — a chat sandbox bound to this model. The system prompt and runtime settings come from the model definition, so the playground exactly mirrors what production traffic experiences.
- **Configure** — read-only access to the underlying definition with edit-in-place affordances for the fields that don't require a redeploy (description, key, status, pricing).
- **Logs** — request-level entries with prompts, completions, token usage, and tool calls. Streams from the same store as [Agent Tracing](/guide/tracing). Each entry is `success`, `error`, or `cancelled`. **Cancelled** is a streamed call whose client disconnected before the answer finished — a user pressing stop, a closed tab, a request timing out on the caller's side. It is deliberately neither of the other two: it does not count towards the error rate, because nothing failed on our side or the provider's, and it does not count as a success, because the answer was never delivered. The output tokens generated up to that point are still recorded and billed — the provider charges for them — but when the provider never reported a count (it rides on the terminal chunk the client did not wait for) the figure is estimated from the streamed text and the log entry is marked `output_tokens_estimated`.
- **Usage** — aggregated cost and call counts grouped by token, API token, and time bucket.

The `Endpoint` panel exposes the canonical `curl` snippet:

```bash
curl -X POST http://localhost:3000/api/client/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

`YOUR_API_TOKEN` comes from the **API Tokens** screen. Tokens are tenant-scoped and inherit the requesting member's project permissions.

## Editing a model

Use the `…` menu on a row or **Configure → Edit** inside the detail page to reach the edit screen. The fields mirror the create dialog but apply changes in-place — no need to delete and recreate.

![Edit model](/screenshots/model-hub/05-model-edit.png)

Common edits:

- **Pricing** — when the upstream provider updates rates, edit here so spend reports stay accurate.
- **Status** — flip to `inactive` to immediately stop accepting traffic for a model without removing the definition (useful during incident response).
- **Settings** — adjust `temperature`, `maxTokens`, and provider-specific runtime defaults. These apply when clients don't override them in the request body.
- **Guardrails** — bind input and/or output guardrail keys defined in the [Guardrails](/guide/guardrails) module.

Changes apply on save. There is no separate publish step.

### Public alias and canonical model ID

Keep these identities separate:

- **Key** is the stable public alias returned as `data[].id` by `GET /api/client/v1/models`. Renaming it is an API contract change for clients.
- **Model ID** is the canonical provider-facing identifier. Console sends it upstream and publishes it as `cognipeer.canonical_model_id` for metadata correlation.

Multiple public aliases may intentionally point to the same provider model with different settings, pricing, guardrails, or routing behavior. Discovery therefore never replaces the public key with the provider model ID.

### Upstream API (OpenAI-schema models)

Models served by the `openai`, `azure`, `openai-compatible` and `together` drivers have an **Upstream API** setting in the create and edit screens, and on the model detail page. It decides which OpenAI endpoint Console calls for that model:

| Value | Endpoint | When to use it |
| --- | --- | --- |
| **Chat Completions** (default) | `/chat/completions` | Every OpenAI-compatible server, and any model that does not need anything else. |
| **Responses** | `/responses` | Models that are only served on the Responses API, or when you want the upstream's reasoning summaries. The upstream must implement the Responses API. |

Things to know:

- **It is always your choice.** Console never switches APIs on its own, and it does not look at the model id. A model id that is "Responses-first" still uses Chat Completions until you pick Responses.
- **Clients are not affected.** The gateway endpoints (`/chat/completions`, `/messages`) keep answering in the format the client asked for. A chat-completions client talking to a model whose upstream API is Responses still gets a normal `chat.completion` back, with reasoning text and reasoning-token usage included under the usual rules (see below).
- **Only these drivers.** Saving `Responses` for an Anthropic, Bedrock or Vertex model is rejected with HTTP 400. Those drivers use their own native APIs.
- **Stored as** `settings.upstreamApi` (`"responses"`; absent means Chat Completions). Clearing the field in the edit screen removes the key.
- Streaming works over the Responses API too, including reasoning summaries.

### Reasoning visibility and Claude thinking

Claude 5.x models return their thinking blocks empty unless the request asks for a summary. Console asks for one only when someone will actually see it:

- The reasoning is **visible** when the Model Hub **Return reasoning** switch is on, and the caller has not hidden it: an agent with **Show reasoning** off, or a request that sends `include_reasoning: false`.
- When visible, Console requests summarized thinking from Anthropic and Bedrock Claude models.
- When hidden, Console does not request it, so the model does not spend output tokens writing thought summaries nobody reads. The thinking itself still runs and is billed as usual.
- Thinking tokens reported by the provider are stored as **reasoning tokens** on the usage row (Anthropic, Bedrock and the Responses API).

## How requests resolve

When a client calls `/api/client/v1/chat/completions` with `model: "gpt-4o-mini"`, the runtime resolves the call in this order:

1. Authenticate the API token and resolve the tenant + project.
2. Look up the **key** `gpt-4o-mini` in the active project's Model Hub.
3. If the key cannot be resolved to a model definition, the runtime throws and the request returns HTTP 500.
4. Pull the linked provider configuration, decrypt credentials, and instantiate the provider runtime (see [Providers](/guide/providers)).
5. Apply input guardrails, forward the request using the model's `modelId`, then apply output guardrails before responding.
6. Persist tracing and usage records, including the pricing snapshot from the model definition.

Every step is observable through [Agent Tracing](/guide/tracing). If a request fails, the trace points to the exact step that rejected it.

## Where to go next

- [Model Inference](/guide/inference) — the request/response shape for chat and embedding endpoints.
- [Providers](/guide/providers) — provider contract structure and how to add new drivers.
- [Guardrails](/guide/guardrails) — input/output filters you can attach per model.
- [Agent Tracing](/guide/tracing) — query and inspect the per-request records the runtime writes for every Model Hub call.
