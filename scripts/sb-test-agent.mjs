/**
 * Self-contained sandbox runner agent for end-to-end testing.
 *
 * Uses the Docker CLI (no node deps) + global fetch. Faithful to the sandbox
 * wire protocol: handshake -> poll commands -> apply via docker -> post events.
 *
 * Env: CONSOLE_URL, TENANT_SLUG, REGISTRATION_TOKEN, SANDBOX_WORK_ROOT?
 */

import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONSOLE_URL = (process.env.CONSOLE_URL || 'http://localhost:3000').replace(/\/$/, '');
const TENANT_SLUG = process.env.TENANT_SLUG;
const REGISTRATION_TOKEN = process.env.REGISTRATION_TOKEN;
const WORK_ROOT = process.env.SANDBOX_WORK_ROOT || path.join(os.tmpdir(), 'cognipeer-sandbox');

if (!TENANT_SLUG || !REGISTRATION_TOKEN) {
  console.error('TENANT_SLUG and REGISTRATION_TOKEN required');
  process.exit(1);
}

const base = `${CONSOLE_URL}/api/sandbox/agent/${encodeURIComponent(TENANT_SLUG)}`;
let agentToken = null;
let seq = Date.now();
const outbox = [];
const containerName = (id) => `cognipeer-sandbox-${id}`;

function docker(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: opts.timeoutMs ?? 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function emit(ev) {
  outbox.push({ ...ev, sequence: ++seq, occurredAt: new Date().toISOString() });
}

async function flush() {
  if (!outbox.length) return;
  const batch = outbox.splice(0);
  try {
    await fetch(`${base}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });
  } catch (e) {
    outbox.unshift(...batch);
    console.error('flush failed', e.message);
  }
}

/** Inspect a container's state: 'running' | 'exited' | 'absent' | other. */
async function containerState(name) {
  const r = await docker(['inspect', '-f', '{{.State.Status}}', name], { timeoutMs: 15000 });
  if (r.code !== 0) return 'absent';
  return r.stdout.trim() || 'absent';
}

async function handleCreate(cmd) {
  const spec = cmd.spec;
  const name = containerName(spec.instanceId);

  // Idempotent: if the container already exists (e.g. the console restarted and
  // re-drove create), reuse it instead of failing on a name clash.
  const existing = await containerState(name);
  if (existing !== 'absent') {
    if (existing !== 'running') await docker(['start', name]);
    const cid = (await docker(['inspect', '-f', '{{.Id}}', name], { timeoutMs: 15000 })).stdout.trim().slice(0, 64);
    emit({ kind: 'instance-state-changed', instanceId: spec.instanceId, state: 'running', containerId: cid || null });
    emit({ kind: 'command-completed', commandId: cmd.id });
    return;
  }

  const args = ['run', '-d', '--name', name, '--label', `cognipeer.sandbox.instanceId=${spec.instanceId}`];
  for (const [k, v] of Object.entries(spec.env || {})) args.push('-e', `${k}=${v}`);
  for (const m of spec.volumeMounts || []) {
    if (m.provider === 'local') {
      const hostPath = path.join(WORK_ROOT, 'local', m.container, m.prefix || '');
      mkdirSync(hostPath, { recursive: true });
      args.push('-v', `${hostPath}:${m.mountPath}`);
    }
  }
  args.push('--entrypoint', 'sh', spec.image, '-c', 'sleep infinity');

  emit({ kind: 'instance-state-changed', instanceId: spec.instanceId, state: 'creating', containerId: null });
  // Only pull if the image isn't already present locally — avoids a slow,
  // failing registry round-trip for locally-built images (e.g. the base image).
  const present = (await docker(['image', 'inspect', spec.image], { timeoutMs: 15000 })).code === 0;
  if (!present) {
    emit({ kind: 'instance-state-changed', instanceId: spec.instanceId, state: 'creating', containerId: null, message: `pulling image ${spec.image}` });
    const pull = await docker(['pull', spec.image], { timeoutMs: 600000 });
    if (pull.code !== 0) {
      const msg = `image not available: ${spec.image} (${pull.stderr.trim().split('\n').pop() || 'pull failed'})`;
      emit({ kind: 'instance-state-changed', instanceId: spec.instanceId, state: 'failed', containerId: null, message: msg });
      emit({ kind: 'command-failed', commandId: cmd.id, error: msg, retryable: false });
      return;
    }
  }
  const res = await docker(args);
  if (res.code !== 0) {
    emit({ kind: 'instance-state-changed', instanceId: spec.instanceId, state: 'failed', containerId: null, message: res.stderr.trim() });
    emit({ kind: 'command-failed', commandId: cmd.id, error: res.stderr.trim(), retryable: false });
    return;
  }
  emit({ kind: 'instance-state-changed', instanceId: spec.instanceId, state: 'running', containerId: res.stdout.trim().slice(0, 64) });
  emit({ kind: 'command-completed', commandId: cmd.id });
}

async function handleExec(cmd) {
  const args = ['exec'];
  if (cmd.cwd) args.push('-w', cmd.cwd);
  for (const [k, v] of Object.entries(cmd.env || {})) args.push('-e', `${k}=${v}`);
  args.push(containerName(cmd.instanceId), 'sh', '-c', cmd.command);
  const res = await docker(args, { timeoutMs: (cmd.timeoutSec ?? 60) * 1000 });
  emit({ kind: 'exec-result', execId: cmd.execId, instanceId: cmd.instanceId, exitCode: res.code, stdout: res.stdout, stderr: res.stderr });
  emit({ kind: 'command-completed', commandId: cmd.id });
}

async function handleCodeRun(cmd) {
  const interp = { python: 'python3', javascript: 'node', typescript: 'node', bash: 'sh' }[cmd.language || 'python'] || 'python3';
  const b64 = Buffer.from(cmd.code, 'utf8').toString('base64');
  const script = `echo ${b64} | base64 -d > /tmp/sb_code && ${interp} /tmp/sb_code`;
  const args = ['exec'];
  if (cmd.cwd) args.push('-w', cmd.cwd);
  args.push(containerName(cmd.instanceId), 'sh', '-c', script);
  const res = await docker(args, { timeoutMs: (cmd.timeoutSec ?? 60) * 1000 });
  emit({ kind: 'exec-result', execId: cmd.execId, instanceId: cmd.instanceId, exitCode: res.code, stdout: res.stdout, stderr: res.stderr });
  emit({ kind: 'command-completed', commandId: cmd.id });
}

// Build the in-container command that gives a fully interactive shell.
//
// Rather than allocating a PTY on the host (node-pty — a native dep that is
// fragile across Node versions/platforms), we allocate the PTY *inside* the
// container: `python3 -c 'pty.spawn(bash)'`. The agent just pipes raw bytes
// over `docker exec -i` (plain stdio), so the shell sees a real TTY (Y/n
// prompts, password prompts, colors) with zero native host dependencies.
// If the image has no python3, we fall back to a plain shell (line-buffered).
function buildInteractiveCommand(shell) {
  const py = [
    'import pty,os,sys',
    'sh="/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"',
    'sys.exit(pty.spawn([sh]))',
  ].join('; ');
  // Single-quoted for `sh -c`; the python source contains no single quotes.
  return `if command -v python3 >/dev/null 2>&1; then exec python3 -c '${py}'; else exec ${shell}; fi`;
}

async function handleTerminal(cmd) {
  const wsUrl = `${base.replace(/^http/, 'ws')}/terminal/${encodeURIComponent(cmd.sessionId)}/agent?token=${agentToken}`;
  let ws;
  try { ws = new WebSocket(wsUrl); } catch { return; }
  const cwd = cmd.cwd || '/workspace';
  const shell = cmd.shell || 'bash';
  let child = null;

  ws.addEventListener('open', () => {
    const remote = buildInteractiveCommand(shell);
    child = spawn('docker', ['exec', '-i', '-w', cwd, containerName(cmd.instanceId), 'sh', '-c', remote]);
    // stdout + stderr both flow to the terminal as a single stream.
    child.stdout.on('data', (d) => { try { ws.send(JSON.stringify({ type: 'stdout', data: d.toString() })); } catch {} });
    child.stderr.on('data', (d) => { try { ws.send(JSON.stringify({ type: 'stdout', data: d.toString() })); } catch {} });
    child.on('exit', (code) => { try { ws.send(JSON.stringify({ type: 'exit', code, reason: 'shell-exited' })); } catch {}; try { ws.close(); } catch {} });
    child.on('error', (e) => { try { ws.send(JSON.stringify({ type: 'exit', code: null, reason: String(e.message) })); } catch {}; try { ws.close(); } catch {} });
  });
  ws.addEventListener('message', (ev) => {
    let f;
    try { f = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    if (f.type === 'stdin') { try { child?.stdin.write(f.data); } catch {} }
    // resize: the in-container PTY uses a default size; dynamic resize would
    // need a SIGWINCH/ioctl side-channel — a future enhancement.
  });
  const cleanup = () => { try { child?.stdin.end(); } catch {}; try { child?.kill(); } catch {} };
  ws.addEventListener('close', cleanup);
  ws.addEventListener('error', cleanup);
}

async function handle(cmd) {
  emit({ kind: 'command-accepted', commandId: cmd.id });
  try {
    if (cmd.kind === 'create-sandbox') await handleCreate(cmd);
    else if (cmd.kind === 'exec') await handleExec(cmd);
    else if (cmd.kind === 'code-run') await handleCodeRun(cmd);
    else if (cmd.kind === 'stop-sandbox') {
      await docker(['stop', '-t', '3', containerName(cmd.instanceId)]);
      emit({ kind: 'instance-state-changed', instanceId: cmd.instanceId, state: 'stopped', containerId: null });
      emit({ kind: 'command-completed', commandId: cmd.id });
    } else if (cmd.kind === 'start-sandbox') {
      await docker(['start', containerName(cmd.instanceId)]);
      emit({ kind: 'instance-state-changed', instanceId: cmd.instanceId, state: 'running', containerId: null });
      emit({ kind: 'command-completed', commandId: cmd.id });
    } else if (cmd.kind === 'delete-sandbox') {
      await docker(['rm', '-f', containerName(cmd.instanceId)]);
      emit({ kind: 'instance-state-changed', instanceId: cmd.instanceId, state: 'deleted', containerId: null });
      emit({ kind: 'command-completed', commandId: cmd.id });
    } else if (cmd.kind === 'open-terminal-session') {
      void handleTerminal(cmd);
      emit({ kind: 'command-completed', commandId: cmd.id });
    } else {
      emit({ kind: 'command-completed', commandId: cmd.id });
    }
  } catch (e) {
    emit({ kind: 'command-failed', commandId: cmd.id, error: e.message, retryable: false });
  }
}

async function main() {
  // Handshake
  const hs = await fetch(`${base}/handshake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ registrationToken: REGISTRATION_TOKEN, inventory: { hostname: os.hostname(), runtime: 'docker-cli' } }),
  });
  if (!hs.ok) {
    console.error('handshake failed', hs.status, await hs.text());
    process.exit(1);
  }
  const hsBody = await hs.json();
  agentToken = hsBody.agentToken;
  console.log('[test-agent] handshake ok, runner', hsBody.runnerId);

  setInterval(() => {
    fetch(`${base}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  }, 15000);

  for (;;) {
    try {
      const r = await fetch(`${base}/commands?wait=20`, { headers: { authorization: `Bearer ${agentToken}` } });
      if (r.ok) {
        const { commands } = await r.json();
        for (const cmd of commands || []) await handle(cmd);
        await flush();
      } else if (r.status === 401) {
        // Our token was invalidated — another agent took over this runner (e.g.
        // the console restarted and re-spawned a managed agent). Exit so this
        // orphaned process doesn't loop forever.
        console.error('[test-agent] token invalidated (401) — exiting');
        process.exit(0);
      } else {
        await new Promise((res) => setTimeout(res, 1000));
      }
    } catch (e) {
      console.error('loop error', e.message);
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
}

main();
