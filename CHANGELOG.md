# Changelog

For the full changelog, see [docs/changelog.md](docs/changelog.md). Released versions are described in the
[release notes](docs/releases/index.md); this page lists what is already merged and not yet in a release.

## Unreleased

### Authorization

- The policy engine decides every request. The earlier legacy, shadow and monitor modes are gone: a policy is
  either enabled or disabled, and a refusal always carries a decision id. When the engine cannot decide, the
  request is answered `503 authorization_unavailable` instead of being allowed. The workspace owner's session
  always reaches the IAM center, so the owner can repair a policy that went wrong.
- Project permission levels narrow a person's access in that project: a level that is left on **Inherit** follows
  the person's workspace level, an explicit level caps it.
- A deny rule that cannot be evaluated for a request counts as a deny for that request.
- The session payload carries `effectivePermissions`, so the navigation shows only what the active project allows.

### People and access

- The IAM center's **Principals** tab is the one place to manage people, service accounts, groups and API tokens:
  invite or create, edit, change the role, disable, delete, group memberships and token rules, with server-side
  search, filters and paging, bulk actions on the current page and filters kept in the address.
- The role of a person can be changed (the owner's role cannot, nobody changes their own, and only an owner or an
  admin grants or removes the admin role). A role change applies to the API at once and to page access within
  half a minute.
- Accounts managed by a directory (LDAP, SSO) keep their name, email and password in the directory and are
  disabled rather than deleted here. A password reset is not offered for them.
- "Programmatic user" is now **Service account**.
- A new **My account** page lets every person see their profile, change their own password (local accounts) and
  reach their own API tokens. The API tokens page lists a person's own tokens only; owners and admins manage
  other people's tokens in the IAM center, never above their own level. Editing or revoking a token that is not
  your own is limited to the projects you belong to.
- People who are neither owners nor admins and hold no `iam` permission no longer see the IAM center.
- The Members and Tenant settings pages are removed; their old addresses redirect.

### Portals (Enterprise)

- Opening a portal and running an agent through it are decided by the policy engine. A portal's access list is its
  built-in policy; custom deny rules can block on top of it. A refusal shows a reference code on the portal's error
  page and in the **Access check**. If the engine cannot decide, the portal fails closed.

### Search and display

- Pickers and lists in the IAM center search Turkish names the way people type them: `istanbul` finds `İstanbul`,
  and the Turkish letters I, İ, ı and i match each other. The page language follows the locale.
- Portal pages stay readable on dark portal themes.
