---
layout: home

hero:
  name: Cognipeer Console
  text: Run Multi-Tenant AI Infrastructure Without Rebuilding The Control Plane
  tagline: Operate inference, vector stores, tracing, guardrails, RAG, config, and incident workflows behind one production-ready console with tenant isolation built in.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Study Architecture
      link: /guide/architecture

features:
  - title: OpenAI-Compatible Runtime Surface
    details: Ship chat completions, embeddings, and agent execution behind one gateway instead of stitching together provider-specific entry points by hand.
  - title: Tenant Isolation As A First-Class Constraint
    details: Keep data, credentials, projects, and usage boundaries intact across companies with tenant-aware request context and policy enforcement.
  - title: Core Services Built For Production
    details: Reuse cache, resilience, request context, runtime pooling, health checks, lifecycle management, and observability primitives across the platform.
  - title: Agents, Tools, And MCP In One Control Plane
    details: Manage agents, OpenAPI-backed tools, MCP servers, and prompt assets from the same operational surface used to serve requests.
  - title: Retrieval, Guardrails, And Files Without Glue Code
    details: Combine vector stores, document pipelines, file storage, and validation layers without re-deriving integration patterns for each feature area.
  - title: Docs That Match How Teams Actually Adopt The Stack
    details: Move from setup and architecture into API details and operational modules without losing the structure of the existing documentation tree.
---

## Start Here

If you are evaluating or onboarding Cognipeer Console, this is the shortest useful reading order:

1. [Getting Started](/guide/getting-started) to boot the platform locally.
2. [Architecture](/guide/architecture) to understand the runtime split between UI, API plugins, and core services.
3. [Core Overview](/guide/core-overview) to see how config, logging, cache, resilience, and request context fit together.

If you already know the basics, jump directly to the part that matches your work:

- Building against the gateway surface? Start with [API Overview](/api/overview) and [Authentication](/guide/authentication).
- Extending platform internals? Start with [Core Modules](/guide/core-overview) and [Providers](/guide/providers).
- Operating agent workflows? Start with [Tracing](/guide/tracing), [Guardrails](/guide/guardrails), and [RAG](/guide/rag).

## Choose Your Entry Point

| Start with | Best for | What you get |
| --- | --- | --- |
| Guide | Teams onboarding the platform for the first time | Local setup, architecture, core module docs, and operational guidance |
| API Reference | SDK authors and integrators | Endpoint behavior, request and response models, and OpenAI-compatible surface details |
| Core Modules | Platform engineers extending the runtime | The shared infrastructure primitives that shape behavior across every domain service |

## Quick Start

::: code-group

```bash [npm]
npm install
cp .env.example .env.local
npm run dev
```

```bash [Docker]
docker build -t cognipeer-console .
docker run -p 3000:3000 --env-file .env.local cognipeer-console
```

:::

## Docs Map

- [Guide](/guide/getting-started): setup, architecture, deployment, providers, and feature walkthroughs.
- [Core Modules](/guide/core-overview): config, request context, cache, resilience, runtime pool, health, lifecycle, and CORS.
- [API Reference](/api/overview): gateway endpoints for chat, embeddings, agents, tools, tracing, vector, RAG, files, and health.
- [Contributing](/contributing): development rules, validation steps, and docs workflow notes.

## Production Checklist

- Confirm tenant identity, feature policy checks, and request context propagation are enforced on every new API surface.
- Decide which providers, vector backends, and storage systems must be available in your target environment before onboarding teams.
- Validate health, cache, resilience, and lifecycle behavior up front instead of treating them as optional infrastructure later.
- Map your docs updates to the right guide or API page when new modules or endpoints are introduced.
- Keep docs local verification in the release loop with `npm run docs:build`.

## What This Site Covers

- A platform-level view of Cognipeer Console as a multi-tenant AI control plane rather than a loose collection of feature modules.
- The runtime contracts behind inference, tracing, vector, guardrails, files, prompts, and RAG workflows.
- The shared core infrastructure that keeps request handling, logging, caching, resilience, and shutdown behavior predictable.
- A docs shell aligned with the `agent-sdk` and `chat-ui` surfaces while keeping Cognipeer Console's own information architecture.
