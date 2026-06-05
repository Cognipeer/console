import { loadEnvConfig } from '@next/env';

let envLoaded = false;

export function ensureServerEnvLoaded(): void {
  if (envLoaded) {
    return;
  }

  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');
  envLoaded = true;
}
