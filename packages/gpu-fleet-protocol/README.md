# @cognipeer/gpu-fleet-protocol

Shared wire-format types between the Cognipeer console and the `@cognipeer/gpu-agent` binary.

Kept intentionally small and dependency-free so both sides can import it without pulling in heavy runtime modules. When this is extracted into its own repo, this folder is the unit that moves.

## Layout

- `command.ts` — desired-state commands the console sends to an agent
- `event.ts` — events the agent reports back (status changes, errors)
- `inventory.ts` — host capability snapshot reported on handshake/heartbeat
- `deployment.ts` — LLM deployment spec + runtime status
- `slice.ts` — GPU partition / MIG profile representation
- `auth.ts` — handshake payloads and JWT claims
- `wire.ts` — HTTP envelope types (request/response shapes)
