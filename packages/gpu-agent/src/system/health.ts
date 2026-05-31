/**
 * Probe a deployed container's HTTP health endpoint. Used after `docker run` to
 * decide when to flip the actual state from `starting` -> `healthy`.
 */

import { request } from 'undici';

export async function probeDeploymentHealth(args: {
  port: number;
  healthPath: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const url = `http://127.0.0.1:${args.port}${args.healthPath.startsWith('/') ? args.healthPath : `/${args.healthPath}`}`;
  try {
    const response = await request(url, {
      method: 'GET',
      headersTimeout: args.timeoutMs ?? 5_000,
      bodyTimeout: args.timeoutMs ?? 5_000,
    });
    // Drain the body so the connection can be reused.
    await response.body.text().catch(() => undefined);
    return response.statusCode >= 200 && response.statusCode < 400;
  } catch {
    return false;
  }
}
