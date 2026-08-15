# Quickstart

Five minutes from an existing agent to a trace you can click through in
Console.

## 1. Get a token

**Settings → API Tokens → Create Token.** Enable the **tracing** service on it.
Copy the value — it is shown once.

```bash
export COGNIPEER_API_KEY="cpeer_…"
# Self-hosted Console? Point at it:
export COGNIPEER_BASE_URL="https://console.acme.internal"
```

## 2. Install

::: code-group

```bash [Python]
# Extras pull in only what you use
pip install "cognipeer-observability[langchain]"
# or: [langgraph] [openai-agents] [claude-agent-sdk] [otel] [all]
```

```bash [TypeScript]
npm install @cognipeer/observability
```

:::

The core has no required dependencies in either language. Framework packages
are optional peers, so this will not move anything else in your lock file.

## 3. Wire it up

Pick the row that matches your agent.

::: code-group

```python [LangChain / LangGraph]
import cognipeer_observability as cognipeer
from cognipeer_observability.langchain import CognipeerCallbackHandler

cognipeer.init(agent={"name": "support-bot"})

agent.invoke(
    {"messages": [("user", "where is my order?")]},
    config={"callbacks": [CognipeerCallbackHandler(thread_id="conv-42")]},
)
```

```python [OpenAI Agents SDK]
import cognipeer_observability as cognipeer
from cognipeer_observability.openai_agents import install_openai_agents_tracing

cognipeer.init()
install_openai_agents_tracing()

from agents import Runner, RunConfig
await Runner.run(agent, "where is my order?", run_config=RunConfig(group_id="conv-42"))
```

```python [Claude Agent SDK]
import cognipeer_observability as cognipeer
from cognipeer_observability.claude_agent_sdk import trace_query

cognipeer.init()

async for message in trace_query(prompt="refactor billing", thread_id="conv-42"):
    print(message)
```

```python [Anything else]
import cognipeer_observability as cognipeer
from cognipeer_observability import observe, trace

cognipeer.init(agent={"name": "custom-agent"})

@observe(type="tool_call", tool_name="search")
def search(query: str) -> list: ...

with trace(name="custom-agent", thread_id="conv-42"):
    search("where is my order?")
```

:::

::: code-group

```ts [LangChain / LangGraph]
import { init } from '@cognipeer/observability';
import { CognipeerCallbackHandler } from '@cognipeer/observability/langchain';

init({ agent: { name: 'support-bot' } });

await agent.invoke(
  { messages: [['user', 'where is my order?']] },
  { callbacks: [new CognipeerCallbackHandler({ threadId: 'conv-42' })] },
);
```

```ts [OpenAI Agents SDK]
import { init } from '@cognipeer/observability';
import { installOpenAIAgentsTracing } from '@cognipeer/observability/openai-agents';

init();
await installOpenAIAgentsTracing();

await run(agent, 'where is my order?', { groupId: 'conv-42' });
```

```ts [Vercel AI SDK]
import { init } from '@cognipeer/observability';
import { withCognipeerTracing } from '@cognipeer/observability/vercel-ai';

init({ agent: { name: 'support-bot' } });

const { text } = await generateText({
  model: withCognipeerTracing(openai('gpt-4.1-mini'), { threadId: 'conv-42' }),
  prompt: 'where is my order?',
});
```

```ts [Anything else]
import { init, trace, observe } from '@cognipeer/observability';

init({ agent: { name: 'custom-agent' } });

const search = observe(async (query: string) => api.search(query), {
  type: 'tool_call',
  toolName: 'search',
});

await trace({ name: 'custom-agent', threadId: 'conv-42' }, async () => {
  await search('where is my order?');
});
```

:::

Running an OTel-instrumented framework instead — CrewAI, LlamaIndex, Pydantic
AI, Google ADK, Semantic Kernel? Go straight to
[OpenTelemetry](/guide/observability/opentelemetry).

## 4. Run it, then look

Run your agent once, then open **Tracing → Sessions** in Console. The run
appears within a second or two, named after the `agent.name` you set.

Click into it and you should see the model calls, their prompts and
completions, the tools that ran with their arguments and results, and the
token counts per call.

If nothing shows up, run with `COGNIPEER_DEBUG=1` and read
[Troubleshooting](/guide/observability/troubleshooting) — it lists the five
things that actually go wrong, in order of likelihood.

## 5. Set a thread id

This is the one thing worth doing beyond the two lines. Passing a `threadId`
(or `thread_id`, or `group_id`, depending on the framework) groups a
conversation's runs together in **Tracing → Threads**, so a multi-turn agent
reads as a conversation rather than as a pile of unrelated runs.

Use whatever key your application already has: a chat id, a ticket number, a
user session.

## Before production

- **Decide what content leaves the process.** `COGNIPEER_CAPTURE_CONTENT=metadata`
  keeps the run structure, tool names, tokens and latency but sends no message
  bodies. Useful when prompts carry customer data and you have not yet run the
  DPIA.
- **Flush on exit for short-lived processes.** A Lambda, a cron job or a script
  should call `cognipeer.flush()` / `await flush()` before returning; the
  process can otherwise exit before the last export lands.
- **Set an agent name and version.** `COGNIPEER_AGENT_NAME` and
  `COGNIPEER_AGENT_VERSION`, or `agent={"name": …, "version": …}`. The version
  is what makes a before/after comparison possible after a prompt change.
