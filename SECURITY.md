# Security Policy

## Reporting A Vulnerability

Please do **not** open a public GitHub issue for suspected security vulnerabilities.

Use GitHub private vulnerability reporting for this repository when available. If private reporting is not available at the time of disclosure, contact the maintainers through private repository-owner channels and include:

- a clear description of the issue,
- the affected version or commit,
- reproduction steps or proof of concept,
- impact assessment,
- any proposed mitigation.

## Response Expectations

The project aims to:

- acknowledge a credible report within 5 business days,
- reproduce and assess severity as quickly as practical,
- prepare a fix or mitigation before public disclosure when possible,
- credit reporters who want attribution after the issue is resolved.

## Scope

This policy covers:

- source code in this repository,
- default deployment artifacts published with the repository,
- documented public API surfaces and operational endpoints.

Out of scope unless explicitly tied to this repository:

- third-party hosted infrastructure not operated from this codebase,
- speculative reports without a reproducible impact path,
- issues that depend on compromised credentials or local administrator access without an additional vulnerability.

## Known Dependency Vulnerabilities

The following have been reviewed by the maintainers and are tracked here for transparency. This section lists only outstanding items — accepted risks and surfaces under active monitoring. Resolved issues are removed once their fix has landed.

### `xls-reader` — server-side legacy `.xls` parsing, memory-amplification DoS surface (no published advisory) — Accepted risk / monitor

- **Advisories**: None published. This entry is a proactive supply-chain and robustness note, not a CVE; `xls-reader` does not appear in `npm audit` output.
- **Severity**: Not scored (no advisory). Reviewed impact is denial of service, not remote code execution.
- **Dependency chain**: `@cognipeer/to-markdown@3.3.0` → `xls-reader@^0.7.0` (resolved 0.7.0). Also declared directly in the root `package.json`, so it is both a direct and a transitive dependency.
- **Upstream fix available**: N/A — no advisory to fix. `0.7.0` is the current latest.
- **Impact assessment**: Server-side spreadsheet parsing was **transferred** from `xlsx` to `exceljs` + `xls-reader`, not eliminated. `@cognipeer/to-markdown` is invoked server-side from the crawler (`src/lib/services/crawler/engine/markdown.ts`, on content the crawler downloads from remote URLs), from RAG ingestion (`src/lib/services/rag/ragService.ts`), and from file uploads (`src/lib/services/files/fileService.ts`). Within `to-markdown`, the spreadsheet converter dispatches on the **buffer's OLE2/CFB magic bytes** (`d0 cf 11 e0 a1 b1 1a e1`), explicitly so that mislabelled files are still handled — therefore a file advertised as an OOXML spreadsheet, but whose bytes are a compound-binary blob, is routed to `xls-reader`. The residual concern found by source review is in `readChainBytes`, which allocates `new Uint8Array(chain.length * sectorSize)` sized by the sector chain rather than by the declared stream size. `followChain` and the DIFAT walk in `collectFatSectorIds` are both cycle-guarded by a `seen` set, but the collected **FAT sector ids are not de-duplicated**, so a crafted header can inflate the FAT and hence the chain length, driving an allocation disproportionate to the input file size. Worst case is memory exhaustion / process termination (DoS); there is no code-execution or data-exfiltration path, and the parser has no network or filesystem access.
- **Mitigation**: Accepted and monitored rather than resolved, on the balance that `xls-reader` has **zero runtime dependencies**, is MIT licensed, and ships verified npm provenance (SLSA v1 attestation, Rekor `logIndex` 2208344690), and that a full read of its compound-file implementation found no memory-unsafe or injection-style pattern. Countervailing factors are that it is pre-1.0 (`0.7.0`, published 2026-07-20, 10 releases since 2026-07-06) with a single maintainer (`zanlucathiago`), so it carries normal early-stage supply-chain risk. Uploads remain size-capped via `FILE_UPLOAD_MAX_MB`, which bounds but does not eliminate the amplification. **Note that `FILE_UPLOAD_ALLOWED_MIME_TYPES` is not an effective control here**, because dispatch is by content signature rather than by MIME type or extension; operators who need to exclude legacy `.xls` handling must do so upstream of conversion. Operators running the crawler against untrusted origins should treat spreadsheet conversion as untrusted-input processing and constrain worker memory accordingly.
- **Pre-existing status**: This surface exists on `main` today via `@cognipeer/to-markdown@3.3.0`. It is documented here because server-side spreadsheet parsing was **transferred** from `xlsx` to `exceljs` + `xls-reader` rather than eliminated — removing the `xlsx` package from this repository did not remove server-side spreadsheet handling.
- **Last reviewed**: 2026-08-28

### `vitepress` → `vite` → `esbuild` — development-only toolchain advisories (high / moderate) — Accepted risk

- **Advisories**: https://github.com/advisories/GHSA-4w7w-66w2-5vf9 (`vite` — path traversal in optimized deps `.map` handling), https://github.com/advisories/GHSA-fx2h-pf6j-xcff (`vite` — `server.fs.deny` bypass on Windows alternate paths), https://github.com/advisories/GHSA-v6wh-96g9-6wx3 (`launch-editor` — NTLMv2 hash disclosure via UNC path handling on Windows), https://github.com/advisories/GHSA-67mh-4wv8-2f99 (`esbuild` — development server accepts cross-origin requests)
- **Severity**: High (`vite`), Moderate (`esbuild`, `vitepress`)
- **Dependency chain**: A single root — `vitepress@1.6.4`, a direct **devDependency** used only by the `docs:dev` / `docs:build` / `docs:preview` scripts. It pins `vite@^5.4.14` (resolved `5.4.21`), which in turn pins `esbuild@^0.21.3` (resolved `0.21.5`). Every advisory above enters through that one chain. The other copies in the tree are **not** affected and must not be conflated with it: `vite@6.4.3` (used by `vitest` and `@vitejs/plugin-react`) is outside the `<= 6.4.2` range, `vite/node_modules/esbuild@0.25.12` is outside both esbuild ranges, and `tsx/node_modules/esbuild@0.28.2` is likewise clean.
- **Upstream fix available**: Patched releases exist (`vite` 6.4.3, `esbuild` 0.25.0) but are **unreachable from this tree**, which is a different situation from "no fix has been published". `vitepress@1.6.4` is the latest published release and still declares `vite@^5.4.14`, so the patched Vite 6.x cannot be resolved without overriding VitePress's own peer expectations, or dropping/replacing VitePress. `npm audit` reports `fixAvailable: false` for exactly this reason. An `overrides` entry was considered and rejected: forcing Vite 6.x under a VitePress release built against Vite 5.x risks breaking the docs build for a defect with no production exposure.
- **Impact assessment**: Accepted. These are `devDependencies` and none of them are present in, or reachable from, the production runtime — the shipped application is built by Next.js and served by Fastify, neither of which loads Vite, VitePress, or esbuild's dev server. Every listed advisory requires an attacker to reach a locally running development server, and two of the four are Windows-only. There is no exposure in deployed environments; the residual risk is limited to a developer running the docs site while visiting a hostile page on the same machine.
- **Mitigation**: Do not expose the VitePress or Vite dev servers beyond `localhost`. Revisit if a VitePress release adopts a patched Vite 6.x. **Caveat on the release gate**: `npm audit --omit=dev` is the audit used for releases, but it is not a complete model of the production dependency set — `tsx` is declared in `devDependencies` yet is loaded by the production `start` script (`node --import tsx src/server/index.ts`), so packages reachable only through `tsx` are excluded from that audit despite executing in production. `tsx` and its `esbuild` are currently clean, so this is a scope gap rather than an active exposure, but the classification should be corrected before it is relied on again.
- **Last reviewed**: 2026-08-28

## Safe Harbor

If you act in good faith, avoid data destruction, avoid privacy violations, and do not disrupt service availability, the project will treat your research as authorized for the purpose of coordinated disclosure.
