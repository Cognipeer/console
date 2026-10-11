# Authorization

One policy engine decides every request, in every workspace, from the first request. There is no mode to switch on and nothing to enable: the settings you already maintain are turned into decisions by a fixed set of built-in policies, and custom policies handle the exceptions.

This page is the model. For signing in and API tokens see [Authentication](/guide/authentication); to move an existing installation to this release see [Upgrading to the policy engine](/guide/upgrading-to-the-policy-engine).

[[toc]]

## How a request is decided

```text
 settings you maintain              built-in policies                  your own policies
 ─────────────────────              ─────────────────                  ─────────────────
 workspace role                     six allow rules turn the           allow or deny exceptions;
 own service permissions            effective level of a person   →    a deny always wins, an allow
 group grants                  →    or token into allow / deny         never goes beyond the
 project member permissions         per service and level              boundaries
 API token scope                    six boundaries that no
                                    custom policy can cross
```

A request is allowed only when something allows it and nothing denies it. You do not have to write a policy to get a working system: roles, group grants, project permissions and token scopes already decide everything. Custom policies add to that, they do not replace it.

Every API route states how it is authorized:

| Declaration | Meaning |
|---|---|
| a **service** | The caller needs a level on that service (`models`, `prompts`, `agents`, ...). A read-only call (`GET`, `HEAD`, `OPTIONS`) needs `read`; anything else needs `write`; on an administration service a change needs `admin`. Most routes are this kind. |
| **authenticated** | Any signed-in person or valid API token of the workspace. The handler may still filter what the caller sees. |
| **self** | The handler authenticates the caller itself (signed links, machine tokens, shared secrets). |
| **public** | No authentication (sign-in, health checks). |

A route that declares nothing is refused with `403` and `code: "route_not_declared"`. A healthy build has none; `GET /api/iam/engine/stats` lists any it finds.

## The settings you maintain

| Setting | Where you change it | What it does |
|---|---|---|
| Workspace role | **IAM center → Principals**, a person's **Change role** (owner, admin, project admin, user) | Sets the default level of every service. |
| Own service permissions | **IAM center → Principals**, a person's **Edit access** | Replaces the role default for that service. It may lower the default as well as raise it. |
| Group grants | **IAM center → Principals → Groups**, a group's workspace role and service permissions | Raises the level of every member of the group. A group can only raise. |
| Project member permissions | **Settings → Projects**, a project's **Members**, **Project service permissions** | Caps what a member can do inside that project. It can only lower. See [Project permissions](#project-permissions). |
| API token scope | **API Tokens** (your own tokens), or **IAM center → Principals → API tokens** (other people's, for owners and admins) | Caps what the token can do. See [API tokens](#api-tokens). |

### Levels

| Level | Meaning |
|---|---|
| `none` | No access. |
| `read` | List and view (`GET`). |
| `write` | Create, change, delete and run (`POST`, `PUT`, `PATCH`, `DELETE`). |
| `admin` | Manage. On an administration service every change needs `admin`. |

| Role | Normal services | Administration services |
|---|---|---|
| `owner` | `admin` | `admin` |
| `admin` | `admin` | `admin` |
| `project_admin`, `user` | `write` | `none` |

The administration services are `automations`, `members`, `providers`, `config`, `license`, `audit`, `gpu-fleet`, `sandbox`, `cluster`, `sso`, `ldap`, `webhooks`, `portals`, `resources` and `iam`. A person gets one of them only through an explicit service permission or a group grant. (Project admins get no extra access to them: to let a project admin manage, say, webhooks, grant that person or their group the service.)

### How the settings combine

```text
workspace level = highest of ( own level, the grant of each of the person's groups )
effective level = lowest  of ( workspace level,
                               token scope        - API tokens only,
                               project level      - members who are not owners or admins )
```

- **People.** The workspace level is the highest of the person's own level and each group's grant. In a project, the project level can only lower it.
- **API tokens.** A token starts from its owner's workspace level, **including the owner's group grants**, is capped by its scope, and is then limited by the project level of its project (a token without a project runs in the workspace's default project).
- **Never limited by a project.** Owners, admins, and members who are admin through a group.

## Project permissions

A project member (a person assigned to the project, or a group assigned to it) can carry a level per service. On the **Project service permissions** screen each service shows the workspace level, the level for this project and the result:

| Choice | Effect in this project |
|---|---|
| **Inherit** | Nothing is set for the service. The workspace level applies. |
| **No access** | The member cannot use the service here. |
| **Read**, **Write**, **Admin** | The member is capped at that level here. |

A project level never raises access: the lower of the workspace level and the project level applies. Inherit and No access are different things; Inherit is the default and means "no opinion".

When a person reaches a project several ways (their own assignment and the assignments of their groups), the highest level any of them names for a service wins, so a group assignment with **Read** lifts a personal **No access**.

### What changed for older assignments

Earlier releases stored these levels and showed them in the member screens, but no gate read them, and the screen displayed every service nobody had set as "None". Applying every stored `none` literally on the first request would cut people off from services nobody meant to restrict. So:

- The first time the engine decides a request in a workspace, it records that moment once (the *activation instant*, a small `iam_meta` document).
- An explicit **No access** in an assignment that was last saved **before** the activation instant is read as **Inherit**.
- **Read**, **Write** and **Admin** entries always apply.
- Assignments saved **after** the activation instant apply in full, including **No access**: the screen saves it deliberately now.

::: warning One edge case
The rule looks at when the assignment was last saved, and any save counts, also an unrelated one such as changing the member's project role. After that save an old **No access** in the same assignment starts to apply. Review old assignments after the upgrade: set the services you really want blocked to **No access** and the rest to **Inherit**. The [preflight report](/guide/upgrading-to-the-policy-engine#run-the-preflight-report) lists them under "Deferred".
:::

## API tokens

An API token acts as its owner, with three refinements:

- It takes the owner's **group grants** too. (Until this release a token saw only its owner's own workspace level.)
- Its **scope** is a cap: a service that is not in a scoped token's scope resolves to `none`; `{}` is a scope that allows nothing; no scope means the token inherits the owner unchanged. A scope can only narrow, never widen.
- It runs in its **project**, so the owner's project permissions in that project limit it. A token without a project runs in the workspace's default project.
- It never reaches beyond its project: a question that is about the workspace itself, outside any project (for example, whether a tenant-wide webhook endpoint is in reach), is always answered "no" for a token, whoever owns it.

Expiry rules and IP allowlists are part of [Authentication](/guide/authentication#expiry-and-the-tenant-token-policy). The tenant-wide metrics export (`GET /api/metrics`) refuses a token that carries a service scope, because a per-service cap cannot be honoured on an export that spans every module: use an unscoped token for the scraper.

## The IAM center

**Settings → IAM center** gathers the tools. Viewing needs `read` on the `iam` service and changing needs `admin`; owners and admins have both.

| Tab | What it is for |
|---|---|
| **Overview** | Engine status, policy counts and the latest denials, and anything that needs attention: custom statements that could not be applied, routes without a declaration, times authorization was unavailable. |
| **Policies** | The built-in and custom policies: create, edit, enable, disable, preview. |
| **Principals** | Every person and API token with their effective level per service and where each level comes from (role, direct grant, group, token scope, project limit, policy). |
| **Access check** | "Can this person or token do this, and which rule decides?" and the lookup of a decision id. |
| **Audit** | Denials and policy changes, with CSV export. |
| **Limits** | Usage and spending limits for groups, projects and agent runs. |
| **Settings** | The workspace's API token rules: a maximum lifetime and whether an expiry is required. |

## Built-in policies

Eighteen policies ship with the engine. They are the same in every workspace, cannot be edited or removed, and are listed under **Built-in** on the **Policies** tab of the IAM center.

| Policy | What it does |
|---|---|
| `managed:rbac:user-read`, `user-write`, `user-admin` | A signed-in person may read, write or administer a service when their effective level reaches it. A change on an administration service needs `admin`. |
| `managed:rbac:token-read`, `token-write`, `token-admin` | The same for an API token, from its owner's level and the token's scope. |
| `managed:boundary:token-cap-read`, `-write`, `-admin` | A scoped token is denied what its scope does not name. No custom allow can exceed it. |
| `managed:boundary:project-read`, `-write`, `-admin` | A service that the active project limits is denied above the project level. No custom allow can exceed it. |
| `managed:portal:use`, `managed:portal:agent` | A person on a portal's access list (or in a group on it, or anyone when the portal is open to the workspace) may open the portal and run its agents. See [Portals](#portals). |
| `managed:portal:use-boundary`, `managed:portal:agent-boundary` | Nobody else may, whatever their role or any allow rule says. Custom deny rules still apply on top. |
| `managed:agent:approve`, `managed:agent:approve-token` | A person (or a token, on behalf of its owner) may approve a tool call of an agent session when they started it, or when the agent's *Who can answer* setting accepts them. The generic Write permits leave this one action out, so the rule is what appoints; your own allow rules can appoint more approvers. See [Sessions and approvals](#sessions-and-approvals). |

The simple settings stay the single place to change what people can do; the built-in policies only translate them. Nothing is stored per person or per group in a policy.

## Custom policies

Use a custom policy for what the simple settings cannot say: freeze a service for one group, give a team temporary access, block writes from a network.

- A policy is **enabled** or **disabled**. There is no other state. To see the effect of a rule before it applies, use **Preview impact** in the editor (who would be affected) and the [Access check](#check-access), and save the rule disabled until you are ready.
- **Allow** or **Deny**. A deny always wins. An allow can never go beyond a token's scope or a project's limits.
- Anyone with `admin` on the `iam` service (owners and admins by default) can create and edit policies. **Only owners and admins can make a rule that allows take effect**, because allowing is permission management; a delegated IAM administrator can write denies and can save an allow disabled.
- A rule is built in the guided editor (who, what, where, when) or written as Cedar. Either way it is checked against the engine's schema before it is saved.
- Limits: 500 policies, 50 statements per policy and 500 statements per workspace; 64 KiB per policy and 256 KiB in total.

A guided rule says:

| Part | Choices |
|---|---|
| **Who** | People, groups, API tokens, any person, any token, or everyone. A rule about a person or group also covers the API tokens they own, so a deny cannot be walked around with a token. |
| **What** | Read, Write or Admin on every service, or specific service actions such as `models.write`. |
| **Where** | Services, projects, and specific portals or agents (see [Portals](#portals)). |
| **When** | A start and end time, IP ranges, channels (`dashboard` for a signed-in session, `api` for a token, `portal` for a person using a portal). |

The conditions of one rule must all hold for it to apply. The editor warns about rules that cannot do what they say: an action nothing in the product asks (`models.admin` when no route needs it), a rule about a single resource other than a portal, an agent or a Files bucket (the gates decide on services; a deny of that kind is refused), an allow rule about portals (a portal is opened by its access list alone, see [Portals](#portals)), and IP rules while `TRUSTED_PROXIES` is not set (see [below](#client-address-and-trusted-proxies)).

A deny rule that cannot be evaluated for a request (a condition that reads something the request does not have) counts as a **deny** for that request. The decision names the rule and the problem, so a rule written to block something can never stop blocking it silently. The same holds for a broad rule: one that cannot be evaluated for *every* request it matches refuses all of them, the workspace owner's access to the IAM center excepted - so the owner can always open **Policies**, find the rule the decision names and fix or disable it. (A rule that cannot even be loaded, for example after an engine upgrade, is skipped instead, and the engine reports itself as `degraded`.)

## Sessions and approvals

An agent session belongs to the person who started it (for API traffic, the owner of the token). Three actions of an agent decide what somebody **else** may do with it. They are checked by the agent routes of the dashboard and the API, after the route's own service check, in the `dashboard` and `api` channels:

| Action | Asked when | Level |
|---|---|---|
| `agent.approve` | Somebody answers a pending **tool approval** (allow, deny, edited arguments, remember for the session); or ends one as a side effect (cancelling a paused run, a new message to an agent that cancels pending requests). Also asked by portals, in the `portal` channel. | Write |
| `agent.session_view_others` | Somebody reads a session another person started: its transcript, events, files, runs. | Read |
| `agent.session_manage_others` | Somebody changes a session another person started: continues it, raises its budget, uploads or deletes its files, deletes it. | Write |

The person who started a session needs only the route's service check. Sessions started by something that is not a person (`a2a-public`, schedules, evaluations, red-team runs) belong to nobody in particular: they count as someone else's.

- **`agent.approve`** is **appointed**. The built-in `managed:agent:*` policies appoint the session's owner and whoever the agent's *Who can answer* setting accepts (see [Agent approvals](/guide/agent-approvals)); the generic Write permission does not grant it, so a workspace writer cannot approve somebody else's tool call unless the setting accepts them. A custom **allow** rule appoints more approvers (a compliance group, say) and a custom **deny** rule narrows; the token's scope and the project's limits apply to both. Answering a **question** is not an approval: the session's owner always may, anybody else needs `agent.session_manage_others`.
- **`agent.session_view_others`** and **`agent.session_manage_others`** sit in the Read and Write levels, so by default every holder of `agents` Read or Write has them. To restrict them, write an ordinary deny rule in **Policies**: choose the action, and who it applies to (for example a group of contractors). The person who started a session is never asked.
- The default follows the **`agents`** service, on every path to a session. A role that holds Tracing or Files but has no `agents` level does not reach other people's agent sessions through those screens either: the tracing threads of an agent are left out of its lists and refused with `403` when asked for by id, and so are the session files in the Document Store. Earlier releases did not look at who started a session on those paths at all, so a Tracing-only or Files-only reader loses that reach. To keep it, give the role `agents` Read, or write an **allow** rule for `agent.session_view_others`; nothing in the Tracing and Files screens themselves changes for ids that are not agent sessions.

Every path to a session's content asks the same question: the session routes themselves, the files a session holds (also through the Document Store and the client Files API), its events, its runs (polling and cancelling), a tracing thread, the threads of the Assistants API and the continuation of a session by its id in the Responses and chat completions routes - whichever service (`agents` or `models`) lets the token in. A **list** shows everybody's sessions or, when the rule stops the caller, only their own; the database applies this before the page is cut, so another person's sessions never push the caller's own off it. The scope is a list of the agents whose other-people's sessions the caller may view: the sessions of an agent that was deleted (they stay when the agent goes) are therefore only ever shown to the person who started them, as soon as any rule restricts the caller. The lists that are cut by the tracing and Files stores (tracing threads and sessions, the objects of a bucket) are read on until the caller's page is full; for a restricted caller the tracing lists answer `hasMore` and `nextSkip` (where the next page starts) instead of `total`, which cannot be known without reading everything. Rows of the Sessions table carry who started them. If the engine cannot decide - or the store cannot say who started a session - the answer is `503 authorization_unavailable` with `Retry-After` (never a `403`, never an allow), lists included. A session event stream is checked when it opens and again every minute while it stays open (the person's standing in the project, a revoked token, a rule written since); when the answer is no the stream ends with an `error` event and the client, resuming with `Last-Event-ID`, is answered at the door.

A session started through **A2A** is still only visible to the caller that started it (the stricter rule that existed before); the EE sandbox routes address a machine by its id and do not ask the session question yet.

The Access check asks these actions about an agent, with the session's owner and, for `agent.approve`, the agent's setting as inputs.

### Where an agent keeps its files

Naming the bucket in an agent's **Files** settings (`attachments.bucketKey`) is a Files decision about **that bucket**: the person needs `file-bucket.update` on it (by default, Write on *Files*), and the bucket picker lists only the buckets they may look at (`file-bucket.get`, by default Read on *Files*), marking the ones they cannot name. Write a deny rule on one bucket to keep it out of agents' settings or out of the picker. Re-saving the bucket already stored asks nothing. The decisions are recorded in the denials feed like any other.

## Portals

A portal (an Enterprise feature) lets chosen people and groups use chosen agents from a page of their own. The engine decides three things about it, in the `portal` channel:

| Action | Asked when | Level |
|---|---|---|
| `portal.use` | A person opens the portal, on every request they make to it. | Read |
| `agent.invoke` | A person sends a message to one of the portal's agents. | Write |
| `agent.approve` | A person answers a pending approval or question of a session started through the portal. | Write |

**The access list is the portal's built-in policy.** It lives on the portal (**Portals → the portal → Access**: everyone in the workspace, or selected people and groups), and the built-in `managed:portal:*` policies read it, so editing the list never touches a policy and nothing is stored per portal. A change to the list applies on the next request. Opening a portal is allowed **only** by the list: a workspace role, a service permission or an allow rule cannot open a portal the list does not name, and the workspace owner is no exception. API tokens never open portals.

**Custom deny rules still apply on top.** Use one to block a person or group that is on the list, to freeze a portal, or to stop one agent from running in portals:

```json
{
  "effect": "forbid",
  "principals": { "groups": ["6b1f0c52-2f0a-4c1e-9c61-3f0d8a1b7e11"] },
  "actions": ["portal.use"],
  "resources": { "resources": [{ "type": "portal", "id": "<portal id>" }] },
  "conditions": { "channels": ["portal"] }
}
```

- `Read` in the `portal` channel covers opening portals and `Write` covers running their agents and answering their requests, so a rule such as "contractors: deny Write everywhere" also stops them from sending messages in a portal while they can still open it.
- A rule that names a portal also covers the agents run through it (an agent run through a portal is *in* that portal).
- An allow rule never adds anyone to a portal; the editor says so when you write one.
- These rules are accepted only on an installation that has portals. Without them there is nothing to apply a rule to, and a deny about portals is refused like any rule that cannot match a request.

**A refusal shows a reference code.** The person sees it on the portal's error page (and in the message of a refused chat message); an administrator pastes it into **Access check → decision id** and sees the action on the portal or agent, the channel, the people and rules that decided and, for a rule that has since been switched off or deleted, which one and what the current policies say about the same request. Like every refusal it is written to the audit log, once per person, action, portal and reason per minute (a client that keeps retrying shares one reference code and one row).

**When the engine cannot decide**, the portal fails closed: the person is told to try again, with a reference code, and the refusal is counted like any other "authorization unavailable" (503). It never falls back to another rule.

**Large lists.** The engine's cost grows with the number of people and groups on a list (about 7 microseconds each). Above 200 entries it evaluates only the requester's part of the list, which gives the same answer. A custom rule written in Cedar that looks at *other* members of `resource.allowedUsers` sees that part, not the whole list.

### Examples

Freeze Model Hub changes for a group:

```bash
curl -X POST https://console.example.com/api/iam/policies \
  -H "Content-Type: application/json" --cookie "token=..." \
  -d '{
    "name": "Freeze Model Hub for contractors",
    "enabled": true,
    "spec": {
      "effect": "forbid",
      "principals": { "groups": ["6b1f0c52-2f0a-4c1e-9c61-3f0d8a1b7e11"] },
      "actions": ["models.write"],
      "resources": { "services": ["models"] }
    }
  }'
```

The editor compiles that to:

```text
forbid (
  principal,
  action == Action::"models.write",
  resource
)
when {
  (
    principal in [Group::"6b1f0c52-2f0a-4c1e-9c61-3f0d8a1b7e11"]
    || (principal is ApiToken && principal.owner in [Group::"6b1f0c52-2f0a-4c1e-9c61-3f0d8a1b7e11"])
  )
  && (["models"].contains(resource.service))
};
```

Read-only access to the audit log for an on-call group during one shift (an allow: an owner or admin has to enable it):

```json
{
  "effect": "permit",
  "principals": { "groups": ["6b1f0c52-2f0a-4c1e-9c61-3f0d8a1b7e11"] },
  "actions": ["audit.read"],
  "resources": { "services": ["audit"] },
  "conditions": { "validFrom": "2026-11-02T08:00:00Z", "validUntil": "2026-11-02T16:00:00Z" }
}
```

No writes from tokens that call from a given network:

```json
{
  "effect": "forbid",
  "principals": { "anyToken": true },
  "actions": ["Write"],
  "resources": { "any": true },
  "conditions": { "ipRanges": ["203.0.113.0/24"], "channels": ["api"] }
}
```

`POST /api/iam/policies/compile` returns the Cedar text and the warnings for a draft without saving it, and `POST /api/iam/policies/preview` evaluates a draft against the workspace's people and tokens (up to 1,000 of them, within 5 seconds and 20,000 evaluations) and reports who would flip.

## Check access

The **Access check** tab answers "can this person or token do this, and which rule decides?". Choose a person or token, an action (a service level) and, if you want, a project, channel, IP address and time. The result says allowed or denied and names the deciding rule: a built-in one (a role, a project limit, a token scope) or one of your policies. It does not change anything, so people who may only view the IAM center can use it.

The **Principals** tab lists every person and token with their effective levels, and the **Audit** tab lists denials and policy changes (CSV export included).

### Decision ids

Every refusal carries a **decision id** so that the person who was refused and the person who investigates talk about the same event:

- a `403` from the permission gate has `decisionId` in the body and an `X-Decision-Id` header; OpenAI- and Anthropic-compatible routes put it in `error.decision_id`;
- paste it into the IAM center (**Access check** → decision id), or call `GET /api/iam/decisions/{decisionId}`: you get the audit row and a ready-to-run access check that reproduces the decision, the policies that decided it by name (with whether each is still in force) and, for a portal refusal, the action, the portal or agent and the channel;
- a decision resolves while its audit row is in the 30-day window the Denials feed looks at.

```json
{
  "error": "Forbidden: mcp requires write permission",
  "message": "Forbidden: mcp requires write permission",
  "code": "forbidden",
  "service": "mcp",
  "required": "write",
  "decisionId": "7c0f6b2e-5d1a-4c1e-9a53-0d9b8a1f2e44"
}
```

`error` is the human-readable reason, so a client that only shows `body.error` shows the reason. The same refusal in the OpenAI-compatible dialect is `{"error": {"message": ..., "type": "permission_error", "code": "forbidden", "decision_id": ...}}` and in the Anthropic dialect `{"type": "error", "error": {"type": "permission_error", "message": ..., "decision_id": ...}}`.

## When authorization is unavailable

If the engine cannot decide a request (the person's data cannot be read, the engine fails), the request is **refused**, never allowed and never decided by some other rule set:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 5
X-Decision-Id: 0b6f2c3e-...

{ "error": "Authorization is temporarily unavailable", "code": "authorization_unavailable", "decisionId": "0b6f2c3e-..." }
```

OpenAI-compatible routes answer with `type: "server_error"`, `code: "authorization_unavailable"` and `decision_id`; Anthropic-compatible routes with `type: "api_error"` and `decision_id`. A `503` is not a permission error: clients that retry on `503` (the Console SDK does, and honours `Retry-After`) simply try again. It is counted, logged and written to the audit log (outcome `denied`, `metadata.code: "authorization_unavailable"`, also for `GET`), so it shows up in the Denials feed and resolves through its decision id.

Three safeguards keep that rare:

- **The server will not start without a working engine.** At boot the engine loads Cedar, compiles its schema and the built-in policies and evaluates a few canned decisions. If any step fails the process exits with an explanation instead of serving requests it cannot decide, so a broken installation shows up when you deploy it, not as failing requests.
- **A broken custom statement does not take the workspace down.** A statement that no longer loads is skipped and reported (the engine is `degraded`); the rest of the policy set applies.
- **Readiness reports it.** `GET /api/health/ready` has an `authorization-engine` check: `ok`, `degraded` (requests were refused recently, or statements were skipped) or `down` (the canned decisions fail; the endpoint answers `503`). The check carries the status, the Cedar versions and two facts, no counters. Counters and the policy set of the workspace are in `GET /api/iam/engine/stats`.

### Owner safety

The workspace owner's own signed-in session can always reach the `iam` service, whatever custom policies say and even when the engine is down, so an owner can always repair the policies: sign in as the owner, then disable or delete the rule that locks people out. This is a promise about the owner's *session* only. An API token that belongs to the owner is an ordinary principal, and a policy can restrict it.

## Client address and TRUSTED_PROXIES

Token IP allowlists and the `ip` condition of policies need an address the server can vouch for.

- **`TRUSTED_PROXIES` set** (comma-separated IPs or CIDRs of your reverse proxies or load balancers): the address is the one Fastify resolves through those proxies. The forwarded address counts **only** when the connection comes from a listed proxy, and it is the entry the proxy itself appended; anything a client wrote to its left is ignored.
- **`TRUSTED_PROXIES` unset** (the default): forwarded headers are not used for authorization at all. The connection address is matched, so a caller cannot claim an allowed address. Behind a proxy every caller then looks like the proxy and an IP rule never matches.

Behind a reverse proxy or load balancer, set it:

```bash
TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12
```

The proxy must append the client address to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). `X-Real-IP` and `Forwarded` are never read directly. The IAM center and the token forms warn while it is unset.

## How fresh is a decision

| What changed | Takes effect |
|---|---|
| A person's role, own permissions, group grants (sessions) | On the next request: they are read on every request. |
| A custom policy | At once on the server that saved it, within 5 seconds on the others. |
| Project assignments, and group membership as custom policies and API tokens see it | At once on the server that handled the change; within 15 seconds on the others. |
| A token's scope, expiry or IP allowlist | On the next call on the server that handled the change; within 60 seconds on the others. |

## What policies do not govern

- **Background work.** Scheduled jobs (inference polling, alert evaluation, analysis and red-team runs, knowledge-base ingestion) run without a principal. A policy restricts the person who starts something, not a job that was already scheduled.
- **Realtime connections.** A WebSocket is decided once, when it connects.
- **Public and self-authenticated routes**, by design.
- **Individual resources.** The gates decide on services. A rule about one agent or one model is accepted by the Access check and the preview, but nothing asks it at the gate yet, so the editor refuses a deny of that kind. The exceptions are [portals](#portals): opening one and running an agent through it are decided per portal and per agent; and the [session actions](#sessions-and-approvals) of an agent.

## API

The IAM API is part of the dashboard API: it authenticates with the session cookie, not with an API token. Its service is `iam`: `GET` needs `read`, every change needs `admin`.

| Endpoint | Purpose |
|---|---|
| `GET /api/iam/catalog` | Services, actions, resource types, context attributes and channels. Each action says where a real request is decided on it (`enforcedIn`: `dashboard` and `api` for a service action and for the session actions, `portal` for `portal.use`, `agent.invoke` and `agent.approve` where portals exist); an action without it is only evaluated by the Access check. |
| `GET /api/iam/policies`, `GET /api/iam/policies/{policyId}` | Built-in and custom policies. |
| `POST /api/iam/policies`, `PUT /api/iam/policies/{policyId}`, `DELETE /api/iam/policies/{policyId}` | Create, change (also enable and disable) and delete a custom policy. |
| `POST /api/iam/policies/compile`, `POST /api/iam/policies/preview` | Compile a draft, and see who it would affect. Read-only. |
| `POST /api/iam/simulate` | The Access check. Read-only. For a portal, ask `portal.use` on the resource `{ "kind": "resource", "type": "portal", "id": ... }`, or `agent.invoke` on an agent with `context: { "channel": "portal", "portalId": ... }`; the answer includes the portal's name, mode and the number of people and groups on its list. For a session action (`agent.approve`, `agent.session_view_others`, `agent.session_manage_others`) ask on an agent with `context: { "ownerId": <user who started the session>, "approvers": "owner" \| "owner_or_admin" \| "project_members" }`; the answer includes the session it assumed. |
| `GET /api/iam/decisions/{decisionId}` | A refusal the caller saw, as an access check. |
| `GET /api/iam/principals`, `GET /api/iam/principals/{type}/{id}` | People and tokens with their effective levels. |
| `GET /api/iam/audit`, `GET /api/iam/audit/export` | Denials and policy changes (`kind=denials` or `changes`). |
| `GET /api/iam/settings`, `PUT /api/iam/settings` | Tenant API token rules. |
| `GET /api/iam/engine/stats` | Engine health, decision counters, the workspace's policy set, undeclared routes. |
| `GET /api/auth/session` | Besides the user, `effectivePermissions` (a level per service) and `effectiveProjectId`, which the dashboard menu follows. |

A policy is `{ policyId, name, description, effect, enabled, spec, cedar, statementCount, ... }`. Send `name`, `description`, `enabled` and either `spec` or `cedar`. Errors are `{ error, code, details? }`; `code: "validation"` carries `details` with a `message` and, for Cedar text, a `line` and `col`.

## Related

- [Authentication](/guide/authentication): sign-in, API tokens, expiry rules and IP allowlists.
- [Upgrading to the policy engine](/guide/upgrading-to-the-policy-engine): what changes for an existing installation and how to see it first.
- [Multi-Tenancy](/guide/multi-tenancy): workspaces, projects and members.
- [Health Checks](/guide/core-health): the readiness endpoint.
