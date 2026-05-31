/**
 * Agent-side terminal session handler.
 *
 * Phase 1: pipes stdin/stdout via `child_process.spawn` — no PTY. Good
 * enough for command execution (`nvidia-smi`, `docker ps`, `ls`), not for
 * full-screen TUIs (vim, htop). Upgrade to `node-pty` is straightforward
 * when needed.
 *
 * Sandbox modes:
 *   - host             : /bin/sh on the host. Full privileges (agent runs as root).
 *   - docker-debug     : docker run -it --rm cognipeer/debug-shell — read-only /host mount.
 *   - deployment-exec  : docker exec into a known deployment container.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import WebSocket from 'ws';
import type { OpenTerminalSessionCommand, TerminalFrame } from '@cognipeer/gpu-fleet-protocol';
import { deploymentContainerName } from './system/docker';
import { logger } from './logger';

export interface TerminalContextDeps {
  consoleUrl: string;
  tenantSlug: string;
  agentToken: string;
}

export async function openTerminalSession(
  cmd: OpenTerminalSessionCommand,
  deps: TerminalContextDeps,
): Promise<void> {
  const wsUrl = `${deps.consoleUrl.replace(/^http/, 'ws')}/api/gpu/agent/${encodeURIComponent(deps.tenantSlug)}/terminal/${encodeURIComponent(cmd.sessionId)}/agent`;
  const ws = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${deps.agentToken}` },
  });

  let child: ChildProcessWithoutNullStreams | null = null;
  let closed = false;

  const send = (frame: TerminalFrame): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  };

  ws.on('open', () => {
    logger.info('terminal ws open', { sessionId: cmd.sessionId, sandbox: cmd.sandbox });
    try {
      child = spawnShell(cmd);
    } catch (error) {
      send({ type: 'exit', code: null, reason: `spawn-failed: ${error instanceof Error ? error.message : String(error)}` });
      ws.close();
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => send({ type: 'stdout', data: chunk.toString('utf8') }));
    child.stderr.on('data', (chunk: Buffer) => send({ type: 'stderr', data: chunk.toString('utf8') }));
    child.on('exit', (code) => {
      send({ type: 'exit', code, reason: 'process-exit' });
      ws.close();
    });
  });

  ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
    let frame: TerminalFrame;
    try {
      frame = JSON.parse(text) as TerminalFrame;
    } catch {
      return;
    }
    if (frame.type === 'stdin' && child) {
      child.stdin.write(frame.data);
    } else if (frame.type === 'resize') {
      // No PTY in Phase 1 — resize is a no-op. Logged so the upgrade path
      // (node-pty) is obvious.
      logger.debug('resize received (no-op without PTY)', {
        cols: frame.cols,
        rows: frame.rows,
        sessionId: cmd.sessionId,
      });
    } else if (frame.type === 'ping') {
      send({ type: 'pong' });
    }
  });

  ws.on('close', () => {
    if (closed) return;
    closed = true;
    logger.info('terminal ws closed', { sessionId: cmd.sessionId });
    child?.kill('SIGTERM');
  });
  ws.on('error', (err) => {
    logger.warn('terminal ws error', { sessionId: cmd.sessionId, error: err.message });
    child?.kill('SIGTERM');
  });

  // Enforce TTL on the agent side as a defence-in-depth measure.
  setTimeout(() => {
    if (!closed) {
      send({ type: 'exit', code: null, reason: 'ttl-expired' });
      ws.close();
    }
  }, cmd.ttlSeconds * 1000).unref();
}

function spawnShell(cmd: OpenTerminalSessionCommand): ChildProcessWithoutNullStreams {
  switch (cmd.sandbox) {
    case 'host':
      // -i keeps stdin open; we don't get a real TTY but command execution works.
      return spawn('/bin/sh', ['-i'], { stdio: 'pipe', env: process.env });
    case 'docker-debug':
      return spawn(
        'docker',
        [
          'run', '-i', '--rm',
          '--network', 'host',
          '-v', '/var/run/docker.sock:/var/run/docker.sock',
          'cognipeer/debug-shell:latest',
          '/bin/sh', '-i',
        ],
        { stdio: 'pipe' },
      );
    case 'deployment-exec': {
      if (!cmd.deploymentId) throw new Error('deploymentId required for deployment-exec sandbox');
      return spawn(
        'docker',
        ['exec', '-i', deploymentContainerName(cmd.deploymentId), '/bin/sh', '-i'],
        { stdio: 'pipe' },
      );
    }
    default:
      throw new Error(`Unsupported sandbox: ${cmd.sandbox as string}`);
  }
}
