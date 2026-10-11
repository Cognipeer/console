# Approvals & questions

An agent can stop and wait for a person. Two things make it stop:

- **A tool approval.** A tool call waits until someone allows or denies it. Useful for tools that change something: a shell command, a write, a call to an external system.
- **A question.** The agent asks the user to choose between options (or type an answer) when it needs a decision it cannot make alone.

The turn is paused, not lost. When the request is answered, the **same turn** carries on from where it stopped: the tool runs (or the model reads the refusal), and the reply arrives as a new assistant message. An agent that does not use these features behaves exactly as before.

## Turning it on

**Configure → Approvals & questions**, per agent. An agent created in Studio starts with tool approval on (every tool asks) and questions off. An agent created through the API starts with neither.

| Setting | Default | What it does |
| --- | --- | --- |
| Let the agent ask the user questions | off | Adds the `ask_user_question` tool. The agent can pause with a structured question and options. |
| Allow free-text answers | on | Besides the offered options, the person can type their own answer. Off: every question must offer options. |
| Ask before tools run | off (on in Studio-created agents) | A tool call waits for approval. |
| Tools not listed below | Always ask | What happens to a tool with no setting of its own. |
| Per-tool settings | none | Override the default for one tool: Default, Always ask, Never ask. The name is the one the model sees. |
| Wait for an answer (minutes) | 1440 | How long a request stays open. `0` = never expires. |
| When time runs out | Deny and continue | **Deny and continue**: the tool is refused (or the question skipped) and the agent carries on in the background. **Cancel the request**: the request is dropped and the session goes back to idle. |
| Who can answer | The session owner and project admins | Only the person who started the session; the owner and project admins; or anyone with access to the agent. This is the input of the **Approve** permission below. |
| A new message while waiting | Reject it | **Reject**: the message is refused (`409 pending_action`) until the request is answered. **Cancel the request and continue**: the pending request is cancelled and the message is processed normally. |
| When nobody can answer | Deny the tool call | See [unattended runs](#unattended-runs). |

### Who may answer: the Approve permission

Approving a **tool call** (allow, deny, edit its arguments, *don't ask again this session*) is a permission of its own, **Agent · Approve tool calls** (`agent.approve`), decided by the same permission engine as everything else (**Authorization** in Settings). It is **appointed**: having Write access to Agents does not approve somebody else's request. By default a built-in rule appoints exactly the people the agent's *Who can answer* setting names:

| Who can answer | Who may |
| --- | --- |
| Only the person who started the session | that person (and their API tokens) |
| The session owner and project admins (default) | the above, workspace owners and admins, and the admins of the agent's project |
| Anyone with access to the agent | the above, and every member of the agent's project |

The person who started the session may always answer, whatever the setting. An API token answers on behalf of its owner, and its own scope and the project's limits still apply. The same rule covers the portals (a portal's access list is checked on top). The setting is read as the agent version the request was raised under, so editing the agent later does not change who may answer a request that is already open; a request of a deleted or disabled agent can still be answered under the same rule.

You can appoint more people, or fewer, in **Authorization → Policies**, with the action *Agent · Approve tool calls*:

- an **allow** policy appoints approvers on top of the setting: a compliance group that approves across projects, an on-call rota. It names the people, not the sessions; combine it with *Resources* to limit it to some agents or projects. The people it names also need the Write level on Agents to reach the answer button (an answer is a `POST`); the editor says so when it applies.
- a **deny** policy narrows: it removes a person, a group, an agent or a channel from the people the setting accepts.

Token scope and the project's own limits still win over any allow policy. A refusal answers `403` with a `decisionId` that **Authorization → Access check** can replay; the check form takes the session's owner and the agent's setting as inputs.

#### What it covers, and what it does not

| | |
| --- | --- |
| Allow or deny a tool call, edit its arguments, *remember for this session* | `agent.approve` |
| End somebody's open **approval** as a side effect: cancelling a run that is paused on it, or sending a new message to an agent that cancels the pending request (*A new message while waiting*) | `agent.approve`: ending an approval is answering it with "no" |
| Answer a **question** | not an approval: it follows the session. The person who started the session may always answer; anybody else needs *Agent · Act on others' sessions* (`agent.session_manage_others`) |
| The timeout sweep and the continuation that follows it | the system's, outside the permission engine; recorded in the audit log as `system` (`system:timeout`) |

Restricting approvals therefore never stops people from answering their own sessions' questions.

#### The page shows what the server decided

The session page and the Sessions list do not guess from the viewer's role: the dashboard sends, with each open request, `canResolve` and, when it is false, `resolveBlockedReason` (`approvers_owner`, `approvers_admin`, `approvers_member`, `session_owner`, `policy`, or `unavailable` when the engine could not be asked). Rows of the Sessions list carry the same for the whole session, so the **Waiting for you** badge is only shown to somebody who could answer. It is a notice, not a lock: the server decides again when the answer is sent. If the engine cannot decide at all, answering returns `503 authorization_unavailable` (with a `decisionId`), never a `403`, and nothing is recorded.

### What is not asked about

Tools that only read are never asked about, unless you set them to *Always ask*: `knowledge_*`, `memory_search`, `sandbox_read_file`, `sandbox_list_files`, `sandbox_preview_link`, `web_search`, `session_files_list`, `session_files_read` and the question tool itself. Everything else Console builds follows the default: bound, MCP and custom tools, memory writes, `sandbox_exec`, `sandbox_run_code`, `sandbox_write_file`.

The agent-sdk's own tools (plan, context, delegation, skills) are never gated. Approvals apply to the agent's own tools; a call made by a sub-agent is not gated, and Studio warns about that when both are set.

## In Studio

A paused turn shows a card on the assistant message.

- **Tool approval:** the tool name and its arguments. **Edit arguments** lets you change them (the JSON is checked against the tool's schema before the tool runs). Add a reason when you deny. **Don't ask again for this tool in this session** allows the tool for the rest of the session.
- **Question:** each question with its options (radio buttons, or checkboxes for a multi-select), a free-text box when allowed, and **Skip**.

Answering continues the turn live, like a normal message. Sessions waiting for you show a **Waiting for you** badge in the session list. While a request is open, the composer follows the *A new message while waiting* setting: it is disabled with a short explanation, or it warns that sending cancels the request.

## Over the API

A paused response has `status: "requires_action"` and the requests in `required_action`:

```json
{
  "id": "resp_6f1c…",
  "object": "response",
  "status": "requires_action",
  "stop_reason": "requires_action",
  "required_action": {
    "type": "agent_actions",
    "actions": [{
      "id": "act_0123456789abcdef01234567",
      "kind": "tool_approval",
      "tool_name": "sandbox_exec",
      "args": { "command": "rm -rf build" },
      "status": "pending",
      "expires_at": "2026-10-02T12:00:00.000Z",
      "requested_at": "2026-10-01T12:00:00.000Z"
    }]
  }
}
```

A question looks the same with `kind: "user_question"`, `questions: [{ question, header?, multi_select?, options: [{ label, value?, description? }] }]` and `allow_free_text`, and no `tool_name` or `args`: those belong to a tool approval only.

Answer it with:

```http
POST /api/client/v1/agents/sessions/{conversationId}/actions/{actionId}
Authorization: Bearer <token>

{ "decision": "allow" }
```

`{conversationId}` is the id inside `resp_{conversationId}`.

| Request | Body |
| --- | --- |
| Approve | `{ "decision": "allow" }` |
| Approve with edited arguments | `{ "decision": "allow", "approved_args": { "command": "rm -rf build/tmp" } }` |
| Deny | `{ "decision": "deny", "comment": "not on prod" }` |
| Approve and stop asking | `{ "decision": "allow", "remember_for_session": true }` |
| Answer a question | `{ "answers": { "Which environment?": "staging" } }` (a list of values for a multi-select) |
| Skip a question | `{ "cancelled": true }` |

`approved_args` has to be a JSON object that satisfies the tool's schema, or the call is refused with `400` and the request stays open. Tool guardrails still apply when the tool runs.

The turn continues inline and the answer is a normal response (`completed`, or `requires_action` again if it paused again). With several requests in one pause, each answer returns `requires_action` with the ones still open until the last is answered. Add `"background": true` (or the `X-Cognipeer-Background: true` header) to continue as a [background run](/guide/agent-background-execution) and get `202` with the run.

| Status | Meaning |
| --- | --- |
| `403` | The caller may not answer this request: a tool approval needs **Approve tool calls** (the agent's *Who can answer* setting, any allow policy that appoints them, and any deny policy); a question follows the session's ownership. `action_forbidden`, with a `decision_id`. |
| `503` | The permission engine could not decide who may answer (`authorization_unavailable`, with a `decision_id`). Nothing was recorded: retry. |
| `404` | No such session or request in this project. |
| `409` | Someone answered first (`action_not_pending`, with `action_status`), the request was cancelled meanwhile — a new message, a cancelled run, the timeout policy (`action_cancelled`) — or another run is active for the conversation. |
| `410` | The request ran out of time (`action_expired`). |

The three codes are told apart on purpose: a client that shows the request can say *Answered*, *Cancelled* or *Expired* instead of guessing.

You can also read what a session is waiting on at any time with `GET /api/client/v1/agents/sessions/{conversationId}` ([session events](/guide/agent-session-events)), and a `requires_action` webhook (`action.required`) tells you without polling ([webhooks](/guide/webhooks)).

### Background runs and A2A

A background run that pauses has the non-terminal status `requires_action`; its `result` carries the same `required_action`, and the `agent_run.requires_action` callback and webhook fire. Answering queues the same run again; it finishes as usual. Cancelling a paused run ends it and drops its open requests. Clients that poll until a terminal status should stop on `requires_action` too, or they wait for a person.

Over A2A, a paused task reports the state `input-required` with the requests in `metadata.pendingActions`. Unless the agent cancels the pending request on a new message, a `message/send` to a conversation that is still waiting is refused, with the ids to answer in the error's `data.pending_action_ids`. `tasks/cancel` is not supported (`-32004`): a turn runs inside the `message/send` call, so there is nothing to stop. A task that waits on a person is ended by answering its requests through the actions endpoint above (deny an approval, or answer a question with `cancelled: true`); the error of `tasks/cancel` on such a task lists the ids. A caller who may not answer those requests gets the JSON-RPC error `-32010` (with a `decision_id`) from `tasks/cancel` on such a task, and from a `message/send` that would cancel the request.

## Unattended runs

Some runs have nobody to answer: schedules, evaluations and red-team cases, and the OpenAI-shaped and Assistants endpoints, which have no way to send an answer. The *When nobody can answer* setting decides what a gated tool does there:

- **Deny the tool call** (default): the tool does not run, the model is told no approver is available and the run goes on. Questions are not asked.
- **Pause and wait for approval in Studio:** behaves like an attended run; the request waits in the session until someone answers it.
- **Run without approval:** the tool runs. An explicit opt-in for agents whose owner accepts that.

A stateless call with no session has nowhere to keep a paused turn, so the same rule applies to it.

## Timeouts and audit

Open requests are checked about every 30 seconds. Past the time you set, the agent's *When time runs out* setting applies, and the answer is recorded as given by `system:timeout`: that is the system, not a person, so it is outside the permission engine and the audit log records it with the actor type `system` (`agent.tool_approval.timeout`). Every answer a person gives is written to the audit log (who, what, the decision, and whether the arguments were edited), and appears in the [session events](/guide/agent-session-events) as `action.resolved`.
