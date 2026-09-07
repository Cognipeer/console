/**
 * The aria snapshot, as the workbench's element list needs it.
 *
 * Shared by the playground and the flow editor: both let you pick an element
 * out of the page, and a target picked in one has to mean the same thing in
 * the other — the editor writes that pick into a flow step.
 */

/** One node of the aria snapshot, flattened for the element list. */
export interface SnapshotNode {
  ref: string;
  role: string;
  name?: string;
  depth: number;
  /** True when role+name repeats, so `nth` is load-bearing. */
  ambiguous: boolean;
  nth: number;
  /**
   * What the element currently holds — the text after its own colon, or the
   * `/url`, `/placeholder`, `/value` line beneath it.
   *
   * The accessible name says which element this is; the value says what is IN
   * it, and on a page of six identical-looking textboxes that is the half you
   * actually search by.
   */
  value?: string;
  /**
   * Where it sits in the tree — `banner › generic › button`.
   *
   * An element with no accessible name has nothing to show but its role, and
   * a list of eleven rows all reading "generic" identifies nothing. The
   * ancestry is the only thing that distinguishes them on sight; the exact
   * selector is resolved from the page when one is actually picked.
   */
  path?: string;
}

/**
 * Parse `ariaSnapshot({ mode: 'ai' })` output into addressable rows.
 *
 * Mirrors `indexAriaRefs` on the server: role first, quoted accessible name
 * if present, `[ref=…]` marker last. `nth` is assigned in document order
 * among nodes sharing a role+name, and only marked load-bearing when that
 * pair actually repeats — a redundant `nth: 0` breaks the moment the page
 * grows a second match above the recorded one.
 */
export function parseSnapshot(snapshot: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  const groups = new Map<string, number>();
  /** The node an attribute line belongs to, and how deeply it was indented. */
  let openNode: { node: SnapshotNode; indent: number } | null = null;
  /** Open ancestors, so an unnamed node can still say where it lives. */
  const ancestors: Array<{ depth: number; label: string }> = [];

  for (const line of snapshot.split('\n')) {
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;

    // `- /url: /domains`, `- /placeholder: your@email.com` — an attribute of
    // the node above it, and the closest thing the tree has to a value for a
    // link or an empty input.
    const attrMatch = line.match(/^\s*-\s*\/([A-Za-z-]+):\s*(.+)$/);
    if (attrMatch && openNode && indent > openNode.indent) {
      const [, attribute, raw] = attrMatch;
      if (!openNode.node.value && ['url', 'placeholder', 'value', 'title'].includes(attribute)) {
        openNode.node.value = raw.trim();
      }
      continue;
    }

    const refMatch = line.match(/\[ref=([A-Za-z0-9_-]+)\]/);
    if (!refMatch) continue;
    const body = line.replace(/^\s*-\s*/, '').split(/\s*\[/)[0] ?? '';
    const roleMatch = body.match(/^([A-Za-z][A-Za-z0-9_-]*)/);
    if (!roleMatch) continue;
    const nameMatch = body.match(/"((?:[^"\\]|\\.)*)"/);
    const role = roleMatch[1];
    const name = nameMatch ? nameMatch[1].replace(/\\(.)/g, '$1') : undefined;
    // Text on the node's own line, after the last marker: `generic [ref=e13]:
    // Console access`. A bare trailing `:` opens children instead.
    const inline = line.match(/\]\s*:\s*(\S.*)$/)?.[1]?.trim();
    const key = `${role} ${name ?? ''}`;
    const seen = groups.get(key) ?? 0;
    groups.set(key, seen + 1);
    const depth = Math.floor(indent / 2);

    // Ancestry, from the indentation: everything still open above this node.
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= depth) {
      ancestors.pop();
    }
    const path = ancestors.slice(-3).map((entry) => entry.label).join(' › ');
    ancestors.push({ depth, label: name ? `${role} “${name}”` : role });

    const node: SnapshotNode = {
      ref: refMatch[1],
      role,
      name,
      depth,
      ambiguous: false,
      nth: seen,
      value: inline,
      path: path || undefined,
    };
    nodes.push(node);
    openNode = { node, indent };
  }

  for (const node of nodes) {
    if ((groups.get(`${node.role} ${node.name ?? ''}`) ?? 0) > 1) node.ambiguous = true;
  }
  return nodes;
}

/** Roles worth showing by default — the rest is layout scaffolding. */
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'tab', 'switch', 'searchbox', 'slider', 'spinbutton',
]);
