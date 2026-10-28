# Agent Templates

An **agent template** is a ready-made agent you can turn into a real, editable draft in your project with one form. The catalog ships with the console (25 templates, versioned), so it works the same in the SaaS and on-premises editions and needs no network access. Templates are a starting point: the agent you get is an ordinary agent that you adapt like any other.

Open it from **Agents → Templates** (also in the **New agent** menu and on the empty Agents page).

## The gallery

The gallery lists every template as a card with its category, the capabilities it uses (knowledge, web search, client tools, approvals, sub-agents, skills, structured output, variables, schedule, webhook, sandbox, guardrails) and an availability badge. Filter by category or capability, or search by name. Featured templates (marked with `*` in the table below) are listed first. Selecting a card opens a detail drawer with the description, use cases, the instructions, tools and triggers the template brings, and a suggested first message to try.

### Availability

Availability is read from your project, so a template never promises something the project cannot give:

| State | Meaning |
|---|---|
| **Ready** | The agent can be created and used as it is. Optional parts that are missing (a knowledge base, a web search provider) show as warnings. |
| **Needs setup** | The project lacks something the template relies on: a chat model, or a required knowledge engine or web search provider. The form explains what to add. An agent can still be created without a knowledge base or web search provider, but it cannot do its job until you add one. |
| **Unavailable** | The template needs the [sandbox](/guide/sandbox) and this edition or license does not include it. |

## What "Use template" creates

The **Use template** form is a full-screen form. You pick:

- **Name and key** (optional). The key defaults to the template key; if it is taken, `-2`, `-3` and so on are added. A key you type yourself is refused with `409 agent_key_conflict` when it exists.
- **Model**: any chat model of the project. The template only suggests a class (fast, balanced or reasoning).
- **Knowledge bases** for templates that use them. The agent is created without one if you pick none, and says so in the setup notes.
- **Guardrails**, recommended for templates that handle personal data.
- **Sandbox template**, for templates that need the sandbox (the default is `multi-base` when your tenant has it).
- **Create the suggested triggers**, and the **timezone** their schedules use (your browser's timezone by default). A template with connector triggers also asks for the **connector** they listen to (see [below](#connector-triggered-templates)).
- **Publish version 1** right away. Off by default.

Creating is all-or-nothing. The console creates:

1. A **draft agent**, with the instructions, tools, variables and structured output of the template, your model and picks, and a small mark of which template and version it came from.
2. The template's **skills**, if it has any, under keys that start with `tpl-` (for example `tpl-support-tone`). A skill that already exists under that key is reused as it is, so edits you made to it are kept; a missing one is created.
3. The template's suggested **[triggers](/guide/agent-triggers)**, if you left that on. They are always created **disabled** (a schedule does not run and a webhook does not accept deliveries until you enable them). Schedules use the timezone you chose. A connector trigger that has no connector to listen to is left out ([below](#connector-triggered-templates)).
4. For a **webhook** trigger, the URL and the **signing secret**. The secret is shown **once**, on the result screen; afterwards only its last four characters are visible (you can rotate it on the trigger). The same goes for a connector trigger whose hook has to be set up by hand at the service: its callback URL and secret.

If any step fails, the agent, triggers and skills this call created are removed again and nothing is left behind. Publishing is the last step, so a failed publish also leaves nothing behind.

The result screen lists what is left to do: bind a knowledge base, add a web search provider, enable the triggers, publish, or connect the client tools (see below).

### Client tools

Some templates (Customer Support, IT Helpdesk, Refund Approval) declare **client tools** with an [approval](/guide/agent-approvals). The agent asks *your application* to run the tool (such as `create_ticket`) and waits for the result. Such an agent works where a session can pause: the API or SDK with a session, an embedded chat or a portal. In the Studio playground you answer the call yourself. Connect the tool in your app before going live.

### Webhook-triggered templates

Webhook templates (PR Reviewer, CI Failure Triage, Support Ticket Triage, Lead Qualifier, Email Triage) read the event from the message the trigger builds. Values taken from a webhook delivery reach the model only in the message, marked as external data; they are not placed in the system prompt.

### Connector-triggered templates

PR Reviewer and CI Failure Triage listen to GitHub through the **GitHub connector** (package `cognipeer.github`): a pull request opened, reopened, updated or marked ready for review, or a workflow run that completed. They replace the GitHub webhook preset of earlier releases (see [agent triggers](/guide/agent-triggers#vendor-presets-were-retired)). A connector trigger needs the Enterprise **Connectors** module and a connector of that package in the project.

- The form lists the project's active connectors of the package. With exactly one, it is picked for you; with several, you choose; you can also clear it.
- Under the connector the form asks for what the package's trigger needs and no template can know: the GitHub triggers need the **repository** to listen to (`owner/name`, chosen from the connector's repositories). Leave a required setting empty and that trigger is **not created**.
- The templates filter and read the event on the package's own event data (`payload.draft`, `payload.number`, `payload.repository` as `owner/name` ...), not GitHub's raw webhook body; the data of the events is in [agent triggers](/guide/agent-triggers#connector-triggers).
- With no connector (or without the module) the form says so, and the connector triggers are **not created**. The agent is still created, and the result screen names the triggers that were left out and why: no connector, a setting the trigger still needs, or a setting the connector refused. Add a connector or the missing setting, then add the trigger from the agent's Triggers tab, or use the template again.
- Created connector triggers are disabled like the others. Enable them after checking the connector's subscription on the trigger.
- The capability chip **Webhook** in the gallery stands for generic webhooks and connector events alike.

## The catalog

`*` marks a featured template.

| Template | Key | Category | Capabilities | Needs | Suggested triggers |
|---|---|---|---|---|---|
| Customer Support Agent * | `customer-support` | Support | Knowledge, Ask the user, Client tools, Approval, Skills, Variables, Guardrails | knowledge (optional), guardrails (recommended) | - |
| Support Ticket Triage | `support-triage` | Support | Structured output, Variables, Webhook | - | webhook (generic) |
| IT Helpdesk Assistant * | `it-helpdesk` | Support | Knowledge, Ask the user, Client tools, Approval, Variables | knowledge (optional) | - |
| Refund Approval Assistant | `refund-approval` | Support | Client tools, Approval, Variables | - | - |
| Knowledge Q&A * | `knowledge-qa` | Knowledge | Knowledge, Variables | knowledge (required) | - |
| HR Policy Assistant | `hr-policy-assistant` | Knowledge | Knowledge, Guardrails, Variables | knowledge (required), guardrails (recommended) | - |
| Pull Request Reviewer * | `pr-reviewer` | Engineering | Webhook, Structured output, Skills, Variables | - | connector (GitHub `pull_request`) |
| CI Failure Triage | `ci-failure-triage` | Engineering | Webhook, Structured output | - | connector (GitHub `workflow_run`), webhook (generic) |
| Release Notes Writer | `release-notes-writer` | Engineering | Variables | - | - |
| Incident Postmortem | `incident-postmortem` | Engineering | Variables | - | - |
| SQL Assistant | `sql-assistant` | Engineering | Variables | - | - |
| Deep Research * | `deep-research` | Research | Web search, Sub-agents | web search (required) | - |
| Competitor Monitor | `competitor-monitor` | Research | Web search, Variables, Schedule | web search (required) | schedule `0 9 * * 1` |
| Daily Briefing * | `daily-briefing` | Research | Web search, Variables, Schedule | web search (required) | schedule `0 8 * * 1-5` |
| Data Analyst | `data-analyst` | Research | Sandbox | sandbox (required) | - |
| Lead Qualifier * | `lead-qualifier` | Sales and marketing | Web search, Variables, Structured output, Webhook | web search (optional) | webhook (generic) |
| Meeting Prep | `meeting-prep` | Sales and marketing | Web search, Variables | web search (optional) | - |
| Content writer | `content-writer` | Sales and marketing | Variables | - | - |
| Content repurposer | `content-repurposer` | Sales and marketing | Structured output, Variables | - | - |
| Meeting notes * | `meeting-notes` | Operations | Structured output | - | - |
| Email triage | `email-triage` | Operations | Structured output, Webhook | - | webhook (generic) |
| Document extractor | `document-extractor` | Operations | Structured output, Variables | - | - |
| Contract reviewer | `contract-reviewer` | Operations | Structured output, Skills | - | - |
| Translator | `translator` | Operations | Variables | - | - |
| Support Router * | `support-router` | Multi-agent | Sub-agents, Knowledge | knowledge (optional) | - |

Categories: Support, Knowledge, Engineering, Research, Sales and marketing, Operations, Multi-agent. The Deep Research and Support Router templates create sub-agents inline in the same agent (one agent is created, not several).

## Adapting the agent

The created agent is a normal draft:

- Open it in the Studio and edit the instructions, model, tools, [variables](/api/agents#variables) or structured output. Nothing is locked, and the agent does not change when the catalog changes (a later catalog version does not update agents you already created).
- Edit or delete the `tpl-` skills, or add your own.
- Add knowledge, web search, MCP servers or more triggers from the agent's Build and Ship tabs.
- Test with the playground (the detail drawer suggests a first message), then publish. API calls, triggers and A2A run the **published** version.
- To reuse your tuned agent elsewhere, export it as a manifest (`GET /api/agents/{agentId}/export`) and import it into another project.

## API

The dashboard API (session authentication, in the active project) has three routes. They are part of the Studio and are not on the client API (`/api/client/v1`).

| Route | Permission | Purpose |
|---|---|---|
| `GET /api/agents/templates` | `agents` read | The catalog with the availability of each template in the project |
| `GET /api/agents/templates/{templateKey}` | `agents` read | One template in full: spec, skills, suggested triggers, first message |
| `POST /api/agents/templates/{templateKey}/instantiate` | `agents` write | Create the agent. Body: `modelKey` (required), `name`, `description`, `key`, `knowledgeKeys`, `guardrailKeys`, `sandboxTemplateKey`, `createTriggers` (default `true`), `timezone` (IANA, default `UTC`), `publish` (default `false`), `connector_id` (the connector every connector trigger of the template listens to), `connector_ids` (a connector per suggested trigger, by the trigger's name in the template; wins over `connector_id`), `connector_params` (the parameters of each connector trigger, by the trigger's name: `{ "Review pull requests": { "repository": "acme/api" } }`; empty values count as not given, a name that is not a connector trigger of the template is ignored) |

`instantiate` answers `201` with `agent`, `template` (`key`, `version`, `catalogVersion`), `triggers` (disabled; a webhook trigger carries `webhook.url` and `webhook.secret` once; a connector trigger carries `connector: { connectorId, trigger, subscription }`, the subscription holding the callback URL and, once, the secret when the hook is set up by hand), `skipped_triggers` (`[{ name, reason, package, errors? }]`: connector triggers left out. `reason` is `connector_required` (no usable connector was given, or the Connectors module is absent), `params_required` (a connector was given but the trigger needs parameters, such as a `repository`, that were not) or `invalid_params` (the connector refused the parameters, events or schedule); for the last two `errors` lists the connector's field errors, for example `{ "field": "connector.params.repository", "message": "repository is required" }`. A refusal about the template's own trigger (its prompt, variables or filter) is not skipped: it fails the create with `invalid_template_trigger` and nothing is made), `setup` (what is left to do) and `warnings` (the notes a Studio save would show). Errors use the usual `{ error, code }` shape: `template_not_found` (404), `invalid_model`, `knowledge_not_found`, `knowledge_not_supported`, `guardrail_not_found`, `invalid_timezone`, `invalid_key`, `invalid_template_config`, `invalid_template_trigger` (400), `agent_key_conflict` and `sandbox_unavailable` (409).

## Related

- [Agent triggers](/guide/agent-triggers), [Approvals & questions](/guide/agent-approvals), [Agent runs](/guide/agent-background-execution)
- [Agents API](/api/agents) and [variables](/api/agents#variables)
