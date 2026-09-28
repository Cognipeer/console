# Security

Security in Cognipeer Console has two parts:

- hardening the running system,
- and handling vulnerabilities responsibly in the public repository.

## Public Vulnerability Reporting

Do not open public GitHub issues for security vulnerabilities.

Use GitHub's private vulnerability reporting flow for the repository when it is enabled. If private reporting is temporarily unavailable, contact the maintainers through private repository-owner channels instead of disclosing details publicly.

The root [SECURITY.md](https://github.com/Cognipeer/console/blob/main/SECURITY.md) file is the canonical policy.

## Default Hardening Expectations

Before you run Cognipeer Console outside local development, do the following:

- set a strong `JWT_SECRET`,
- set `PROVIDER_ENCRYPTION_SECRET` explicitly instead of relying on the JWT fallback,
- keep `.env.local` and runtime secrets out of version control,
- review CORS settings before exposing `/api/client/*` endpoints to browsers,
- use HTTPS and trusted ingress or reverse proxies,
- separate dev, staging, and production credentials.

## Secret Handling

- Commit only `.env.example`.
- Never commit `.env.local`, cloud credentials, API keys, TLS private keys, or provider secrets.
- Avoid logging request or response bodies unless you intentionally accept the sensitivity tradeoff.
- Prefer secret managers or platform-managed secret injection for production deployments.

## Multi-Tenant Safety

Tenant isolation is a core security boundary.

- Always derive tenant identity from trusted auth context.
- Always switch to the correct tenant database before tenant-scoped operations.
- Never accept raw client-supplied tenant identifiers without server-side validation.
- Treat provider credentials and file storage metadata as tenant-scoped assets.

See [Multi-Tenancy](/guide/multi-tenancy) and [Authentication](/guide/authentication).

## Operational Checks

For self-hosted production deployments, verify at minimum:

- `/api/health/live` and `/api/health/ready` probes,
- structured logs without secret leakage,
- backup and restore for SQLite or MongoDB,
- dependency updates and vulnerability scanning,
- explicit incident-response ownership.

## Dependency and Image Remediation

Treat dependency and image remediation as a staged release workflow:

1. **Code dependencies:** Update direct and transitive runtime dependencies within supported version ranges. Verify document conversion, mail delivery, Fastify routes, and affected service contracts.
2. **Production dependency closure:** Keep build and test tooling out of the runner image. Before using a production-only install, move every runtime dependency, including TypeScript runtime tooling and Fastify plugins, into `dependencies`.
3. **Operating-system packages:** Rebuild from a current base image and apply available security package updates after all required OS packages are installed. Revalidate browser and process-launch capabilities.
4. **Runtime tool inventory:** Remove CLI tools from the runner image only after confirming that production workflows do not invoke them directly or indirectly.
5. **Workload separation:** Where browser automation has a materially different dependency footprint, evaluate a separate browser worker image instead of weakening the API image's runtime requirements.
6. **Verification and enforcement:** Rebuild both Community and Enterprise images, scan their immutable local or registry digests, and switch to enforcement only after the approved policy reports no fixable blocking findings. Track vendor-unfixed findings separately; do not hide them through permanent exceptions.

## Public Repo Hygiene

When the repository is public:

- keep CI running on pull requests,
- use dependency update automation,
- keep issue templates and contribution rules visible,
- review deployment files before publishing infrastructure-specific details,
- treat docs as part of the release surface.