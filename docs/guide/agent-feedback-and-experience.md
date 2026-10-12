# Feedback, welcome text and message actions

What a chat surface — a portal, an embedded widget — builds on top of an agent: the text and suggested first messages it greets people with, the thumbs people give an answer, a title for each conversation, and the actions on a message (regenerate, edit). The surface decides what to switch on; the pieces below are the console's part.

## Experience: welcome text and starters

**Build → Experience** (`config.experience`) holds what a surface shows on an empty conversation:

| Setting | |
| --- | --- |
| Welcome text | Markdown (links, lists, bold), up to 2000 characters. May use `{{user.name}}`, `{{user.firstName}}`, `{{agent.name}}` and `{{portal.name}}`; the surface fills them in on the server, escaping each value, so a person's display name cannot add a link or an image to a greeting. Any other `{{…}}` is left as written. |
| Starters | Up to 6 suggested first messages: `text` (up to 500 characters), an optional shorter chip `label`, and `autoSend` (off: the click only fills the message box so the person can edit first). |

An agent that sets neither shows nothing extra. A portal shows the **published** version, and may override both for itself. The single-agent lookup of the client API returns them as `experience` (`welcome`, `starters[]` with `auto_send`).

The same section holds one setting that is about what the agent may receive rather than what it shows: **Tools from the page** (`config.experience.clientTools.enabled`, off by default). An agent only gets tools that run in the embedding page when its author turns this on; what such a tool returns is typed in the person's browser, so it reaches the model as untrusted input and the agent's approval policy applies to the calls. See [Tools the page runs](/guide/agent-approvals#tools-the-page-runs-client-tool).

## Feedback

A person can rate an answer **helpful** or **not helpful**. A thumbs down can carry reasons (`inaccurate`, `incomplete`, `off_topic`, `too_long`, `unsafe`, `other`) and a comment of up to 1000 characters.

- One rating per person per answer. Rating again replaces it; withdrawing (a `null` rating) deletes it.
- An answer is addressed by a stable message id — derived from the session, its place in the transcript and its time, so rating never touches the transcript — or by its index.
- When an answer is replaced (regenerate, edit), the ratings of the replaced messages stay and count; they are marked as removed.

**Studio.** **Sessions → a session** shows the ratings under the answer they belong to. The agent's **Feedback** tab shows the counts, the share of helpful answers, why answers were not helpful, and the latest ratings with a link to the session; it can be narrowed by period, rating and reason. Counts and reasons are visible to everyone who can read the agent; **the words people wrote, and who wrote them, only to those who can change it** (`canReadComments` in the responses says which).

| Route (dashboard) | |
| --- | --- |
| `GET /api/agents/{agentId}/feedback` | Latest ratings, newest first. Query: `days` (1–365, default 30), `rating`, `reason`, `hasComment`, `portalId`, `limit` (≤100), `skip`. |
| `GET /api/agents/{agentId}/feedback/summary` | Counts: `up`, `down`, `total`, `positiveRate`, `withComment`, `reasons`. Same filters. |
| `GET /api/agents/{agentId}/sessions/{sessionId}/feedback` | Every rating of one session. |

**Where it is announced.** Recording or withdrawing a rating writes a `feedback` event to the trace of the turn that wrote the answer, an audit entry (`agent.message.feedback`, with no comment text), and sends the `feedback.recorded` [webhook](/guide/webhooks) event (ids, rating, reasons and whether there is a comment — never the comment).

Surfaces call `recordMessageFeedback` from `@/lib/services/agents`; it takes the session, the message, the person, the channel (`portal`, `embed`, …) and whether comments are allowed on that surface.

## Titles

`generateConversationTitle` asks a model for a title of at most six words, in the language the conversation is in. The call is recorded like any other model call (a usage row tagged `purpose: title`, route `agent.title`), attributed to the person, and counted against the tenant's spend limits. `generateAndStoreConversationTitle` names a conversation once, after its first exchange, and leaves a title a person chose (`metadata.titleSource: user`). A model that is gone, a spend limit or a timeout means "no generated title": the conversation keeps the one it has. Which model writes titles (`off`, the agent's own, or a model key) is the surface's setting.

## Cutting a session back, regenerating, editing

- `truncateSessionAfterMessage` keeps the messages up to an index and removes the rest. Requests still open on the removed messages are cancelled, the agent's carried state is dropped (the next turn rebuilds it from the transcript), the files the removed messages carried are remembered as already sent, the ratings of the removed messages are marked, and `session.truncated` is written to the [event log](/guide/agent-session-events).
- `rerunSessionTurn` cuts the session back to just before a message and runs it again with a callback — the surface's own `executePlaygroundChat` call. **Regenerate** takes the latest answer, runs its user message again (tools included) and keeps the answer it replaced as `previousVersions` on the new message (newest last, at most 5). **Edit** takes a user message, drops everything after it and runs the new text, with the original files unless others are given. If the new turn cannot run at all, the transcript is put back.

All of it needs the conversation's run slot, exactly like sending a message; a session that is still answering is refused with `conversation_busy`.
