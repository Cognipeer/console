import type { ResourceTypeDefinition } from './types';

const definitions = new Map<string, ResourceTypeDefinition>();

/**
 * Registers resource types. Atomic: if any id is a duplicate (of an existing
 * registration or within `defs`) nothing is registered and it throws, so a
 * half-registered group can never linger.
 */
export function registerResourceTypes(defs: ResourceTypeDefinition[]): void {
  const seen = new Set<string>();
  for (const def of defs) {
    if (definitions.has(def.type) || seen.has(def.type)) {
      throw new Error(`Resource type "${def.type}" is already registered`);
    }
    seen.add(def.type);
  }
  for (const def of defs) definitions.set(def.type, def);
}

export function listResourceTypeDefinitions(): ResourceTypeDefinition[] {
  return [...definitions.values()];
}

export function getResourceTypeDefinition(type: string): ResourceTypeDefinition | undefined {
  return definitions.get(type);
}

/** Test seam. */
export function resetResourceRegistryForTests(): void {
  definitions.clear();
}
