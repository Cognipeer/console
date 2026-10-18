# Tools API (retired)

The standalone client Tools API (`/api/client/v1/tools`) has been retired and is no longer served. It is not part of the OpenAPI document either.

Tools are an agent capability now: they run server-side, through the tool bindings of an agent.

- Create and manage tools in the dashboard (Agents > Tools).
- Add a tool to an agent as a tool binding (`config.toolBindings`, `source: "tool"`), then call the agent through the [Agents API](./agents).
- MCP servers are reachable through the [MCP API](./mcp).
