/**
 * Terminal bridge: on `open-terminal-session`, the agent opens a WebSocket back
 * to the console and attaches an interactive shell in the sandbox container.
 *
 * The PTY is allocated *inside the container* (`python3 -c 'pty.spawn(bash)'`),
 * not on the host. The agent only pipes raw bytes over `docker exec -i` (plain
 * stdio), so the shell sees a real TTY — Y/n prompts, password prompts, colors —
 * with zero native host dependencies (no node-pty). If the image lacks python3
 * we fall back to a plain shell (line-buffered). Frames are TerminalFrame JSON.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { OpenTerminalSessionCommand, TerminalFrame } from '@cognipeer/sandbox-protocol';
import { containerName } from './system/docker';
import type { ConsoleClient } from './api/client';
import { logger } from './logger';

/** Shell command that gives a fully interactive shell with an in-container PTY. */
function buildInteractiveCommand(shell: string): string {
  const py = [
    'import pty,os,sys',
    'sh="/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"',
    'sys.exit(pty.spawn([sh]))',
  ].join('; ');
  // Single-quoted for `sh -c`; the python source contains no single quotes.
  return `if command -v python3 >/dev/null 2>&1; then exec python3 -c '${py}'; else exec ${shell}; fi`;
}

export function openTerminalSession(cmd: OpenTerminalSessionCommand, client: ConsoleClient): void {
  const ws = client.openTerminalSocket(cmd.sessionId);
  const cwd = cmd.cwd || '/workspace';
  const shell = cmd.shell || '/bin/bash';
  let child: ChildProcessWithoutNullStreams | null = null;

  const send = (frame: TerminalFrame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };

  ws.on('open', () => {
    try {
      child = spawn('docker', [
        'exec', '-i', '-w', cwd, containerName(cmd.instanceId), 'sh', '-c', buildInteractiveCommand(shell),
      ]);
    } catch (error) {
      send({ type: 'exit', code: null, reason: `spawn-failed: ${error instanceof Error ? error.message : String(error)}` });
      ws.close();
      return;
    }
    // stdout + stderr both flow to the terminal as a single stream.
    child.stdout.on('data', (d: Buffer) => send({ type: 'stdout', data: d.toString() }));
    child.stderr.on('data', (d: Buffer) => send({ type: 'stdout', data: d.toString() }));
    child.on('exit', (code) => {
      send({ type: 'exit', code, reason: 'shell-exited' });
      ws.close();
    });
    child.on('error', (error: Error) => {
      send({ type: 'exit', code: null, reason: `spawn-failed: ${error.message}` });
      ws.close();
    });
    logger.info('terminal attached', { sessionId: cmd.sessionId, instanceId: cmd.instanceId });
  });

  ws.on('message', (raw: Buffer) => {
    let frame: TerminalFrame;
    try {
      frame = JSON.parse(raw.toString()) as TerminalFrame;
    } catch {
      return;
    }
    if (!child) return;
    if (frame.type === 'stdin') child.stdin.write(frame.data);
    // resize: the in-container PTY uses a default size; dynamic resize would
    // need a SIGWINCH/ioctl side-channel — a future enhancement.
  });

  const cleanup = () => {
    try {
      child?.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
  };
  ws.on('close', cleanup);
  ws.on('error', (err: Error) => {
    logger.warn('terminal ws error', { sessionId: cmd.sessionId, error: err.message });
    cleanup();
  });
}
