# @cognipeer/gpu-agent

The console-side companion that runs on every GPU machine connected to a Cognipeer console deployment.

It is responsible for:

- Reporting GPU inventory (driver / CUDA / MIG layout / Docker availability) on handshake.
- Heartbeating so the console marks the host online and notices when it isn't.
- Long-polling for commands the console issues (apply deployment, stop, reconfigure MIG).
- Driving the local Docker daemon to realise desired state.
- Streaming events back so the console reflects actual state in the UI.

## Status

Phase 1 — single-GPU Docker deployments. MIG reconfigure is wired in the protocol but not yet implemented in the agent (TODO in the reconciler's `apply-mig-profile` branch).

## Running locally

```bash
npm install
COGNIPEER_CONSOLE_URL=http://localhost:3001 \
COGNIPEER_TENANT_SLUG=acme \
COGNIPEER_REGISTRATION_TOKEN=gpuref_... \
npm run dev --workspace=@cognipeer/gpu-agent
```

After the first successful handshake the agent persists the agent token in `$COGNIPEER_STATE_DIR/agent-token` and stops needing `COGNIPEER_REGISTRATION_TOKEN`.

## Building a release tarball

```bash
npm run package --workspace=@cognipeer/gpu-agent
# → packages/gpu-agent/release/cognipeer-gpu-agent-<version>-linux-x64.tar.gz
```

## Distributing to GPU hosts

See [DEPLOY.md](./DEPLOY.md) for the Azure Blob Storage upload + install flow.

## When this becomes its own repo

When extracted, the only thing to fix is the workspace dep on `@cognipeer/gpu-fleet-protocol` — either publish that package to npm (or a private registry) and depend on a real version, or vendor `packages/gpu-fleet-protocol/src/` into the agent repo. The bundle output is unchanged because `tsup` already inlines the protocol.
