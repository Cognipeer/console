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
 
The following vulnerabilities exist in transitive (indirect) dependencies and have been reviewed by the maintainers. They are tracked here for transparency.
 
### GHSA-5v7r-6r5c-r473 — `file-type` (moderate)
 
- **Advisory**: https://github.com/advisories/GHSA-5v7r-6r5c-r473
- **Description**: Infinite loop in ASF parser on malformed input with zero-size sub-header.
- **Severity**: Moderate
- **Dependency chain**: `@cognipeer/to-markdown` → `file-type`
- **Upstream fix available**: No
- **Impact assessment**: This vulnerability requires a specially crafted malformed ASF file as input. In the context of this project, the risk is low as file-type is used for MIME detection on trusted inputs. A malicious file could cause a process hang (DoS), but not data exfiltration or code execution.
- **Mitigation**: We will upgrade `file-type` as soon as an upstream fix is published. Dependabot is configured to alert on updates.
- **Last reviewed**: 2025-04-16
- **Next review**: 2025-05-16
### xlsx (high)
 
- **Advisory**: *(link to specific GHSA when available)*
- **Severity**: High
- **Dependency chain**: `@cognipeer/to-markdown` → `xlsx`
- **Upstream fix available**: *(check and update)*
- **Impact assessment**: *(describe how xlsx is used in your project and whether untrusted .xlsx files are processed)*
- **Mitigation**: Evaluating migration to alternative libraries (e.g., `exceljs`, `SheetJS community edition`). Will update once a decision is made.
- **Last reviewed**: 2025-04-16
- **Next review**: 2025-05-16


## Safe Harbor

If you act in good faith, avoid data destruction, avoid privacy violations, and do not disrupt service availability, the project will treat your research as authorized for the purpose of coordinated disclosure.