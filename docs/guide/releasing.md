# Releasing

This runbook defines the intended release order for the community and enterprise SaaS editions.

## Public-Safe Scope

This page is safe to keep in the public community repository because it documents release order and public workflow behavior only.

It does not include:

- secrets, tokens, or registry credentials
- internal deployment environments
- private repository automation details
- customer-specific rollout procedures

Private operational steps should stay in the private enterprise repository or internal ops documentation.

## Core Rule

Release the community edition first.

The enterprise SaaS build is layered on top of a released community tag. If the community change is not merged and tagged yet, enterprise SaaS will not pick it up.

## Community Release

The community build is tag-driven.

- Merge the intended community changes to `main`.
- Run the normal validation set for the release candidate.
- Create and push a tag in the format `vX.Y.Z-community`.
- The community build workflow publishes from that tag.

Current trigger: `.github/workflows/build-community.yml` listens only for `vX.Y.Z-community` tags.

## Enterprise SaaS Release

The enterprise SaaS build is also tag-driven, but it does not build from an unreleased community branch.

- Make sure the required community release tag already exists.
- Confirm enterprise compatibility metadata still matches the intended community release line.
- Create and push the SaaS tag from the private enterprise release flow.

The public contract to remember is simple: enterprise SaaS must follow a released community tag, not an open PR or an unmerged branch.

## What To Avoid

- Do not treat a release branch or PR as the release itself.
- Do not assume enterprise SaaS will include community changes that only exist in a branch.
- Do not cut the SaaS release first when it depends on community changes that are not tagged yet.

## Minimal Checklist

1. Merge community changes.
2. Validate community release candidate.
3. Push `vX.Y.Z-community`.
4. Confirm enterprise compatibility against that community release.
5. Run the private SaaS release flow.

## Validation Reminder

Keep docs verification in the release loop:

```bash
npm run lint
npm run build
npm run test
npm run docs:build
```