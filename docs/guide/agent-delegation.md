# Delegation (sub-agents)

An agent can hand a task to a **sub-agent**: a second agent loop that works on the task with its own instructions, tools and model, and sends back one result. The parent's transcript only holds the task and the result, not the fifty tool calls in between. Use it when a task needs its own prompt, its own tool surface, a cheaper model, or a context budget of its own.

Configure it under **Build → Sub-agents**. Delegation is off until you turn it on (or add a sub-agent).

## Two kinds of sub-agent

| Kind | What it is | Where its prompt, model and tools come from |
| --- | --- | --- |
| **Inline** | A role that lives only in this agent. | The entry itself: system prompt, optional model, tool bindings and knowledge engine. |
| **Existing agent** (`ref`) | Another active agent of the same project. | That agent: its prompt (inline text or Prompts-module template), model, tools and knowledge. |

A referenced agent is loaded from its **published version** (or the version you pin), never from its draft, so editing a draft cannot change what a parent delegates to mid-run. An agent that is not active, a connected (external) agent, a missing agent or a pinned version that no longer exists is skipped, and the run reports it (see [run warnings](#run-warnings)). A referenced agent's own sub-agents are not used: nesting is expressed with the depth limit, not by expanding a reference tree.

### What you can override on a referenced agent

These settings of the entry take precedence over the referenced agent's own:

- **Name** and **header** (the orchestrator picks a sub-agent by them),
- **System prompt**: when empty, the child runs the referenced agent's prompt,
- **Model**: when empty, the child runs on the referenced agent's model,
- the child context policy, the run limits and the output schema of the entry.

Everything else (tools, knowledge, variables) stays owned by the referenced agent.

### The prompt a child runs on

A referenced agent runs the prompt its own agent would run on: its Prompts-module template or inline text, rendered with its own prompt variables. Variables it declares take the value the delegating run has for a variable of the same name, else their default; a sub-agent is handed free text, never a set of values, so a required variable without a default that the parent does not declare stays empty (Studio warns about it when you save). A variable of the delegating run that was marked as external content is not placed in the child's prompt. An inline child's prompt is rendered the way the parent's own is (built-in placeholders are filled).

A child with no instructions at all runs as `You are <name>. <header>` and the run reports a warning; write real instructions.

## Policy

| Setting | Meaning | Allowed |
| --- | --- | --- |
| Mode | `off`: no delegation, the roster is ignored. `registry_only`: only the listed sub-agents. `registry_and_adhoc`: the agent may also define short-lived sub-agents at run time. | `off`, `registry_only`, `registry_and_adhoc` |
| Max depth | How deep delegation may nest. | 1 to 5 |
| Max child calls per run | Sub-agent runs one turn may start in total. | 1 to 50 |
| Max parallel | Sub-agents that may run at the same time. | 1 to 16 |
| Child context | What a child is shown besides its task: `minimal` (the task only), `scoped` (the task and the user's latest message), `full` (the task and the whole transcript so far). The task is always sent as its own message and the parent's messages are marked as background. | `minimal`, `scoped`, `full` |
| Ad-hoc children may use the parent's tools | Whether a child defined at run time can borrow the parent's tools. | on / off |

Each sub-agent can override the child context policy and carries its own run limits (`maxToolCalls`, `maxParallelTools`, `maxContextTokens`, `maxTotalOutputTokens`, `maxCostUsd`, `maxWallClockMs`). Saving or importing an agent with a value outside these ranges is refused. An entry that is switched off, or a policy in `off` mode, builds no child, checks no spend limit and prices nothing.

The policy is kept when you save with delegation on, even before the first sub-agent is added.

## Approvals through delegation

A sub-agent's tools are gated like the parent's own:

- an **inline** child follows this agent's [approval settings](/guide/agent-approvals);
- a **referenced** child follows this agent's settings **and** the referenced agent's own: a tool that either side asks about is asked about;
- whether a referenced child may **ask the user a question** is decided by the delegating agent's `askUser` setting only; the referenced agent's own `humanInTheLoop.askUser` is not consulted when it runs as a sub-agent (approvals are different: there either side can gate a tool);
- on a run nobody can answer, the **unattended** setting applies to the child's tools too (denied, paused or allowed as that setting says).

When a child's tool call needs approval, the run pauses like any other. The pending request names the sub-agent (`subagent`, in the pending action, in the `action.required` event and on the approval card), and answering it resumes the child where it stopped. The approver rules (who may answer, the timeout) are the delegating agent's.

Sub-agents that run **in parallel** cannot wait for a person: such a task comes back to the parent as `needs_input`. A question or an approval inside a child is only possible in a sequential delegation.

The guardrails of a referenced agent are **not** applied to the child. The delegating agent's guardrails apply to the child's tool calls as to its own.

## Usage, cost and budgets

Every model call of a child is a normal gateway call: it lands in the usage log on the child's model (route `agent.subagent`), counts toward the tenant's spend limits for that model, and uses that model's pricing. The turn's totals contain the parent's and the children's calls **once** each, and the turn's cost prices each call at the model that ran it, so a cheaper or dearer child is not charged at the main model's rate. A turn whose own model has no price stays unpriced.

A [session budget](/guide/agent-session-budgets) and the per-turn cost limit see a child's spend as soon as it finishes. The spend pre-flight checks the models of the children that can actually run, plus the parent's.

## What the stream and the log show

- A child's **answer text** is never streamed into the parent's answer, and a child's **thinking** is not shown as the turn's reasoning. A child compacting its own context is not recorded as a compaction of the turn.
- The delegation call is a tool call: `delegate_to`, `spawn_subagent` or `spawn_subagents_parallel`. Its `agent.tool_use` / `agent.tool_result` events and its step in Studio name the sub-agent (`subagent`). Tool calls a child makes are forwarded with the same field.
- A delegation whose child failed or was cancelled (and a parallel call where every task failed) is a failed tool call: `ok: false` with the reason. A parallel call where only some tasks failed is a success whose result lists each task's status.

## Run warnings

A child that cannot run, or runs short of what its author set up, never fails the turn. The run's `warnings` (on the message, in the response) say which:

- a sub-agent without a name, or a name used twice (the first wins);
- a referenced agent that is missing, not active, connected (external), or pinned to a version that is gone;
- a model override that is not a chat model of the project or cannot be set up (the child runs on the parent's model);
- a child with no instructions.

## Not supported yet

- **A child's own tool calls in the call row.** The trace shows a child's work as a **Sub-agent** group of its own, with its model calls, tool calls and approvals as steps inside it. The delegation call itself stays one row, and a child that paused for an approval and was approved stays that one group: the pause is recorded with the same span, and the trace draws the latest record only.
- **Re-authorisation of a referenced agent at run time.** Who may use the referenced agent is decided when the entry is saved. At run time the child runs under the delegating agent's identity and does not check the caller's access to the referenced agent again.
- **Version pinning of a paused child.** A child that paused for an approval is not guaranteed to continue on the very definition it paused on if the agent or the referenced agent is edited and published while the request is open.
