---
layout: home
hero:
  name: Cognipeer Console
  text: Multi-Tenant AI Platform
  tagline: Production-ready platform for LLM inference, vector stores, agent orchestration, RAG, guardrails, and more — with complete tenant isolation.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/Cognipeer/cognipeer-console

features:
  - title: 🏢 Multi-Tenant
    details: Complete data isolation per company with separate databases and license-based feature control.
  - title: 🤖 LLM Gateway
    details: OpenAI-compatible chat completions and embeddings API with provider abstraction and automatic retries.
  - title: 🤝 Agents
    details: Build, version, and deploy AI agents with bound tools, guardrails, and RAG — invoke via OpenAI Responses API.
  - title: 🔧 Tools & MCP
    details: Unified tool system backed by OpenAPI specs or MCP servers, with action-level execution and request logging.
  - title: 🔍 Vector Stores
    details: Manage vector indexes across providers (Pinecone, Qdrant, Weaviate, S3 Vectors) with a unified API.
  - title: 📊 Agent Tracing
    details: Ingest and visualize agent execution traces with batch and streaming modes, async persistence.
  - title: 🛡️ Guardrails
    details: Input/output validation with regex, keyword, and LLM-based evaluators to enforce content policies.
  - title: 📚 RAG Modules
    details: End-to-end retrieval-augmented generation with document ingestion, chunking, and query pipelines.
  - title: ⚙️ Config Management
    details: Centralized secrets and configuration with AES-256-GCM encryption, groups, audit logs, and API access.
  - title: 🚨 Alerts & Incidents
    details: Automated alert evaluation with incident lifecycle management, severity tracking, and notification channels.
  - title: 💾 Caching & Resilience
    details: Built-in cache layer (memory/Redis), retry with exponential back-off, and circuit breaker protection.
  - title: 📈 Observability
    details: Structured logging with request correlation, health checks, Prometheus metrics, and usage tracking.
---

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

## Architecture Overview

Cognipeer Console is built on **Next.js 15** with the App Router, TypeScript, and MongoDB. It serves as the central platform for all AI operations:

```
┌─────────────────────────────────────────────────┐
│                   Clients                        │
│          (SDKs, Agents, Applications)            │
└────────────────┬────────────────────────────────┘
                 │ REST API
┌────────────────▼────────────────────────────────┐
│              Cognipeer Console                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Middleware│ │  CORS    │ │ Request Context  │ │
│  │ (Auth)   │ │          │ │ (AsyncLocalStore)│ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Inference│ │  Vector  │ │  Agent Tracing   │ │
│  │ Service  │ │  Service │ │  Service         │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │   RAG    │ │Guardrails│ │  File Storage    │ │
│  │ Service  │ │ Service  │ │  Service         │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────────────────────────────────────────┤
│  │  Core: Config │ Logger │ Cache │ Resilience  │
│  │  Runtime Pool │ Health │ Lifecycle │ Async   │
│  └──────────────────────────────────────────────┤
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│          LLM / Vector / Storage Providers        │
│   OpenAI, Anthropic, Google, AWS Bedrock, etc.   │
└─────────────────────────────────────────────────┘
```

## Key Capabilities

- **OpenAI-compatible API** — Drop-in replacement for `/v1/chat/completions`, `/v1/embeddings`, and `/v1/responses`
- **Agent orchestration** — Deploy agents with tools, guardrails, RAG modules, and version pinning
- **Unified tool system** — Register OpenAPI specs or MCP servers as tools, execute actions via API
- **MCP protocol support** — Full MCP gateway with SSE transport and JSON-RPC messaging
- **Provider abstraction** — Swap between OpenAI, Anthropic, Google Vertex, AWS Bedrock, and custom models
- **Multi-tenant isolation** — Each company gets a separate database and license tier
- **Config management** — Centralized secrets and configuration with AES-256-GCM encryption and audit trails
- **Alerts & incidents** — Rule-based alert evaluation with automated incident lifecycle management
- **Production infrastructure** — Retry, circuit breaker, caching, structured logging, health checks
- **Async-first design** — Usage logging and tracing persist asynchronously without blocking responses
- **Kubernetes-ready** — Dockerfile, Helm charts, and graceful shutdown support included
