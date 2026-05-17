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

### GHSA-5v7r-6r5c-r473 — `file-type` (moderate)

- **Advisory**: https://github.com/advisories/GHSA-5v7r-6r5c-r473
- **Description**: Infinite loop in ASF parser on malformed input with zero-size sub-header.
- **Severity**: Moderate
- **Dependency chain**: `@cognipeer/to-markdown` → `file-type`
- **Upstream fix available**: No
- **Impact assessment**: Triggered only by specially crafted malformed ASF input. Worst case is a process hang (DoS); no data exfiltration or code execution path.
- **Mitigation**: File uploads are size-capped via `FILE_UPLOAD_MAX_MB` and optionally MIME-allowlisted via `FILE_UPLOAD_ALLOWED_MIME_TYPES`. We will upgrade `file-type` as soon as an upstream fix lands.
- **Last reviewed**: 2026-05-17

### `xlsx` — SheetJS prototype pollution + ReDoS (high)

- **Advisories**: https://github.com/advisories/GHSA-4r6h-8v6p-xvw6 (Prototype Pollution), https://github.com/advisories/GHSA-5pgg-2g8v-p4x9 (ReDoS)
- **Severity**: High
- **Dependency chain**: `@cognipeer/to-markdown` → `xlsx`
- **Upstream fix available**: SheetJS Community Edition (`xlsx` on npm) is no longer published with fixes; the maintained build is on `cdn.sheetjs.com`. Migration to `exceljs` or pinning to the CDN build is under evaluation.
- **Impact assessment**: `xlsx` is invoked from `@cognipeer/to-markdown` when converting user-uploaded `.xlsx` files. With prototype pollution mitigations active in Node 20+ and file uploads size-capped, exploitability is reduced. Untrusted spreadsheet input still represents elevated risk.
- **Mitigation**: Operators uploading untrusted spreadsheets should disable the Markdown conversion path or restrict the file MIME allowlist. Issue tracked for `@cognipeer/to-markdown` replacement.
- **Last reviewed**: 2026-05-17

### `thrift` (high) — Milvus SDK

- **Advisories**: https://github.com/advisories/GHSA-r67j-r569-jrwp (Uncontrolled Recursion), https://github.com/advisories/GHSA-526f-jxpj-jmg2 (Path Traversal / Request Splitting)
- **Severity**: High
- **Dependency chain**: `@zilliz/milvus2-sdk-node` → `@dsnp/parquetjs` → `thrift`
- **Upstream fix available**: Pending Milvus SDK upgrade of `@dsnp/parquetjs`.
- **Impact assessment**: Thrift is loaded only when reading Parquet files retrieved from Milvus. Console does not expose the Thrift HTTP server. Risk path requires a malicious Parquet file returned by Milvus — only relevant when operators trust their Milvus instance.
- **Mitigation**: Use a trusted Milvus deployment. Track Milvus SDK releases for the parquetjs upgrade.
- **Last reviewed**: 2026-05-17


## Safe Harbor

If you act in good faith, avoid data destruction, avoid privacy violations, and do not disrupt service availability, the project will treat your research as authorized for the purpose of coordinated disclosure.