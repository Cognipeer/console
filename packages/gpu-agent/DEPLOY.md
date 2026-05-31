# Distributing the GPU agent via Azure Blob Storage

End-to-end recipe for shipping a fresh agent build to your GPU fleet without GitHub releases. Everything below works from your dev machine; nothing console-side needs to change between releases.

---

## TL;DR (every release)

```bash
# 1. From the repo root — build and tar
npm run package --workspace=@cognipeer/gpu-agent
# → packages/gpu-agent/release/cognipeer-gpu-agent-<version>-linux-x64.tar.gz

# 2. Upload to Azure Blob (latest + immutable version)
az storage blob upload \
  --account-name cognipeerstorage \
  --container-name gpu-agent \
  --file packages/gpu-agent/release/cognipeer-gpu-agent-0.1.0-linux-x64.tar.gz \
  --name 0.1.0/cognipeer-gpu-agent-linux-x64.tar.gz \
  --overwrite false

az storage blob upload \
  --account-name cognipeerstorage \
  --container-name gpu-agent \
  --file packages/gpu-agent/release/cognipeer-gpu-agent-0.1.0-linux-x64.tar.gz \
  --name latest/cognipeer-gpu-agent-linux-x64.tar.gz \
  --overwrite true

# 3. On each GPU host
curl -fsSL https://<account>.blob.core.windows.net/gpu-agent/install.sh | sudo bash -s -- \
  --console-url https://console.example.com \
  --tenant-slug acme \
  --registration-token gpuref_xxxxxxxxxxxxxxxxxxxxxxxx \
  --asset-url https://<account>.blob.core.windows.net/gpu-agent/latest/cognipeer-gpu-agent-linux-x64.tar.gz
```

The rest of this doc explains the moving parts.

---

## 1. What gets built

`npm run package --workspace=@cognipeer/gpu-agent` runs two things:

1. **`tsup`** bundles `src/index.ts` into a single CommonJS file at `packages/gpu-agent/dist/index.cjs`. The shared `@cognipeer/gpu-fleet-protocol` package is inlined (see `tsup.config.ts`), so the bundle has no workspace dependency at runtime.
2. **`scripts/package.sh`** wraps the binary + `install.sh` + `README.md` into a tarball at `packages/gpu-agent/release/cognipeer-gpu-agent-<version>-linux-x64.tar.gz`. It prints the SHA-256 for integrity checks.

`dist/` and `release/` are both git-ignored.

> Note: `dockerode` resolves the Docker socket at runtime, so the bundle is portable across Linux distros — you don't need to build on a host with Docker installed.

The version comes from `packages/gpu-agent/package.json`. Bump it before packaging a new release:

```bash
npm version --workspace=@cognipeer/gpu-agent patch   # or minor / major
```

---

## 2. One-time Azure setup

You only do this once per environment.

### Create a storage account + container

```bash
RG=cognipeer-rg
ACCOUNT=cognipeerstorage
LOCATION=westeurope

az group create --name "$RG" --location "$LOCATION"

az storage account create \
  --name "$ACCOUNT" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2 \
  --allow-blob-public-access true

az storage container create \
  --account-name "$ACCOUNT" \
  --name gpu-agent \
  --public-access blob   # individual blobs are publicly readable; container listing stays private
```

### Pick an access model

You have three reasonable options. Pick one and stick with it — the agent install command differs only in the `--asset-url`.

| Model | URL shape | When to use |
|---|---|---|
| **Public blob** (above) | `https://<account>.blob.core.windows.net/gpu-agent/latest/...` | Binary is not sensitive; you want one URL that everyone in the org can use. |
| **SAS-signed URL** | `https://...?sv=...&se=...&sig=...` | You want time-limited access; URL rotates per install batch. |
| **Private + azcopy w/ AAD** | n/a | Strict tenant; install host must run `az login` first. Heavy. |

For most teams, **public blob** is the right default: the agent binary already requires a valid registration token to do anything useful, so leaking the binary itself buys an attacker nothing.

If you want SAS:

```bash
EXPIRY=$(date -u -d '+30 days' +%Y-%m-%dT%H:%MZ)
SAS=$(az storage blob generate-sas \
  --account-name "$ACCOUNT" \
  --container-name gpu-agent \
  --name latest/cognipeer-gpu-agent-linux-x64.tar.gz \
  --permissions r \
  --expiry "$EXPIRY" \
  --https-only \
  --output tsv)
echo "https://$ACCOUNT.blob.core.windows.net/gpu-agent/latest/cognipeer-gpu-agent-linux-x64.tar.gz?$SAS"
```

---

## 3. The release flow

Recommended layout in the container:

```
gpu-agent/
  install.sh                                              ← upload once; same script every release
  latest/
    cognipeer-gpu-agent-linux-x64.tar.gz                 ← overwritten each release
  0.1.0/
    cognipeer-gpu-agent-linux-x64.tar.gz                 ← immutable, kept forever
  0.1.1/
    cognipeer-gpu-agent-linux-x64.tar.gz
```

`latest/` makes "always-current" deployments easy; the versioned directories let you pin a host to a known build for debugging.

### Upload `install.sh` once

```bash
az storage blob upload \
  --account-name "$ACCOUNT" \
  --container-name gpu-agent \
  --file packages/gpu-agent/scripts/install.sh \
  --name install.sh \
  --content-cache-control "max-age=60" \
  --overwrite true
```

The `max-age=60` keeps the CDN from serving a stale installer for hours after you fix a bug. The actual binary is content-hashed in the version path so it can be cached aggressively.

### Upload a new build (versioned + latest)

```bash
VERSION=$(node -p "require('./packages/gpu-agent/package.json').version")
TARBALL="packages/gpu-agent/release/cognipeer-gpu-agent-${VERSION}-linux-x64.tar.gz"

# Immutable version path — fails on re-upload, prevents accidental overwrites.
az storage blob upload \
  --account-name "$ACCOUNT" \
  --container-name gpu-agent \
  --file "$TARBALL" \
  --name "${VERSION}/cognipeer-gpu-agent-linux-x64.tar.gz" \
  --overwrite false

# Latest alias — overwritten every release.
az storage blob upload \
  --account-name "$ACCOUNT" \
  --container-name gpu-agent \
  --file "$TARBALL" \
  --name "latest/cognipeer-gpu-agent-linux-x64.tar.gz" \
  --content-cache-control "max-age=300" \
  --overwrite true
```

### Verify

```bash
curl -sI https://"$ACCOUNT".blob.core.windows.net/gpu-agent/latest/cognipeer-gpu-agent-linux-x64.tar.gz
# HTTP/1.1 200 OK
# Content-Length: 12345
# x-ms-blob-content-md5: ...
```

---

## 4. Installing on a GPU host

You don't reach into the host yourself. Instead:

1. **In the console UI** (or via `POST /api/gpu-fleet/hosts`), create a host record. The response includes a one-time `registrationToken`.
2. **On the host**, run:

```bash
curl -fsSL https://<account>.blob.core.windows.net/gpu-agent/install.sh | sudo bash -s -- \
  --console-url https://console.example.com \
  --tenant-slug acme \
  --registration-token gpuref_xxxxxxxxxxxxxxxxxxxxxxxx \
  --asset-url https://<account>.blob.core.windows.net/gpu-agent/latest/cognipeer-gpu-agent-linux-x64.tar.gz
```

`install.sh`:
- Verifies `nvidia-smi`, `docker`, and warns if `nvidia-container-toolkit` is missing.
- Downloads the tarball from `--asset-url`, unpacks to `/opt/cognipeer-gpu-agent/`.
- Writes `/etc/cognipeer-gpu-agent.env` (chmod 600) with the console URL, tenant slug, registration token.
- Installs `/etc/systemd/system/cognipeer-gpu-agent.service`, enables it, starts it.

The agent then handshakes with the console once, persists the issued long-lived agent token at `/var/lib/cognipeer-gpu-agent/agent-token`, and the registration token is never used again.

### Bulk rollout (cloud-init for Azure VMs)

Embed the same command in the VM's user-data. For NCasv3 VMs created via `az vm create`, pass it through `--custom-data`:

```bash
cat > cloud-init.sh <<EOF
#!/bin/bash
set -eu
curl -fsSL https://${ACCOUNT}.blob.core.windows.net/gpu-agent/install.sh | bash -s -- \\
  --console-url https://console.example.com \\
  --tenant-slug acme \\
  --registration-token \${REG_TOKEN} \\
  --asset-url https://${ACCOUNT}.blob.core.windows.net/gpu-agent/latest/cognipeer-gpu-agent-linux-x64.tar.gz
EOF

az vm create \
  --resource-group "$RG" \
  --name gpu-test-01 \
  --image Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest \
  --size Standard_NC24ads_A100_v4 \
  --custom-data cloud-init.sh \
  ...
```

The registration token still needs to be generated per host (one-time use), so this is best wrapped in a small shell script that POSTs to `/api/gpu-fleet/hosts` then drops the returned token into the cloud-init template.

---

## 5. Upgrading existing hosts

Two options:

**A. Reinstall (simplest)** — re-run the same install command. The script overwrites `/opt/cognipeer-gpu-agent/`, restarts the systemd unit. The persisted agent token in `/var/lib/cognipeer-gpu-agent/agent-token` is preserved, so no re-handshake is needed. **You don't need a fresh registration token for upgrades.**

```bash
sudo bash -c "$(curl -fsSL https://${ACCOUNT}.blob.core.windows.net/gpu-agent/install.sh)" -- \
  --console-url https://console.example.com \
  --tenant-slug acme \
  --registration-token noop \
  --asset-url https://${ACCOUNT}.blob.core.windows.net/gpu-agent/latest/cognipeer-gpu-agent-linux-x64.tar.gz
```

(`--registration-token` is required by the script but ignored when a persisted token exists. We could lift this restriction later.)

**B. Self-update command (future)** — the protocol has `reboot-agent` as a placeholder. Once we wire it, the console can push a "new asset URL" command and the agent will fetch+swap binaries itself. Not implemented yet.

---

## 6. When you split the agent into its own repo

Two things change:

1. **`@cognipeer/gpu-fleet-protocol` is no longer a workspace.** Either publish it to npm (or a private registry) and update the agent's `package.json` to depend on a real version, or vendor `packages/gpu-fleet-protocol/src/` into the agent repo as a folder. The bundle output stays the same — `tsup` already inlines the protocol.

2. **CI moves to the agent repo.** All the `az storage blob upload` commands above can run in any CI provider — GitHub Actions, Azure Pipelines, anything that can `npm install && npm run package && az login`. No console-side coupling.

The console keeps `packages/gpu-fleet-protocol/` so the API surface stays type-checked against the same wire schema.

---

## 7. Troubleshooting

| Symptom | Where to look |
|---|---|
| `journalctl -u cognipeer-gpu-agent -f` shows `handshake failed: Invalid or already-consumed registration token` | Token already used or expired. Rotate from the console (`POST /api/gpu-fleet/hosts/:id/rotate-token`) and re-run install. |
| `cognipeer-gpu-agent` running but console shows `awaiting registration: true` | Network reachability — the agent can't reach `${COGNIPEER_CONSOLE_URL}`. Test with `curl -v $URL/api/health/live`. |
| Containers start but model 404s | nvidia-container-toolkit missing or not configured. `docker run --rm --gpus all nvidia/cuda:12.4.0-base nvidia-smi` should work. |
| Need to wipe and re-register | `sudo systemctl stop cognipeer-gpu-agent && sudo rm -rf /var/lib/cognipeer-gpu-agent && sudo systemctl start cognipeer-gpu-agent` — then issue a fresh registration token. |
