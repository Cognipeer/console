/**
 * The names an agent's bound tools (MCP servers, Tools-module actions) reach
 * the model under.
 *
 * A bound tool keeps its own name unless that name cannot stand:
 *  - it is not one every model provider accepts (`^[a-zA-Z0-9_-]{1,64}$` — a
 *    dot, a space or a 65th character fails the whole request);
 *  - another bound tool has it too (two MCP servers that both export `search`
 *    would otherwise leave the model one of them, at random);
 *  - a built-in owns it (`web_search`, `todo`…) — a bound tool must never pass
 *    for one, nor take on what the name means (the approval exemption of a
 *    read-only built-in included).
 * Such a tool is offered as `<source>__<name>`. Pure — no I/O.
 */

import { createHash } from 'node:crypto';

export const TOOL_NAME_MAX_CHARS = 64;

const INVALID_CHARS = /[^a-zA-Z0-9_-]/g;

function shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/** `name` cut to the limit, a hash of the whole of it keeping cut names apart. */
function fitName(name: string, whole: string): string {
    if (name.length <= TOOL_NAME_MAX_CHARS) return name;
    return `${name.slice(0, TOOL_NAME_MAX_CHARS - 9)}_${shortHash(whole)}`;
}

/** `name` in the characters and length every provider accepts. */
export function sanitizeToolName(name: string): string {
    const cleaned = name.replace(INVALID_CHARS, '_') || 'tool';
    return fitName(cleaned, name);
}

/** `<source>__<name>`, within the limit. */
export function prefixedToolName(source: string, name: string): string {
    const full = `${sanitizeToolName(source)}__${sanitizeToolName(name)}`;
    return fitName(full, `${source}\u0000${name}`);
}

export interface BoundToolNameRequest {
    /** The tool's own name (an MCP tool name, an action name). */
    name: string;
    /** What it is bound from (an MCP server key, a Tools-module tool key). */
    source: string;
}

/**
 * The name each bound tool is offered under, in order. `taken` holds the names
 * of every other tool of the run; `isReserved` says a name belongs to a
 * built-in even when that built-in is not part of this run.
 */
export function assignBoundToolNames(
    requests: readonly BoundToolNameRequest[],
    taken: ReadonlySet<string>,
    isReserved: (name: string) => boolean,
): string[] {
    const bases = requests.map((request) => sanitizeToolName(request.name));
    const counts = new Map<string, number>();
    for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);

    const used = new Set(taken);
    return requests.map((request, index) => {
        const base = bases[index]!;
        const clash = (counts.get(base) ?? 0) > 1 || taken.has(base) || isReserved(base);
        const stem = clash ? prefixedToolName(request.source, request.name) : base;
        // The same tool bound twice, or a prefixed name another tool already has.
        let name = stem;
        for (let n = 2; used.has(name); n += 1) name = fitName(`${stem}_${n}`, `${stem}\u0000${n}`);
        used.add(name);
        return name;
    });
}
