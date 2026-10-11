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
- When a directory connection (LDAP, SSO) is set to sync roles, the role of the accounts it signs in is the
  directory's: it is shown as **Managed by your directory** and the server refuses to change it by hand
  (`409 directory_managed`). Their access, projects and groups stay editable. Without a directory connection
  nothing changes.
- Upgrade note, directory role sync: a directory connection saved before this release reads as syncing roles, so
  the first sign-in after the upgrade gives each account the role the directory says (the admin mapping, otherwise
  the connection's default role). A role that was set here by hand and differs from it is replaced, and with an admin
  mapping an admin who is not in it falls to the default role. To keep the roles as they are, switch **Sync role
  from the directory** off in the connection's settings right after the upgrade, before people sign in. The workspace
  owner is never changed. A directory can say only admin or the default role, so with the switch on a person cannot
  be given the project admin role directly (use a group).
- Groups can come from SSO as well as from LDAP. The members of a group that comes from a directory are the
  directory's: adding or removing one is refused (`409 group_directory_managed`) and the group and person drawers
  say where the group comes from. A directory group's grants, projects and policies stay editable.
- "Programmatic user" is now **Service account**.
- A new **My account** page lets every person see their profile, change their own password (local accounts) and
  reach their own API tokens. The API tokens page lists a person's own tokens only; owners and admins manage
  other people's tokens in the IAM center, never above their own level. Editing or revoking a token that is not
  your own is limited to the projects you belong to.
- People who are neither owners nor admins and hold no `iam` permission no longer see the IAM center.
- The Members and Tenant settings pages are removed; their old addresses redirect.

### Acting for a user (verified identity)

- An application can send a signed statement about the person a call is for in the `X-Cognipeer-User-Token` header,
  next to its API token. The call then runs as that person (their access, limits, quotas and name in the logs), capped
  by the token's scope and project; the token stays the actor. Owners and admins set it up per token under **IAM center
  → Principals → API tokens → Acting for users**: issuer, audience, a pinned algorithm (`HS256`, `RS256`, `ES256`), a
  shared secret with key ids, a public key or a key set URL, how the person is found (identity and/or verified email)
  and what to do when nobody matches (nothing, an external account, or a person managed by the identity provider).
- The workspace owner can never be acted for; an administrator only when the setup allows it, and a refused account is
  left untouched (not linked to the subject, no group changes). A refused call
  is answered `401` (`delegation_not_enabled`, `invalid_assertion`, `expired`, `untrusted_key`, `unknown_principal`,
  `disabled`, `seat_limit`, `conflict`), `403` (`delegation_refused`, `project_not_accessible`) or `503`
  (`delegation_unavailable`), always with a decision id; the token's owner is never the fallback.
- The person must be able to open the token's project themselves, as in the dashboard: a membership of their own or of
  one of their groups (an external person: a delegated group that was given the project), or any project for an
  administrator. Otherwise the call is refused (`project_not_accessible`).
- **External** accounts: people of a host application who are vouched for by a trusted issuer. They cannot sign in to
  the dashboard or hold API tokens, always have the User role, are never added to a project (their access comes from the
  groups they are in) and are left out of member lists and pickers; the IAM center shows them with a badge and a
  counter. Creating one counts toward the licence user limit.
- Groups can follow the statement: with a group map, memberships in groups created for that issuer (never in a local or
  directory group) follow the `groups` claim, and every change is audited.
- Usage rows, request logs, runs and traces record the person as the subject and the application token as the actor, with
  `via: { kind: "delegated", issuer }` where a record has a metadata field. A person's drawer in the IAM center has a new
  **Activity** section.

### Portals (Enterprise)

- Opening a portal and running an agent through it are decided by the policy engine. A portal's access list is its
  built-in policy; custom deny rules can block on top of it. A refusal shows a reference code on the portal's error
  page and in the **Access check**. If the engine cannot decide, the portal fails closed.

### Search and display

- Pickers and lists in the IAM center search Turkish names the way people type them: `istanbul` finds `İstanbul`,
  and the Turkish letters I, İ, ı and i match each other. The page language follows the locale.
- Portal pages stay readable on dark portal themes.
