/**
 * The tag beside an agent's name wherever a test shows one (Evaluations, Red team): the version a configuration
 * follows by default, or the one a run actually tested. Pure, so the wording and the colours are pinned by unit
 * tests; `AgentWithVersion` only draws it.
 */

import {
  agentRevisionLabel,
  describeRunRevision,
  storedAgentRevision,
  type AgentRevision,
  type IAgentRunRevision,
} from '@/lib/shared/agentRevision';

export interface AgentVersionTagView {
  /** `published`, `v3` or `draft`. */
  label: string;
  /** Teal for published and pinned (as the Agents list shows a published version), orange for the draft, yellow when the draft changed under a run. */
  color: 'teal' | 'orange' | 'yellow';
  /** The hover text; lines are separated by a newline. */
  tooltip: string;
  /** The draft was saved while the run was going. Drawn with a warning icon too, so it is not colour alone. */
  changed: boolean;
}

export const DRAFT_CHANGED_NOTE = 'The draft was saved while this run was in progress';

function colorOf(shown: AgentRevision, changed: boolean): AgentVersionTagView['color'] {
  if (changed) return 'yellow';
  return shown === 'draft' ? 'orange' : 'teal';
}

/**
 * The default of a target or campaign (its stored `agentVersion`), or a version picked in a form. One that was
 * never set, or predates pinning, follows the published version.
 */
export function configVersionTag(stored: unknown): AgentVersionTagView {
  const revision = storedAgentRevision(stored);
  return {
    label: agentRevisionLabel(revision),
    color: colorOf(revision, false),
    tooltip: revision === 'draft'
      ? 'Tests the saved draft, not a published version'
      : revision === 'published'
        ? 'Follows the published version'
        : `Pinned to version ${revision}`,
    changed: false,
  };
}

/**
 * What a run tested: the version that answered (a number), the draft (`null`) or, before the run has started,
 * what it asked for. A run with no recorded revision (it predates the record, or it is not an agent run) has no
 * tag: it shows nothing extra.
 */
export function runVersionTag(run: IAgentRunRevision | null | undefined): AgentVersionTagView | null {
  if (!run) return null;
  const requested = storedAgentRevision(run.requested);
  const shown: AgentRevision = typeof run.version === 'number'
    ? run.version
    : run.version === null ? 'draft' : requested;
  const changed = run.draftChanged === true;
  const described = describeRunRevision({ ...run, requested });
  return {
    label: agentRevisionLabel(shown),
    color: colorOf(shown, changed),
    tooltip: changed ? `${described}\n${DRAFT_CHANGED_NOTE}` : described,
    changed,
  };
}
