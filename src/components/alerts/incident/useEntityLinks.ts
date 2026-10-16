'use client';

import { useEffect, useMemo, useState } from 'react';
import { entityLinkKey } from '../alertCatalog';

export interface EntityRef {
  type: string;
  key: string;
}

const KNOWN_TYPES = new Set(['agent', 'model', 'kb', 'mcp', 'tool']);
const MAX_LOOKUP = 100;
/**
 * Answers of `POST /alerts/entities/links` for the session, keyed by project and entity
 * (a null answer is kept: no console record).
 */
const cache = new Map<string, string | null>();
const cacheKey = (projectId: string | undefined, linkKey: string) => `${projectId ?? ''}|${linkKey}`;

/**
 * Where the entities on screen live (`POST /alerts/entities/links`): models, MCP servers and tools are
 * addressed by record id, which only the server can look up. Feed the result to `entityHref(type, key, links)`.
 * Until it answers (or when it fails) the built-in guess for agents and knowledge bases still applies.
 */
export function useEntityLinks(entities: EntityRef[], projectId?: string): Record<string, string | null> {
  const [version, setVersion] = useState(0);
  const wanted = useMemo(() => {
    const seen = new Map<string, EntityRef>();
    for (const entity of entities) {
      if (!entity.key || !KNOWN_TYPES.has(entity.type)) continue;
      seen.set(entityLinkKey(entity.type, entity.key), entity);
    }
    return [...seen.values()];
  }, [entities]);
  const signature = [projectId ?? '', ...wanted.map((entity) => entityLinkKey(entity.type, entity.key))].join('\n');

  useEffect(() => {
    const missing = wanted.filter((entity) => !cache.has(cacheKey(projectId, entityLinkKey(entity.type, entity.key)))).slice(0, MAX_LOOKUP);
    if (missing.length === 0) return;
    const controller = new AbortController();
    fetch('/api/alerts/entities/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(projectId ? { projectId } : {}),
        entities: missing.map((entity) => ({ type: entity.type, key: entity.key })),
      }),
      signal: controller.signal,
    })
      .then(async (res) => (res.ok ? ((await res.json()) as { links?: Record<string, string | null> }) : null))
      .then((data) => {
        if (!data?.links || controller.signal.aborted) return;
        for (const [key, href] of Object.entries(data.links)) cache.set(cacheKey(projectId, key), href ?? null);
        setVersion((value) => value + 1);
      })
      .catch(() => {
        // links are a convenience; the built-in guess stays
      });
    return () => controller.abort();
    // `wanted` and `projectId` are covered by the signature
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const entity of wanted) {
      const key = entityLinkKey(entity.type, entity.key);
      const stored = cacheKey(projectId, key);
      if (cache.has(stored)) out[key] = cache.get(stored) ?? null;
    }
    return out;
    // `version` re-reads the cache after a lookup landed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, version]);
}
