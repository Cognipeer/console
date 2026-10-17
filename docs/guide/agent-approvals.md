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
| Answer a **question** | not an approval: it follows the session. The person who started the session may always answer; anybody else needs *Agent · Act on others' sessions* (`agent.session_manage_others`) and *Agent · View others' sessions* (`agent.session_view_others`) |
| The timeout sweep and the continuation that follows it | the system's, outside the permission engine; recorded in the audit log as `system` (`system:timeout`) |

Restricting approvals therefore never stops people from answering their own sessions' questions.

#### The page shows what the server decided

The session page and the Sessions list do not guess from the viewer's role: the dashboard sends, with each open request, `canResolve` and, when it is false, `resolveBlockedReason` (`approvers_owner`, `approvers_admin`, `approvers_member`, `session_owner`, `policy`, or `unavailable` when the engine could not be asked). Rows of the Sessions list carry the same for the whole session, so the **Waiting for you** badge (and the status filter of that name) is only shown to somebody who could answer; everybody else sees **Waiting for an approver**, in the session header, the side panel, the drawer and the composer. For a request the viewer may not answer the cards say why and their controls (**Approve**, **Deny**, **Edit arguments**, **Don't ask again**, or **Send** and **Skip** for a question) are disabled. When the server could not check (`unavailable`) the notice is shown and the controls stay usable: that is no "no". The server decides again when the answer is sent either way. If the engine cannot decide at all, answering returns `503 authorization_unavailable` (with a `decisionId`), never a `403`, and nothing is recorded.

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
| Answer a client tool | `{ "output": { "text": "…" } }` (any JSON, at most 64 KB), or `{ "error": "nothing is selected" }` when the page could not do it |

`approved_args` has to be a JSON object that satisfies the tool's schema, or the call is refused with `400` and the request stays open. Tool guardrails still apply when the tool runs.

The turn continues inline and the answer is a normal response (`completed`, or `requires_action` again if it paused again). With several requests in one pause, each answer returns `requires_action` with the ones still open until the last is answered. The response `id` is `resp_<runId>` of the **run that paused** (for the answer that leaves other requests open and for the one that continues the turn alike), so `GET /responses/{id}` reads it, the run's [events](/guide/agent-session-events) cover the continuation and the run is settled by it. Only a pause that no run owns (one raised on the dashboard) keeps an id built from the session, and its continuation gets a new run. Add `"background": true` (or the `X-Cognipeer-Background: true` header) to continue as a [background run](/guide/agent-background-execution) and get `202` with the run.

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

A background run that pauses has the non-terminal status `requires_action`; its `result` carries the same `required_action`, and the `agent_run.requires_action` callback and webhook fire. Answering queues the same run again; it finishes as usual. Cancelling a paused run ends it and drops its open requests. A pause that is dropped any other way ends its run the same way: a new message to an agent set to *cancel pending requests*, a session truncate, and the *cancel* choice of the timeout policy all finish the run as `canceled` (reason `canceled_by_caller`) and send its callback and the `agent_run.canceled` webhook event; the run no longer stays `requires_action` for good. Clients that poll until a terminal status should stop on `requires_action` too, or they wait for a person.

Over A2A, a paused task reports the state `input-required` with the requests in `metadata.pendingActions`. Unless the agent cancels the pending request on a new message, a `message/send` to a conversation that is still waiting is refused, with the ids to answer in the error's `data.pending_action_ids`.

`tasks/cancel` (`{ "id": "run_…" }`) works on a task in any non-final state: a task that is still running stops before its next step, and a task that waits on a person is ended and its open approvals and questions are cancelled, the same as cancelling the run on the [runs API](/guide/agent-background-execution#cancel). Ending an approval is answering it "no", so a caller who may not answer those requests gets the JSON-RPC error `-32010` (with a `decision_id`) from `tasks/cancel` on such a task, and from a `message/send` that would cancel the request. A task that cannot be canceled (it already finished, or it is not running) answers `-32002` (`TaskNotCancelable`; it was `-32004` before). You can also deny an approval, or answer a question with `cancelled: true`, through the actions endpoint above.

## Client tools (`client_tool`)

A client tool is a tool the agent calls but **its caller runs** — read what is selected on a page, look an order up in the customer's own system, open a record — without any server-side connector. The author declares them on the agent: *Build → Configure → Client tools* (`config.clientTools`), each with a name, a description, an input schema and a timeout. Whether a call waits for a person is **not** set there: the tools appear in this section's per-tool table (as `client`) and follow *Ask before tools run* and the per-tool setting like any other tool. A tool can be switched off without deleting it.

Where the tools are offered is explicit. *Configure → Client tools → Where these tools are offered* has one switch per surface, all on by default:

| Surface (switch) | Who runs the call | How the caller learns about it | How it answers |
| --- | --- | --- | --- |
| **API and webhooks** (`api`): sessions, `/agents/responses`, background runs | An API client, or whatever receives the callback or webhook | `requires_action` response with the call in `required_action`; the session event stream (`action.required`); for a background run the `requires_action` callback and the `action.required` webhook | `POST /api/client/v1/agents/sessions/{id}/actions/{actionId}` with `{ "output": … }` or `{ "error": "…" }`, under its own API token |
| **API: OpenAI chat completions** (`api`, `model: "agent:<key>"`) | The OpenAI-style client | The reply is an assistant message with `tool_calls` (`finish_reason: "tool_calls"`, `id` = the call's id, plus `conversation_id`) | Send the next request with `conversation_id` and a `tool` message: `{ "role": "tool", "tool_call_id": "<id>", "content": "<result>" }` (`"is_error": true` reports the tool failing). Same authorization as the actions endpoint |
| **Dashboard playground** (`playground`) | The person testing | The call waits on its card | Type the result on the card, give up, or let an external system answer through the API |
| **Portal embedded in a page** (`portal`) | The page that embeds the portal | The frame posts `cp:tool_call` | The host answers with `cp:tool_result` |

**Never offered anywhere else**: A2A, MCP, realtime, triggers, evaluations and red-team cases, a portal chat that is not embedded in a page, and a call without a session to pause (the response carries a warning). On the chat completions wire nobody can answer an approval, so a client tool that the approval policy would ask about is only offered when *When nobody can answer* is *Run without approval* — and then it runs without asking.

An embedded portal can also declare tools of its own for its page. Where both name the same tool, the agent's declaration wins.

::: warning What a caller returns is user input
Whoever answers decides the result: a person's browser, or a backend that forwards what it was given. A tool such as `get_user_role` or `get_order_total` lets that party steer an agent that believes the value. **Do not let a client tool's result carry an authorization decision**: take identity, roles and permissions from the signed identity of the session and from server-side tools, never from a client tool.

The console helps, but it cannot make the value true: the description the model sees says the result is untrusted, every result reaches the model behind a one-line notice saying so, the arguments are checked against the declared schema and the result against the 64 KB limit, and the agent's guardrails screen it like any tool result.
:::

A call pauses the turn like an approval, as a pending action of kind `client_tool`:

```json
{
  "id": "act_0123456789abcdef01234567",
  "kind": "client_tool",
  "tool_name": "get_selection",
  "args": { "max": 100 },
  "timeout_seconds": 30,
  "status": "pending",
  "expires_at": "2026-10-11T12:00:45.000Z"
}
```

### From an API client

```js
// The agent declares `lookup_order`. Start (or continue) a session, then answer the call.
const base = 'https://console.example.com/api/client/v1';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

let res = await (await fetch(`${base}/agents/responses`, {
  method: 'POST', headers,
  body: JSON.stringify({ agent: 'support', session_id: sessionId, input: 'Where is order A-1?' }),
})).json();

while (res.status === 'requires_action') {
  for (const action of res.required_action.actions.filter((a) => a.kind === 'client_tool')) {
    let answer;
    try { answer = { output: await tools[action.tool_name](action.args) }; }
    catch (e) { answer = { error: String(e.message) }; }
    res = await (await fetch(`${base}/agents/sessions/${conversationId}/actions/${action.id}`, {
      method: 'POST', headers, body: JSON.stringify(answer),
    })).json();   // the turn continues; a further call comes back as requires_action again
  }
}
```

With `"background": true` (or a [callback](/guide/agent-background-execution#callbacks-and-webhooks), the agent's default one under *Configure → Callback & budget* included) nothing waits on the connection: the `requires_action` callback and the `action.required` webhook carry the same `required_action`, and the receiver answers on the same endpoint. A background run stays `requires_action` until every call is answered or times out.

The caller runs the tool and answers with `output` or `error` (table above). The turn then continues; the model reads `output` as the tool's result (after the agent's `tool.post` guardrails) and `error` as the tool failing.

- A caller that does not answer within the tool's timeout — plus a few seconds for the round trip — is answered by the console with the error *The host page did not answer.*, whatever the agent's *On timeout* setting says, and the turn goes on.
- **Approval follows the agent's policy.** A call is treated like a call to any other tool of the agent: with *Approvals & questions* on and the default *ask*, a person approves it first (an ordinary `tool_approval`), and only then the page is asked; the *read-only* exemption of the agent's own lookup tools does not apply. Set a single tool to *always* or *never* in the per-tool table (`never` suits a harmless one, such as reading the page title).
- `tool.pre` guardrails see the arguments before the page does. The audit trail (`agent.client_tool.resolve`) records the call and its result as digests and sizes, never as content; the session log has `action.required` / `action.resolved` and an `agent.tool_result` with `source: client`.
- Only the person the chat belongs to, or an API token that is allowed to answer under *Who can answer*, can supply the `output` (it goes into the model's context as a tool result); an administrator or another project member answering from the dashboard can only give the call up with an `error`. Tool-access guardrails see the tool as `agent.client.<name>`.
- The dashboard shows the open call as *Waiting for the page*, with a **Give up on it** button that answers with an error.

## Unattended runs

Some runs have nobody to answer: [triggers](/guide/agent-triggers), evaluations and red-team cases, and the OpenAI-shaped endpoints, which have no way to send an answer. The *When nobody can answer* setting decides what a gated tool does there:

- **Deny the tool call** (default): the tool does not run, the model is told no approver is available and the run goes on. Questions are not asked.
- **Pause and wait for approval in Studio:** behaves like an attended run; the request waits in the session until someone answers it.
- **Run without approval:** the tool runs. An explicit opt-in for agents whose owner accepts that.

A stateless call with no session has nowhere to keep a paused turn, so the same rule applies to it.

## Timeouts and audit

Open requests are checked about every 30 seconds. Past the time you set, the agent's *When time runs out* setting applies, and the answer is recorded as given by `system:timeout`: that is the system, not a person, so it is outside the permission engine and the audit log records it with the actor type `system` (`agent.tool_approval.timeout`). Every answer a person gives is written to the audit log (who, what, the decision, and whether the arguments were edited), and appears in the [session events](/guide/agent-session-events) as `action.resolved`.
