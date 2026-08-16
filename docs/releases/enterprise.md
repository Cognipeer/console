# Enterprise releases

June 2026 – present. The `vX.Y.Z-saas` sequence.

Enterprise releases layer the enterprise modules onto an already-released
community tag, so every enterprise build also contains the community changes up
to its pinned version. What follows is the enterprise-only half — the modules
that do not ship in the community edition.

::: tip Where the community changes are
Everything listed on the [1.2](/releases/1.2), [1.1](/releases/1.1) and
[1.0](/releases/1.0) pages is present in enterprise builds too, from the release
that pins that community tag onward.
:::

Because the enterprise sequence ran on its own version count until August 2026,
these notes are grouped by module and dated, rather than listed one tag at a
time. Tags that carried only packaging or pipeline changes are not listed.

[[toc]]

## Cost & Optimization

*August 2026*

**The module moved here in full.** Spend attribution, the Analysis workbench,
automated Prescriptions, the pricing catalog and Reports had been shipping in
the community edition. They are enterprise, and the code moved with them —
see the [community release note](/releases/1.2#v1-2-25-community) for what a
community installation sees now.

The same release fixed five things across the module: Prescriptions no longer
uses the word "Analysis" for itself, prescription narratives render as markdown
rather than as a wall of preformatted text, Reports can be focused on a single
model or agent, Analysis stopped prescribing an SDK upgrade to people who trace
through something else, and badge clusters in dense tables wrap instead of
ellipsising their labels down to two characters.

**Model-switch recommendations, parity tests and the model matrix.** The
predictive half of [Cost & Optimization](/guide/cost-optimization): given the
traffic Console has recorded, which model would be cheaper or faster for this
workload, and does it actually hold up.

- **Recommendations** replay observed token usage against candidate models and
  project the cost difference, filtered by what the workload actually demands —
  a recommendation is not offered for a workload whose language coverage or tool
  complexity the candidate does not support.
- **Parity tests** take that projection and test it. A sample of real traffic is
  replayed against the candidate and scored, so the decision rests on a measured
  pass rate rather than on price arithmetic.
- **The model matrix** runs several candidates over the same sample at once and
  puts the results side by side.

Every `/api/abacus/*`, `/api/cost/*` and `/api/prescriptions/*` route is licence
gated per tenant.

## Prompt Optimizer

*August 2026*

The module has shipped since June; this round is about making its numbers mean
something you can act on.

**It can optimize a prompt it was never given.** A run's base prompt no longer
has to be an entity in the Prompts module. Point the optimizer at a dataset
captured from live traffic and it lifts the production system prompt out of the
items themselves — grouping on a normalized key so per-request values (dates,
session ids, names) do not make every copy look unique, then returning the most
common raw version. The run records how much of the captured traffic agreed, and
warns when the corpus mixed several prompts.

**It optimizes for length and cache-prefix stability, not only quality.** Three
independent axes, each scorable on its own: answer quality (judge or reference),
prompt length, and whether the prompt's cacheable prefix stays byte-stable
across requests. Whenever length or cache is being optimized, quality is still
measured as a **regression floor** — a candidate that saves 40% of the tokens
and quietly answers worse never enters the beam.

**Two checks that stop a shorter prompt from being a worse one.** *Coverage*
tracks the load-bearing identifiers of the original prompt — tool names, section
headers, qualifiers — and rejects a candidate that dropped a capability rather
than a word. *Invention* flags identifiers the candidate made up, and values it
copied out of the test data, which is how an "improved" prompt ends up
hard-coding an answer from the evaluation set.

**Runs are auditable per item.** Each candidate records what happened to every
dataset item — the question, the expected and actual output, expected and actual
tool calls, per-scorer breakdown — plus the exact critique handed back to the
generator. A score without that is an unexplainable number.

**Grading is derived from the dataset, not chosen by hand.** The run states why
it scored the way it did: reference similarity when the items carry a gold
answer, tool-call trajectory when they carry recorded calls, assertions when
they carry them, and an LLM judge only when there is nothing to compare against
— which the run says out loud, because that score is opinion rather than
measurement.

**Candidates now run under the contract production runs under.** With no
`response_format` configured, a run inherits the structured-output contract the
captured traffic actually used, and records which contract it used and where it
came from. Optimizing a prompt under a looser contract than production measures
the wrong system: a candidate that only produces valid JSON because nothing
enforced it fails the moment it goes live.

::: warning On-prem fix: run provenance was blank
Two fields the optimizer writes back onto a run — the base-prompt provenance and
the scoring plan — were persisted on MongoDB and silently dropped on SQLite,
which has a column per field. Every SQLite installation therefore saw an empty
"How this run is scored" block and no provenance, while the same build showed
both in the cloud. Both are now stored on both backends, with a parity test
covering every field the loop writes back.
:::

## MCP Hubs

*July 2026*

**Curated catalogs of MCP servers.** A tenant can publish a set of MCP servers
as a hub and let people discover them, either publicly or behind a token. Hubs
support multiple source types — OpenAPI specs, remote servers and stdio servers
— with a secret vault for upstream credentials and per-exposure authentication.

Sandbox-backed MCP execution and the Aegis policy hook run under the enterprise
licence.

## Aegis

*July 2026*

**A policy enforcement plane.** Aegis evaluates traffic against policy and acts
on it, rather than only reporting after the fact.

- Policy persistence and an enforcement service.
- An **LLM judge** for policy decisions that cannot be expressed as a pattern.
- **Semantic DLP** — data-loss detection that catches a paraphrase, not only a
  literal match.
- **Red-team probes** aimed at the policies themselves, so you can check that a
  policy holds before trusting it.
- A dashboard for all of it.

## GPU Fleet

*July 2026*

Managing your own GPU hosts and the models deployed onto them. See the
[GPU Fleet guide](/guide/gpu-fleet/overview).

- **Host agent lifecycle** — build-time agent versioning so you can see which
  version a host is running, a reinstall flow that generates the command for
  you, and the agent bundle baked into the enterprise image so hosts do not
  fetch it from elsewhere.
- **GPU metrics collection** — utilization and memory per GPU, per host.
- **Ollama support** — pulling models onto a host and health-checking them.
- **Hugging Face token management** in fleet settings, for gated model weights.
- Bulk model deployment from the model list, and a deployment timeline.
- Sensitive environment variables are redacted from deployment API responses.
- Model Hub records created by a deployment are assigned to a project, instead
  of being left unscoped.

## Realtime

*June – July 2026*

Realtime voice and chat, as an enterprise module.

- **Socket-level barge-in** — the model stops speaking the moment the user
  starts, handled at the socket rather than after a turn completes.
- **Tool-call progress events** during a realtime turn, with a configurable
  spoken filler so the caller is not left in silence while a tool runs.
- **Session-scoped runtime context** — the caller's downstream authorization is
  carried into tool calls made during a realtime session.
- A per-model detail page, and status editing.
- Agent presets are locked at session start, so a session cannot change
  behaviour underneath itself; a voice-first playground for trying it.

A partial-update defect was fixed along the way: writing a partial update with
undefined fields was wiping stored values rather than leaving them alone.

## Reports

*July 2026*

**Service usage reports.** A dashboard overview across services with per-service
detail — request volume, latency percentiles and top items. The underlying
engine became configuration-driven, replacing a hand-written descriptor per
report.

## Agent Sandbox

*June – July 2026*

The largest enterprise thread of the summer. See the
[Agent Sandbox guide](/guide/sandbox).

### Execution model

The sandbox originally ran an agent process inside each container to carry out
commands. That was removed entirely in favour of talking to the container
runtime directly — fewer moving parts, and no in-container process to crash,
version-skew or be exploited.

### Capabilities

- **Snapshot, fork and persist** — freeze a sandbox, branch from it, or keep it
  across restarts.
- **Volumes with file APIs**, backed by object storage.
- **Network blocking** per sandbox.
- **Warm pools** — pre-started sandboxes so a launch does not wait for a cold
  start, with per-launch CPU, memory and disk sizing and cleanup of ephemeral
  instances.
- **Port preview** — reach a service running inside a sandbox without an ingress
  controller, through a proxy with signed share links. Later extended to *any*
  port via on-demand forwarders plus detection of which ports are actually
  listening, and per-sandbox controls for whether preview is on at all and
  whether it is public or private.
- **An instance detail page** — overview, metrics, terminal and filesystem.
- Instances are scoped to the active project.
- A client SDK, quotas, networking controls and metrics.

### Reliability

Several of these were production incidents, and are worth reading if you operate
a fleet of sandboxes.

- **Bounded boot reconciliation.** On restart, the service redrove every sandbox
  that was marked running — without limit. On a large tenant that exhausted the
  container runtime's kernel keyring and no container could start at all.
  Reconciliation is now bounded.
- **Snapshot image garbage collection.** Orphaned snapshot images accumulated
  with nothing to remove them until the disk filled. Images are now collected,
  and per-instance backup snapshots are capped.
- **Warm-pool backoff.** A pool whose template could not build retried in a
  tight loop across every tenant, generating enough database load to starve
  everything else. Failures now back off, and orphans are cleaned up.
- **Self-heal after restart** — the base image is rebuilt automatically if it is
  missing.
- **Tenant isolation** for the client API and playground paths, and commands run
  through a login shell so tools installed on the image are actually on `PATH`.
- The preview proxy re-roots absolute asset URLs and rewrites HTML even when the
  upstream compresses its response.
- Instance list filtering moved server-side, and failed rows are collected.

## LDAP and SSO

*June 2026*

**Directory integration.** LDAP authentication as an enterprise module, with
directory groups synchronized to Console groups at login — so group membership
managed in the directory takes effect on the next sign-in rather than needing to
be mirrored by hand.

This builds on the external authentication seam in the community edition, which
is what lets a directory provider be attached without forking the login flow.
