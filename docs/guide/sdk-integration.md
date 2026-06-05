# Using The SDK

Cognipeer Console and the Console SDK solve different layers of the same system.

- **Cognipeer Console** is the platform and control plane: deployment, tenant isolation, API tokens, providers, tracing, prompts, guardrails, RAG, and runtime policy.
- **Console SDK** is the application integration layer: a TypeScript and JavaScript client that talks to the Console client API.

## Which Team Uses Which

| If you are doing... | Start here |
| --- | --- |
| Deploying or operating the platform | Cognipeer Console docs |
| Configuring tenants, providers, prompts, tools, agents, or guardrails | Cognipeer Console docs |
| Writing backend or frontend application code against the API | [Console SDK docs](https://cognipeer.github.io/console-sdk/) |
| Debugging raw HTTP request and response behavior | Console API Reference |

## Recommended Workflow

1. Set up Cognipeer Console locally or in your target environment.
2. Configure providers, models, storage, and any policies you need.
3. Create an API token in the dashboard.
4. Capture the client API base URL for your deployment.
5. Install the [Console SDK](https://cognipeer.github.io/console-sdk/guide/getting-started).
6. Implement application calls with the SDK while using the Console dashboards for observability and operations.

## Responsibilities Split

| Concern | Canonical docs |
| --- | --- |
| Deployment, tenancy, providers, runtime features | Cognipeer Console |
| Endpoint behavior and HTTP payloads | Cognipeer Console |
| TypeScript and JavaScript method signatures | Console SDK |
| Framework integrations and code examples | Console SDK |

That split matters. The same capability should not be documented twice with different ownership.

## Self-Hosted Base URL

When you self-host Console, your SDK should point to the full client API base URL:

```text
https://your-console.example.com/api/client/v1
```

The SDK expects the client API surface, not just the dashboard origin.

## What To Read Next

- [API Reference Overview](/api/overview) for the raw client API surface.
- [Authentication](/guide/authentication) for how Console issues and validates tokens.
- [Console SDK Getting Started](https://cognipeer.github.io/console-sdk/guide/getting-started) for client setup.
- [Console SDK API Mapping](https://cognipeer.github.io/console-sdk/api/console-mapping) to map SDK methods to Console endpoints.