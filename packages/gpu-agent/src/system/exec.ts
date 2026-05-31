/**
 * Promisified `execFile` with predictable error shapes. Used for `nvidia-smi`,
 * `docker version`, etc. — short-lived commands where we want stdout as a
 * string and a non-zero exit to throw.
 */

import { execFile as execFileCb } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export function execFile(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFileCb(
      command,
      args,
      { timeout: options.timeoutMs ?? 15_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = new Error(
            `${command} ${args.join(' ')} failed: ${error.message}\n${stderr}`,
          );
          (enriched as Error & { code?: number }).code = (error as NodeJS.ErrnoException).errno;
          return reject(enriched);
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** True when the command exists on PATH. Used for graceful "tool missing" reporting. */
export async function commandExists(command: string): Promise<boolean> {
  try {
    await execFile('which', [command], { timeoutMs: 2_000 });
    return true;
  } catch {
    return false;
  }
}
