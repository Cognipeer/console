'use client';

import { useEffect, useState } from 'react';

/**
 * Who the ids on an incident are. Incidents and events store raw user ids; this resolves them for
 * display: the signed-in user (`GET /auth/me`, any role) and, when the viewer may list people
 * (`GET /users`, administrators), everyone else. A viewer who cannot list users sees a short id for
 * other people. One lookup is shared by every consumer.
 */

export interface UserDirectory {
  meId: string | null;
  meName: string | null;
  names: Record<string, string>;
}

const EMPTY: UserDirectory = { meId: null, meName: null, names: {} };

let cached: UserDirectory | null = null;
let inflight: Promise<UserDirectory> | null = null;

export function resetUserDirectoryCache(): void {
  cached = null;
  inflight = null;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function fetchUserDirectory(): Promise<UserDirectory> {
  if (cached) return cached;
  if (!inflight) {
    inflight = Promise.all([
      getJson<{ userId?: string; name?: string }>('/api/auth/me'),
      getJson<{ users?: Array<{ _id?: unknown; name?: string; email?: string }> }>('/api/users'),
    ])
      .then(([me, users]) => {
        const names: Record<string, string> = {};
        for (const user of users?.users ?? []) {
          const id = user._id == null ? '' : String(user._id);
          const label = user.name || user.email;
          if (id && label) names[id] = label;
        }
        const directory: UserDirectory = { meId: me?.userId ?? null, meName: me?.name ?? null, names };
        // A directory without even the viewer is a failed lookup: keep it out of the cache so the next screen retries.
        if (directory.meId) cached = directory;
        return directory;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useUserDirectory(): UserDirectory {
  const [directory, setDirectory] = useState<UserDirectory>(cached ?? EMPTY);
  useEffect(() => {
    let cancelled = false;
    void fetchUserDirectory().then((result) => {
      if (!cancelled) setDirectory(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return directory;
}

export interface UserLabels {
  you: string;
  system: string;
}

/**
 * `You`, `System`, a name, or a short id. `serverName` is the name the server resolved for the id (incident
 * `acknowledgedByName` and friends): it works for viewers who cannot list users, so it wins over the directory.
 */
export function userLabel(
  id: string | null | undefined,
  directory: UserDirectory,
  labels: UserLabels,
  serverName?: string | null,
): string {
  if (!id) return '—';
  if (id === 'system') return labels.system;
  if (directory.meId && id === directory.meId) return labels.you;
  if (serverName) return serverName;
  return directory.names[id] ?? (id.length > 10 ? `${id.slice(0, 8)}…` : id);
}
