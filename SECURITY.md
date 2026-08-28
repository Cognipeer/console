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

The following vulnerabilities exist in transitive (indirect) dependencies and have been reviewed by the maintainers. They are tracked here for transparency. Direct/path-of-fix vulnerabilities are pinned through `overrides` in `package.json`.

### GHSA-5v7r-6r5c-r473 — `file-type` (moderate) — Resolved

- **Advisory**: https://github.com/advisories/GHSA-5v7r-6r5c-r473
- **Description**: Infinite loop in ASF parser on malformed input with zero-size sub-header.
- **Severity**: Moderate
- **Dependency chain**: `@cognipeer/to-markdown` → `file-type`
- **Upstream fix available**: Yes — fixed in `file-type` 21.3.1. `@cognipeer/to-markdown` (now resolved to 3.3.0) pulls in `file-type` 22.0.2, which is not affected.
- **Impact assessment**: Was triggered only by specially crafted malformed ASF input. Worst case was a process hang (DoS); no data exfiltration or code execution path.
- **Mitigation**: Resolved by upgrading dependencies via `npm audit fix` (no application code changes required). File uploads remain size-capped via `FILE_UPLOAD_MAX_MB` and optionally MIME-allowlisted via `FILE_UPLOAD_ALLOWED_MIME_TYPES` as defense-in-depth.
- **Last reviewed**: 2026-08-27

### `image-size` — DoS via infinite loop in ICNS/JXL/HEIF parsers (high) — Resolved (dependency replaced)

- **Advisories**: https://github.com/advisories/GHSA-w3rx-r6r6-pgpr (ICNS parser), https://github.com/advisories/GHSA-5p2g-fcmc-qvqq (JXL/HEIF parsers)
- **Severity**: High
- **Dependency chain (historical)**: `@cognipeer/to-markdown` → `image-size`
- **Upstream fix available**: No — `image-size` was never patched; `2.0.2` is the last version ever published to npm and both advisories report no patched version.
- **Impact assessment**: Was triggered only by specially crafted malformed image input processed during Markdown conversion. Worst case was a process hang (DoS); no data exfiltration or code execution path.
- **Mitigation**: Not an accepted risk — `@cognipeer/to-markdown` (bumped 3.1.0 → 3.3.0 via `npm audit fix`) dropped `image-size` entirely in favor of `image-dimensions` 2.5.1, which is unaffected by these advisories. `image-size` is no longer present anywhere in the dependency tree.
- **Last reviewed**: 2026-08-27

### `xlsx` — SheetJS prototype pollution + ReDoS (high)

- **Advisories**: https://github.com/advisories/GHSA-4r6h-8v6p-xvw6 (Prototype Pollution), https://github.com/advisories/GHSA-5pgg-2g8v-p4x9 (ReDoS)
- **Severity**: High
- **Dependency chain**: Direct dependency of `cognipeer-console` (root `package.json` → `xlsx@^0.18.5`). Previously also reached transitively via `@cognipeer/to-markdown`, but `to-markdown` 3.3.0 replaced its own spreadsheet handling with `exceljs`; the direct root dependency is now the only installation of `xlsx` in the tree.
- **Upstream fix available**: SheetJS Community Edition (`xlsx` on npm) is no longer published with fixes; the maintained build is on `cdn.sheetjs.com`. Migration to `exceljs` (already used elsewhere in the stack) or pinning to the CDN build is under evaluation.
- **Impact assessment**: `xlsx` is used client-side only, to parse user-selected `.xlsx`/`.xls` files in the browser for the Evaluations dataset importer (`src/components/evaluations/datasetImport.ts`) and the Analysis conversation importer (`src/components/analysis/conversationImport.ts`). It is no longer invoked server-side via `@cognipeer/to-markdown`. Exploitation requires an authenticated user to import a maliciously crafted spreadsheet into their own browser session; blast radius is scoped to that user's own client, not the shared backend.
- **Mitigation**: Operators concerned about malicious spreadsheet imports should advise users to only import trusted files. Migration off `xlsx` (to `exceljs`) is tracked separately.
- **Last reviewed**: 2026-08-27

### `thrift` (high) — Milvus SDK — Resolved

- **Advisories**: https://github.com/advisories/GHSA-r67j-r569-jrwp (Uncontrolled Recursion), https://github.com/advisories/GHSA-526f-jxpj-jmg2 (Path Traversal / Request Splitting)
- **Severity**: High
- **Dependency chain**: `@zilliz/milvus2-sdk-node` → `@dsnp/parquetjs` → `thrift`
- **Upstream fix available**: Yes — fixed in `thrift` 0.23.0 (resolves both advisories). Resolved via `npm audit fix`; `@dsnp/parquetjs` now resolves to the patched `thrift` and no longer appears in `npm audit` output.
- **Impact assessment**: Was loaded only when reading Parquet files retrieved from Milvus. Console does not expose the Thrift HTTP server. Risk path required a malicious Parquet file returned by Milvus — only relevant when operators trusted their Milvus instance.
- **Mitigation**: Resolved by upgrading dependencies via `npm audit fix` (no application code changes required).
- **Last reviewed**: 2026-08-27


## Safe Harbor

If you act in good faith, avoid data destruction, avoid privacy violations, and do not disrupt service availability, the project will treat your research as authorized for the purpose of coordinated disclosure.