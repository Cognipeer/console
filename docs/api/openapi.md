# OpenAPI Specification

The complete **Client API** surface — every endpoint under `/api/client/v1` that an API token can call — is published as a machine-readable [OpenAPI 3.0](https://spec.openapis.org/oas/v3.0.3) document.

Use it to generate typed SDK clients, import the API into Postman/Insomnia, drive contract tests, or explore endpoints in an interactive viewer.

<div class="tip custom-block" style="padding-top: 8px">

**Download:** [openapi.yaml](/openapi.yaml)

</div>

## What it covers

The specification documents the **end-user Client API** only — the token-authenticated surface described throughout this API reference (chat, embeddings, audio, OCR, batches, agents, tools, MCP, browser, crawler, vector, files, memory, prompts, Knowledge Engine, guardrails, PII, reranker, evaluation, tracing, and more). It also includes the **Enterprise** client endpoints (realtime, sandbox + toolbox, MCP hubs, Aegis), which are only available on licensed deployments and otherwise return `403`.

It does **not** cover the JWT/session-authenticated dashboard (internal) API. Some endpoints are gated by license tier and return `403` when the feature is not enabled — see the individual reference pages for details.

- **Base URL:** `https://your-gateway.example.com/api/client/v1`
- **Auth:** `Authorization: Bearer cpeer_...` (create tokens under **Settings → API Tokens**)
- **Version:** the `info.version` field in the document tracks the spec revision.

## Explore interactively

The spec is served next to these docs at `<docs-origin>/openapi.yaml`. Paste that URL into a live viewer to browse it interactively:

- [Swagger Editor](https://editor.swagger.io/) → **File → Import URL**
- [Redocly viewer](https://redocly.github.io/redoc/) → paste the URL

For example, on the hosted documentation the spec URL is the site origin followed by `/openapi.yaml`.

## Generate a client

Replace `<docs-origin>` with the origin serving these docs (the spec lives at `<docs-origin>/openapi.yaml`).

::: code-group

```bash [openapi-generator]
openapi-generator-cli generate \
  -i <docs-origin>/openapi.yaml \
  -g typescript-fetch \
  -o ./cognipeer-client
```

```bash [oazapfts]
npx oazapfts \
  <docs-origin>/openapi.yaml \
  cognipeer-client.ts
```

```bash [curl (download)]
curl -sSL <docs-origin>/openapi.yaml -o openapi.yaml
```

:::

For TypeScript/JavaScript projects, prefer the official [Cognipeer Console SDK](https://cognipeer.github.io/console-sdk/) over generated clients — it tracks the Client API and adds framework helpers. See [Using the SDK](/guide/sdk-integration).

## Endpoint map

For a human-readable index of every domain and its base paths, see the [API Reference Overview](./overview). Each domain then has its own page with request/response details and examples.
