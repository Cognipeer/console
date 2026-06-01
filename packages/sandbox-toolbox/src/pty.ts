/**
 * PTY (interactive terminal) sessions for the toolbox daemon.
 *
 * A WebSocket client (the runner agent, relaying the console terminal) connects
 * and exchanges TerminalFrame JSON messages with a live pseudo-terminal.
 */

import type { WebSocket } from 'ws';
import pty from 'node-pty';
import { SANDBOX_ROOT } from './paths';
import type { TerminalFrame } from '@cognipeer/sandbox-protocol';

export interface PtyConnectOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
}

const DEFAULT_SHELL = process.env.SHELL || '/bin/bash';

export function attachPty(socket: WebSocket, opts: PtyConnectOptions = {}): void {
  const shell = opts.shell || DEFAULT_SHELL;
  const term = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    cwd: opts.cwd || SANDBOX_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
  });

  const send = (frame: TerminalFrame) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(frame));
  };

  term.onData((data) => send({ type: 'stdout', data }));
  term.onExit(({ exitCode }) => {
    send({ type: 'exit', code: exitCode, reason: 'shell-exited' });
    try {
      socket.close(1000, 'shell-exited');
    } catch {
      /* ignore */
    }
  });

  socket.on('message', (raw: Buffer) => {
    let frame: TerminalFrame;
    try {
      frame = JSON.parse(raw.toString()) as TerminalFrame;
    } catch {
      return;
    }
    if (frame.type === 'stdin') term.write(frame.data);
    else if (frame.type === 'resize') term.resize(frame.cols, frame.rows);
    else if (frame.type === 'ping') send({ type: 'pong' });
  });

  socket.on('close', () => {
    try {
      term.kill();
    } catch {
      /* ignore */
    }
  });
}
