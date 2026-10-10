/**
 * The "Get started" tiles of the dashboard home (pure: no React, tested in node).
 *
 * A tile is a link into a service, so it exists only when the person can open
 * that service in the ACTIVE project: the tiles are made from the list of
 * services the navigation offers (what the policy engine allows there, roles,
 * group grants and project limits included), never from a fixed list. A person
 * who cannot reach "Model Hub" in this project is not sent there; the steps that
 * remain are numbered afresh, so the first one is always "Step 01".
 */

export type QuickStartService = 'models' | 'prompts' | 'agents';

/** The suggested path, in order. `service` is the id of the service in the navigation. */
export const QUICK_START_SERVICES: readonly QuickStartService[] = ['models', 'prompts', 'agents'];

export interface QuickStartTile {
  service: QuickStartService;
  /** Where the navigation sends people for that service. */
  href: string;
  /** "01", "02"... counted over the tiles that are shown. */
  step: string;
}

/** The tiles for the services in `offered` (the navigation's list for this person, in this project). */
export function quickStartTiles(offered: ReadonlyArray<{ id: string; href: string }>): QuickStartTile[] {
  const byId = new Map(offered.map((service) => [service.id, service] as const));
  const tiles: QuickStartTile[] = [];
  for (const service of QUICK_START_SERVICES) {
    const found = byId.get(service);
    if (found) tiles.push({ service, href: found.href, step: String(tiles.length + 1).padStart(2, '0') });
  }
  return tiles;
}
