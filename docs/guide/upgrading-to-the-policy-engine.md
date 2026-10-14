# Upgrading to the policy engine

From this release on, one policy engine decides every request of every workspace, from the first request. There is nothing to migrate and nothing to switch on. A few answers do change, though, because rules that were stored and shown in earlier releases but never applied now apply. This page says which, shows you how to see exactly who is affected **before** you upgrade, and covers the rollout.

For how access works once you are on this release, see [Authorization](/guide/authorization).

[[toc]]

## What does not change

- Roles, per-user service permissions, group grants and API token scopes mean what they meant. The built-in policies reproduce the previous workspace-level rules exactly. Rows 1 to 4 below depend on your data; where none of them applies, nothing changes.
- Sign-in, API tokens, expiry rules and IP allowlists work as before.
- No stored record is rewritten.

## No data migration

Production data needs no conversion:

- The engine reads the data you already have. Roles, permissions, groups, project assignments and tokens are the inputs of the built-in policies.
- What the engine writes, it writes lazily, through the same document store the rest of the product uses: custom policies when someone creates one, a policy-version counter when a policy changes, and **one small document per workspace** (`iam_meta` / `project_levels_since`) the first time the engine decides a request there. It records the *activation instant* described in [Authorization](/guide/authorization#what-changed-for-older-assignments).
- There are no new indexes. SQLite databases get a few nullable columns added automatically when they are opened (for example the token IP allowlist), as in every release.
- Back up before you upgrade, as you would for any release. A rollback does not need a restore (see [Rolling back](#rolling-back)).

If an environment ran a pre-release build of this feature (a staging system, a design partner), it may contain `iam_*` documents written by an earlier design. They are harmless: workspace modes and counters are no longer read, and a policy stored in a retired "monitor" mode is read as disabled.

## What changes on the first request

| # | What | Who is affected | Direction |
|---|---|---|---|
| 1 | **Project permissions apply.** The level set for a member (or a group) on a project caps the workspace level in that project. A "No access" saved before the upgrade is ignored until its row is saved again. | Members with project service permissions below their workspace level. | Less access |
| 2 | **API tokens include their owner's group grants.** | Unscoped tokens whose owner is in a group that grants a role or service permissions. A scoped token stays capped by its scope. | More access |
| 3 | **Group project assignments open projects.** A member who reaches a project only through a group can open it (it used to answer "No project assigned"), and a member with both kinds of assignment lands in the group's project when asking for it. | Mainly directory-provisioned (LDAP, SSO) members. | More access |
| 4 | **Some surfaces now check a permission.** The model playgrounds (`models` read), the OCR playground (`ocr` read), the agent skills library (`agents`) and, in Enterprise, the prompt optimizer (`prompts`). | Members whose level for that service is `none`. | Less access |
| 5 | **The tenant-wide metrics export (`GET /api/metrics`) refuses tokens with a service scope**, because a per-service cap cannot be honoured on an export that spans every module. | Scrapers that use a scoped token. Use an unscoped token. | Less access |
| 6 | **The dashboard overview hides sections the caller cannot read** (models, vector, tracing), and the menu follows the effective levels in the active project. | Anyone with project limits. | Less visible |
| 7 | **Refusals carry a decision id.** A `403` has `code`, `service`, `required` and `decisionId` and an `X-Decision-Id` header; a route without an authorization declaration is refused with `route_not_declared`. | Clients that parse refusal bodies. | - |
| 8 | **The engine fails closed.** If it cannot decide a request, the answer is `503 authorization_unavailable` with `Retry-After`; it never falls back to another rule set. A server that cannot load the engine does not start. | Operators. | - |
| 9 | **Four new administration services** (`portals`, `resources`, `iam`, `webhooks`) and the IAM center. Owners and admins only, unless granted. | Nobody loses anything. | - |
| 10 | **Agent sessions belong to the person who started them.** Anybody else needs the Agents service at Read to view a session (Write to change it): this now also applies to the agent threads in Tracing and the session files in the Files screens. | Roles that hold Tracing or Files but no `agents` level. Give them `agents` Read, or an allow rule for `agent.session_view_others`, to keep that reach. | Less access |

The preflight report below counts rows 1 to 5.

If you run the Enterprise edition, upgrade to the enterprise build published for this release: its own routes carry their authorization declarations, and a route that has none is refused with `403`.

## Run the preflight report

`scripts/iam/preflight-diff.ts` reads a **copy** of your data and lists, for every workspace, which people, API tokens, projects and services get a different answer from the engine than from the workspace-level rules of the previous release (role, own and group service permissions, token scope; no project permissions, no group grants for tokens). It asks the same engine, through the same functions, that the request gates use, so what it prints is what will happen. It writes nothing to your data.

Run it from the root of the release you are about to deploy (a checkout of the new version, or `/app` in the new image), on a copy of the **current** data. Run it again on a fresh copy right before the upgrade: assignments saved in between are not in the first report.

### 1. Take a copy

**SQLite.** Stop the console, or take a consistent snapshot (`sqlite3 <file> ".backup <copy>"` per database file), and copy the data directory:

```bash
cp -R /var/lib/console/sqlite /srv/preflight/sqlite
```

The report copies the directory a second time into a temporary one and works on that, because the database layer adds columns when it opens a file. The original is never opened.

**MongoDB.** Restore a backup into a throwaway `mongod` on the machine where you run the report. Never point the report at the live cluster: the database layer creates indexes when it connects. A non-local host is refused unless you set `IAM_PREFLIGHT_ALLOW_REMOTE=1`, which you should only do for a throwaway copy.

```bash
mongod --dbpath /srv/preflight/mongo --port 27633 --bind_ip 127.0.0.1 &
mongorestore --uri mongodb://127.0.0.1:27633 ./backup
```

### 2. Run it

```bash
# SQLite
node --import tsx scripts/iam/preflight-diff.ts --sqlite-dir /srv/preflight/sqlite --out ./preflight

# MongoDB (add --single-database if tenant collections live in the main database)
node --import tsx scripts/iam/preflight-diff.ts --mongodb-uri mongodb://127.0.0.1:27633 --main-db console_main --out ./preflight
```

In a container started from the new image (`scripts/` and `tsx` are in it), mount the copy read-only and a writable output directory:

```bash
docker run --rm \
  -v /srv/preflight/sqlite:/preflight/data:ro \
  -v "$PWD/out":/preflight/out \
  your-registry/console:NEW_TAG \
  node --import tsx scripts/iam/preflight-diff.ts --sqlite-dir /preflight/data --out /preflight/out/report
```

The data source is always named on the command line (or in an `IAM_PREFLIGHT_*` variable). The `SQLITE_DATA_DIR` and `MONGODB_URI` of your shell are ignored, so a run started inside a production container cannot read the live database by accident.

It writes `<out>.json` (everything) and `<out>.md` (the same, readable) and prints a summary:

```text
Workspaces 2; people 32; API tokens 20; project contexts 55; decisions compared 6,435
Unchanged 6,348; changed 87 (tighten 20, loosen 67)
  - Project permissions now apply: 10 principals, 20 decisions (tighten 20, loosen 0)
  - API tokens now include the owner's group grants: 4 principals, 67 decisions (tighten 0, loosen 67)
Newly gated surfaces people lose: Agent skills library (create, edit, delete) (3); Prompt optimizer (run, change) (4)
Project access: 2 scenarios gain access through a group, 1 land in a different project
Deferred: 6 principals carry a "No access" that is ignored until its row is saved again (11 entries)
5 tokens carry a service scope and are refused on the tenant-wide metrics export
Integrity: the engine agrees with the rules it is checked against on every decision.
```

### Options

| Option | Meaning |
|---|---|
| `--sqlite-dir <dir>` or `--mongodb-uri <uri>` | The copy to read. Exactly one. |
| `--main-db <name>` | Name of the main database (default `console_main`). |
| `--single-database` | MongoDB: tenant collections live in the main database. |
| `--no-copy` | SQLite: read the directory in place. Only for a directory that is already a throwaway copy. |
| `--tenants a,b` | Only these workspaces (slug or database name). |
| `--max-principals <n>` | At most `n` people and `n` tokens per workspace; those the upgrade is most likely to touch go first. |
| `--out <path>` | Report base name (default `./iam-preflight-report`). |
| `--redact` | Replace emails, names, token labels and project names by hashes, so the report can be shared. `--redact-salt <text>` makes two redacted runs comparable. |
| `--max-listed <n>` | People listed per section of the Markdown (default 100); the JSON has all of them. |
| `--summary-only` | Leave the per-person lists out of the JSON as well. |
| `--since <iso-date-time>` | The activation instant to assume (default: the time of the run). A workspace that already recorded one keeps it. |
| `--verify-all` | Run the attribution checks on every decision, not only on the ones that differ. |
| `--no-memo` | Ask the engine for every single decision. By default people whose levels are identical share one answer, which keeps a large directory to minutes. |
| `--fail-on-differences` | Exit with code 3 when anyone's access changes (for a gate in CI). |
| `--dump <file>` | Diagnostics: every compared decision as a JSON line. |

Every option except `--help` has an `IAM_PREFLIGHT_*` variable (see `--help`). Exit codes: `0` done and consistent; `1` usage or connection error; `2` done, but the engine disagreed with the rules it is checked against (do not rely on that report and contact support); `3` only with `--fail-on-differences`.

### Read the report

The summary and every workspace section show:

| Cause | What it means | What to do |
|---|---|---|
| **Project permissions now apply** | A project assignment (a person's or a group's) carries a level below the workspace level. They lose access to the service in that project. | Decide whether it is what was meant. If not, set the service to **Inherit** before the upgrade. |
| **API tokens now include the owner's group grants** | The token gains what its owner's groups grant. | Replace tokens that must not inherit group grants with scoped ones, or take the owner out of the group. |
| **Surfaces that now check a permission** | People who lose the playgrounds, the skills library or the prompt optimizer. | Give them `read` (or `write`) on the service, or accept it. |
| **Project access** | Members who gain a project through a group, or who land in a different project. | Review the group's project assignments: stale ones go live. |
| **Deferred** | A "No access" that is ignored today and starts to apply when the assignment is next saved. Nobody changes on day one. | Clean up: **No access** where you mean it, **Inherit** elsewhere. |
| **Custom policies** | Only when the copy has custom policies (an environment that ran a pre-release build). The difference may be theirs. | |
| **Integrity** | Only when something is wrong: the engine disagrees with the arithmetic it is checked against. | Contact support with the JSON. |

Each differing decision lists the service and the level before and after (`models: write -> read`), the project, and the cause. The census at the end of a workspace section counts what is stored: project assignments with levels, how many narrow someone, how many carry an ignored "No access", groups, tokens by kind.

The report also checks itself. On every decision the engine's answer is compared with an independent calculation from the stored rows (role, groups, token scope, project levels), and for every decision that differs from the previous release the engine is asked again with the previous release's inputs to find the cause. If the engine and the arithmetic ever disagree, that is reported as an integrity problem instead of being printed as a table you might trust.

::: tip Size and time
Its cost is the engine's, not the database's. A workspace with 3,000 people and 500 tokens (about 1.4 million decisions) took about 4 seconds on a laptop with SQLite, because people whose levels are identical share one answer. A MongoDB copy is bounded by the round trips to the local `mongod`. `--no-memo` and `--verify-all` are the slow paths.
:::

## Prepare

Work through the report before the upgrade, in this order:

1. **Integrity** must be clean.
2. **Project permissions now apply**: for each person listed, open the project's **Project service permissions** screen and confirm or change the level. Anything you set to **Inherit** simply follows the workspace level.
3. **Tokens**: for each token that gains group grants, decide between a scoped replacement and removing the owner from the group. Replace scoped tokens used for the metrics export.
4. **Group-owned projects**: members who gain a project through a group are probably the point of the group, but check the list.
5. **Playgrounds and skills**: members listed under "Surfaces that now check a permission" need `read` on `models`, `ocr` or `prompts`, or `write` on `agents`.
6. **Deferred "No access" entries**: schedule the clean-up for after the upgrade, or do it now.
7. Set **`TRUSTED_PROXIES`** if the console runs behind a reverse proxy or load balancer and you use token IP allowlists or IP rules (see [Authorization](/guide/authorization#client-address-and-trusted-proxies)).

## Roll out

- **A rolling update runs both versions side by side for a few minutes.** A request can be decided by the old code and the next one by the new engine, so one person can see a service disappear and reappear while the update runs. Schedule the update for a quiet period, or drain the old instances first.
- **Do not change permissions while the update runs.** A permission map saved by the old code loses the keys that code does not know (`portals`, `resources`, `iam`, `webhooks`).
- **A server that cannot run the engine does not start.** At boot it loads Cedar, compiles its schema and the built-in policies, and evaluates a few canned decisions; on failure the process exits with the reason. Check the logs of the first upgraded instance before the rest follow.
- **Readiness.** `GET /api/health/ready` includes an `authorization-engine` check: `ok`, `degraded` or `down` (the endpoint answers `503` for `down`). If your orchestrator probes only the TCP port, point the readiness probe at this endpoint.
- **Watch.** In the first hours, look at the **Denials** feed (**IAM center → Audit**) and at `GET /api/iam/engine/stats`: `enforce.unavailable` and `enforce.undeclaredDenies` should stay at 0, and `undeclaredRoutes.count` should be 0.

### Capacity

The engine adds roughly 90 MB of resident memory to each server process (Cedar's WebAssembly runtime; a development process grew from about 112 MB to about 199 MB at its first decision, and production was not measured) and about 80 ms to the first decision of a process. A warm decision takes a fraction of a millisecond. A person's context (groups, project assignments) is loaded once and cached for 15 seconds, which costs a few extra database reads on the first request after the cache expires. Size memory limits accordingly.

## After the upgrade

1. Sign in as people from the report's lists and check what they see. The menu shows what their effective level allows.
2. When someone is refused, ask for the **decision id** (the `decisionId` in the response, or the `X-Decision-Id` header) and open it in the **Access check**: it shows who was refused, what was asked and which rule decided.
3. Compare the Denials feed with the report. Anything denied that the report did not predict is worth a look.
4. Clean up the **Deferred** entries.

## Rolling back

Redeploy the previous release. There is no data to restore and no per-workspace switch back. Two things to know:

- Custom policies created after the upgrade stop applying on the old code, so a deny written after the upgrade vanishes with it.
- A permission map saved by the old code loses the keys that code does not know (`portals`, `resources`, `iam`, `webhooks`); grant them again after the next upgrade if you had set them.

The activation-instant document stays in place and is read again by the next upgrade, so older "No access" entries stay ignored. Assignments saved by the old code while you were rolled back count as saved after the activation instant.

## Questions

**Do I have to write policies?** No. Roles, group grants, project permissions and token scopes already decide everything. Policies are for exceptions.

**Can I turn it off?** No. There is one decision path. That is also why the engine is checked at boot.

**A member lost access after the upgrade.** Open their decision id in the Access check, or look at the person under **Principals**: the effective level of each service is there, with where it comes from (the role, a direct grant, a group, a token scope, a project limit or a policy). Most often it is a project permission (see [Project permissions](/guide/authorization#project-permissions)).

**The server does not start: "Authorization engine self-test failed".** The message says which step failed (loading Cedar, the schema, the built-in policies or a canned decision). Check that the installation has its production dependencies (`@cedar-policy/cedar-wasm`), that the image is the one built for this release, and the log lines before the message.

**Does the report work for a very large installation?** Use `--tenants` to run one workspace at a time and `--max-principals` for a first look. The default sharing of answers between identical people keeps even large workspaces to minutes.
