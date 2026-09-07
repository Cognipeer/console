/**
 * The action a person composes in the workbench, and the two payloads it
 * turns into.
 *
 * There are two, and the difference is the whole reason this file exists: the
 * LIVE payload addresses the element by `ref`, which is exact for the
 * snapshot on screen right now; the DURABLE one drops the ref and keeps
 * role+name (or testId, or a selector), which is the only kind of target that
 * survives into a flow step and still resolves tomorrow. The flow editor runs
 * the first and stores the second, from one composer state.
 */

export const ACTION_TYPES = [
  { value: 'goto', label: 'Navigate' },
  { value: 'click', label: 'Click' },
  { value: 'type', label: 'Type' },
  { value: 'select', label: 'Select option' },
  { value: 'check', label: 'Check / uncheck' },
  { value: 'press', label: 'Press key' },
  { value: 'hover', label: 'Hover' },
  { value: 'scroll', label: 'Scroll' },
  { value: 'wait', label: 'Wait' },
  { value: 'extract', label: 'Read value' },
  { value: 'back', label: 'Go back' },
  { value: 'forward', label: 'Go forward' },
  { value: 'reload', label: 'Reload' },
];

/** Which action types address an element rather than the page as a whole. */
export const TARGETED = new Set(['click', 'type', 'select', 'check', 'press', 'hover', 'scroll', 'extract']);

/** Everything a target descriptor may carry — `ref` included, live only. */
export type ElementTarget = Record<string, string | number>;

/** How long `goto` waits before it calls the navigation done. */
export const WAIT_UNTIL_OPTIONS = [
  { value: 'domcontentloaded', label: 'DOM ready (default)' },
  { value: 'load', label: 'Full load' },
  { value: 'networkidle', label: 'Network idle' },
];

export interface ActionDraft {
  type: string;
  url: string;
  waitUntil: 'domcontentloaded' | 'load' | 'networkidle';
  /** Typed text, or the option label for `select`. */
  value: string;
  key: string;
  waitMs: string;
  waitText: string;
  checked: boolean;
  scrollY: string;
  target: ElementTarget;
}

export const EMPTY_DRAFT: ActionDraft = {
  type: 'goto',
  url: '',
  waitUntil: 'domcontentloaded',
  value: '',
  key: 'Enter',
  waitMs: '1000',
  waitText: '',
  checked: true,
  scrollY: '600',
  target: {},
};

/**
 * Build the action payload the session API accepts, or `null` when the draft
 * is not yet runnable (no element picked, no URL typed).
 */
export function buildAction(draft: ActionDraft): Record<string, unknown> | null {
  const action: Record<string, unknown> = { type: draft.type };

  if (TARGETED.has(draft.type)) {
    if (Object.keys(draft.target).length === 0) return null;
    Object.assign(action, draft.target);
  }

  if (draft.type === 'goto') {
    if (!draft.url.trim()) return null;
    action.url = draft.url.trim();
    action.waitUntil = draft.waitUntil;
  }
  if (draft.type === 'type') action.text = draft.value;
  if (draft.type === 'select') action.labels = [draft.value];
  if (draft.type === 'press') action.key = draft.key;
  if (draft.type === 'check') action.checked = draft.checked;
  if (draft.type === 'scroll') action.y = Number(draft.scrollY) || 0;
  if (draft.type === 'wait') {
    if (draft.waitText.trim()) action.text = draft.waitText.trim();
    else action.ms = Number(draft.waitMs) || 1000;
  }

  return action;
}

/**
 * Strip what belongs to one snapshot.
 *
 * A `ref` is a marker the server minted for the tree it just serialized.
 * Stored into a flow it looks like a working target, resolves to nothing on
 * the next run, and spends the step's whole timeout finding that out — which
 * is why the API rejects a step carrying one. Dropping it here means the
 * editor never offers the server a step it will refuse.
 */
export function toDurableAction(action: Record<string, unknown>): Record<string, unknown> {
  const { ref: _ref, ...rest } = action;
  return rest;
}

/** True when an action would lose its only target by dropping `ref`. */
export function targetsOnlyByRef(action: Record<string, unknown>): boolean {
  if (!TARGETED.has(String(action.type))) return false;
  return !['role', 'name', 'testId', 'label', 'placeholder', 'text', 'selector']
    .some((field) => action[field] !== undefined && action[field] !== '');
}

/**
 * Turn a picked snapshot row into a target, asking the page for a real handle
 * when the element has no accessible name.
 *
 * The `ref` is kept for the action about to run — it is exact for the snapshot
 * on screen. What it is paired with is what the STEP will keep, and for an
 * unnamed element that cannot be `{ role: 'button' }`: that matches the first
 * button on the page, so the step would look right and click the wrong thing.
 * `describe` resolves those to a test id or a structural selector.
 */
export async function targetForNode(
  sessionKey: string,
  node: { ref: string; role: string; name?: string; ambiguous: boolean; nth: number },
): Promise<ElementTarget> {
  const target: ElementTarget = { ref: node.ref, role: node.role };
  if (node.name) target.name = node.name;
  if (node.ambiguous) target.nth = node.nth;
  if (node.name) return target;

  try {
    const res = await fetch(`/api/browser/sessions/${encodeURIComponent(sessionKey)}/describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: node.ref }),
    });
    if (!res.ok) return target;
    const data = await res.json();
    const described = (data.target ?? {}) as Record<string, string | number>;
    // The ref stays: the live action should still use the exact handle.
    return { ref: node.ref, ...described };
  } catch {
    // A durable target is a nicety here; failing to get one must not stop the
    // person from acting on the element they just clicked.
    return target;
  }
}

export function describeTarget(target: Record<string, unknown>): string {
  if (target.name) return `${target.role ?? 'element'} “${target.name}”`;
  if (target.testId) return `testId=${target.testId}`;
  if (target.label) return `label “${target.label}”`;
  if (target.placeholder) return `placeholder “${target.placeholder}”`;
  if (target.selector) return String(target.selector);
  if (target.text) return `text “${target.text}”`;
  return String(target.role ?? 'element');
}

export function describeAction(action: Record<string, unknown>): string {
  const type = String(action.type ?? 'extract');
  if (type === 'goto') return `Navigate to ${action.url}`;
  if (type === 'wait') return action.text ? `Wait for “${action.text}”` : `Wait ${action.ms ?? 0}ms`;
  if (type === 'scroll') return `Scroll ${action.y ?? 0}px`;
  if (type === 'back' || type === 'forward' || type === 'reload') return `Navigate ${type}`;
  if (type === 'tab') return `Tab ${action.op}`;

  const target = describeTarget(action);
  if (type === 'type') return `Type into ${target}`;
  if (type === 'click') return `Click ${target}`;
  if (type === 'select') return `Select in ${target}`;
  if (type === 'check') return `${action.checked === false ? 'Uncheck' : 'Check'} ${target}`;
  if (type === 'press') return `Press ${action.key} on ${target}`;
  if (type === 'hover') return `Hover ${target}`;
  if (type === 'extract' || type === 'undefined') return `Read ${target}`;
  return `${type} ${target}`;
}

/** Which action a picked element most likely wants, by its role. */
export function actionForRole(role: string, current: string): string {
  if (role === 'textbox' || role === 'searchbox') return 'type';
  if (role === 'checkbox' || role === 'radio') return 'check';
  if (role === 'combobox') return 'select';
  return TARGETED.has(current) ? current : 'click';
}
