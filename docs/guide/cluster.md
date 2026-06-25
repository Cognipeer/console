# Cluster

Cognipeer Console can run as a single process or as a multi-node cluster. The cluster module owns three jobs:

1. **Node registry** — every running process registers itself, heartbeats, and is visible to operators.
2. **Queue layer** — long-running or distributable work (agent runs, MCP calls, browser actions, JS sandbox executions) flows through a shared queue instead of executing only in the receiving process.
3. **Instance assignment** — operators can pin a specific entity (an agent, MCP server, browser profile, JS runtime, inference server, alert rule, automation) to a specific node.

Single-process deployments get all of this for free — the registry has one node, the queue defaults to an in-process implementation, and every assignment falls back to the local node.

Operators manage the cluster under **Admin → Cluster** (tenant-admin gated). The dashboard lists nodes, their heartbeat status, and the assignable instances across every tenant.

![Cluster nodes](/screenshots/cluster/01-cluster-overview.png)

The **Nodes** tab shows total / online / offline / draining counts and a row per registered process — its role, status, last heartbeat, and version. Processes heartbeat every 10 seconds; the **Instances** tab is where you pin entities to a specific node.

## Topology

A process picks one of three roles via `NODE_ROLE`:

| Role | Accepts HTTP? | Runs consumers? |
|---|---|---|
| `main` | yes | yes — also services dashboard/API |
| `worker` | no | yes — pure background |
| `all` | yes | yes — default for single-node |

Each process announces itself with a `NODE_NAME` (defaults to `hostname-pid`) and a heartbeat. The node record persists in the **main** database under the `nodes` table along with `role`, `status`, `lastHeartbeatAt`, `startedAt`, `version`, `hostname`, and `pid`.

`CLUSTER_DEFAULT_NODE_NAME` overrides the "default" node that unassigned instances fall back to. If unset, the system picks the most recently active node.

## Queue layer

The queue is abstracted behind `src/lib/core/queue/queueProvider.interface.ts`. Two providers ship today:

| Provider | When it runs | Use it for |
|---|---|---|
| `memory` | In-process Map-backed | Single-node dev/test |
| `bullmq` | Redis-backed BullMQ | Multi-node production |

Selection is automatic: if `REDIS_URL` (or `QUEUE_REDIS_URL`) is set, BullMQ activates; otherwise the memory provider takes over. Force it explicitly with `QUEUE_PROVIDER=memory|bullmq`.

Relevant env:

```bash
QUEUE_PROVIDER=auto            # auto | memory | bullmq
QUEUE_REDIS_URL=               # falls back to REDIS_URL
QUEUE_PREFIX=console:q:        # BullMQ key prefix
QUEUE_DEFAULT_ATTEMPTS=3
QUEUE_DEFAULT_BACKOFF_MS=1000
```

Every service that opts into the queue follows the same shape:

- a **consumer** file (`*Consumer.ts`) registers handlers for the queue named after the service.
- an **entityId** helper (`*EntityId.ts`) builds the stable identifier the assignment layer uses.

This pattern is in place for: `agentConsumer`, `mcpConsumer`, `browserConsumer`, `jsSandboxConsumer`.

## Instance assignments

The assignable entity types today are:

```
agent · mcp · browser · js-sandbox · inference-server · alert-rule · automation
```

Each assignment is `(entityType, entityId) → (nodeName, mode)` where `mode` is one of:

- `strict` — the entity *only* runs on the target node. If that node is offline, jobs queue until it returns.
- `preferred` — the entity prefers the target node but will fall back to the default node if the target is unhealthy.

`PUT /api/cluster/assignments/:entityType/:entityId` sets an assignment; `DELETE` removes it. Both write an audit log entry (`cluster.assignment.set` / `cluster.assignment.delete`).

## Dashboard

`/dashboard/cluster` is split into a topology overview and an instance-assignment editor. The overview lists every node with its status, role, last heartbeat, version, and the assignment count it owns. The editor cross-joins assignments with the full instance list (collected across every tenant) so operators can see at a glance which entities are pinned and which fall back to the default node.

Cross-tenant iteration is unavoidable here — assignments are global to the cluster but instance records live per-tenant. Volume is small (the page tops out at hundreds of rows), so the implementation is a straightforward scan.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/cluster/overview` | Topology snapshot — `thisNodeName`, `defaultNodeName`, `nodes[]`, `assignments[]` |
| `GET` | `/api/cluster/instances` | All assignable instances annotated with their current binding |
| `PUT` | `/api/cluster/assignments/:entityType/:entityId` | Pin an entity to a node (`{ nodeName, mode }`) |
| `DELETE` | `/api/cluster/assignments/:entityType/:entityId` | Unpin an entity |

All four require a logged-in session; tighten with RBAC once the cluster permission tier lands.

See the [Cluster API reference](../api/cluster.md) for the full request/response schema.
