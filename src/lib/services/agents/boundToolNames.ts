/**
 * The names an agent run exposes for its MCP tools.
 *
 * An MCP tool keeps its own name unless that name is already used in the run
 * (by another server's tool, or by any other bound tool) or is not a valid
 * provider tool name. Then it becomes `<serverKey>__<name>`, fitted to 64
 * characters, so two servers' tools can never shadow each other — or a
 * Console tool — under one name. Only the model-facing name changes: the call
 * still goes to the server and tool it was built for.
 */
import { createHash } from 'crypto';

const MAX_NAME_CHARS = 64;
const VALID_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function sanitize(part: string): string {
  const cleaned = part.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'tool';
}

function fit(name: string, seed: string): string {
  if (name.length <= MAX_NAME_CHARS) return name;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_NAME_CHARS - 9)}_${hash}`;
}

/**
 * One exposed name per entry, in order. `reserved`: names the run already uses
 * for tools that are not MCP tools; those keep their names.
 */
export function exposedMcpToolNames(
  entries: ReadonlyArray<{ serverKey: string; name: string }>,
  reserved: Iterable<string>,
): string[] {
  const taken = new Set(reserved);
  const counts = new Map<string, number>();
  for (const { name } of entries) counts.set(name, (counts.get(name) ?? 0) + 1);

  const keeps = entries.map(({ name }) => counts.get(name) === 1 && !taken.has(name) && VALID_NAME_RE.test(name));
  entries.forEach(({ name }, index) => {
    if (keeps[index]) taken.add(name);
  });

  return entries.map(({ serverKey, name }, index) => {
    if (keeps[index]) return name;
    const seed = `${serverKey}\u0000${name}`;
    const base = fit(`${sanitize(serverKey)}__${sanitize(name)}`, seed);
    let candidate = base;
    for (let suffix = 2; taken.has(candidate); suffix += 1) {
      candidate = fit(`${base}_${suffix}`, `${seed}\u0000${suffix}`);
    }
    taken.add(candidate);
    return candidate;
  });
}
