/**
 * Which side of a traced step a section belongs to — what was sent to the
 * model or tool (`input`), what came back (`output`), or the request's
 * configuration (`config`: the tool menu, the response format, model
 * settings).
 *
 * Every integration records this differently and none of them says so
 * explicitly yet:
 *
 *   - agent-sdk replays the whole conversation, appends the model's answer,
 *     then the tool menu;
 *   - @cognipeer/observability adds input sections when a span opens and
 *     output sections when it closes, so the answer is simply last;
 *   - the Claude Agent SDK integration records the answer only;
 *   - tool events everywhere use `tool_call` for the arguments and
 *     `tool_result` for the result;
 *   - chain / graph-node spans use `Input` / `Output` labels.
 *
 * An explicit `direction` on the section always wins, so integrations can
 * start sending it without this file changing. Shared by the API (event
 * summaries) and the UI (detail panel), so both read a step the same way.
 */

export type SectionDirection = 'input' | 'output' | 'config';

export interface SectionShell {
  kind?: unknown;
  role?: unknown;
  label?: unknown;
  tool?: unknown;
  toolName?: unknown;
  name?: unknown;
  direction?: unknown;
  /** A `metadata` section's payload; only its human-step keys are read here. */
  data?: unknown;
}

const CONFIG_KINDS = new Set(['tool_definitions', 'response_format']);
const OUTPUT_LABEL = /^(output|result|tool result|completion|final answer)$/i;
const INPUT_LABEL = /^(input|prompt|arguments|instructions|query)$/i;
const CONFIG_LABEL = /^(model settings|settings|config(uration)?)$/i;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function sectionToolName(section: SectionShell): string | undefined {
  return str(section.tool) ?? str(section.toolName) ?? str(section.name);
}

/**
 * What a `tool_call` section passed in. Integrations disagree on the field:
 * agent-sdk writes `arguments`, the observability SDK and the OTLP mapper
 * write `content` (often a JSON string). A JSON string is parsed back so the
 * inspector can draw it as a tree.
 */
export function sectionToolArgs(section: Record<string, unknown>): unknown {
  const raw = section.content ?? section.arguments ?? section.args ?? section.input;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * What a `tool_result` section brought back: `content` (observability SDK,
 * OTLP) or `output`, falling back to agent-sdk's `summary` when the full
 * output was not kept.
 */
export function sectionToolResult(section: Record<string, unknown>): unknown {
  return section.content ?? section.output ?? section.result ?? section.summary;
}

/**
 * Pairs calls with results when several calls share a tool name: the n-th
 * result of a tool answers its n-th call, so four `web_search` calls render as
 * four exchanges, not one card holding four calls. Reset it at every message.
 */
export function createToolTurnKeys(): { call: (tool: string | undefined, index: number) => string; result: (tool: string | undefined, index: number) => string; reset: () => void } {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  const next = (counts: Map<string, number>, tool: string) => {
    const n = counts.get(tool) ?? 0;
    counts.set(tool, n + 1);
    return `${tool}:${n}`;
  };
  return {
    call: (tool, index) => (tool ? next(calls, tool) : `call-${index}`),
    result: (tool, index) => (tool ? next(results, tool) : `result-${index}`),
    reset: () => {
      calls.clear();
      results.clear();
    },
  };
}

function isModelEvent(eventType: string | undefined): boolean {
  if (!eventType) return false;
  const t = eventType.toLowerCase();
  return t === 'ai_call' || t === 'llm_end' || t.includes('llm') || t.includes('completion') || t.includes('chat');
}

/** A section the model itself produced, as opposed to one it was sent. */
function isModelAuthored(section: SectionShell): boolean {
  const kind = str(section.kind);
  if (kind === 'tool_call' || kind === 'thinking' || kind === 'reasoning') return true;
  return kind === 'message' && str(section.role) === 'assistant';
}

/**
 * Classifies every section of one event, index for index.
 *
 * For a model call the answer is the run of model-authored sections after
 * the last section the model was *sent* (a non-assistant message or a tool
 * result) — everything before it, assistant turns included, is replayed
 * history.
 */
export function classifySections(
  eventType: string | undefined,
  sections: readonly SectionShell[] | undefined,
): SectionDirection[] {
  const list = sections ?? [];
  const result: SectionDirection[] = list.map(() => 'input');

  const modelEvent = isModelEvent(eventType);
  let lastSent = -1;
  if (modelEvent) {
    list.forEach((section, index) => {
      const kind = str(section.kind);
      if (kind && CONFIG_KINDS.has(kind)) return;
      if (kind === 'tool_result' || (kind === 'message' && str(section.role) !== 'assistant')) {
        lastSent = index;
      }
    });
  }

  list.forEach((section, index) => {
    const explicit = str(section.direction);
    if (explicit === 'input' || explicit === 'output' || explicit === 'config') {
      result[index] = explicit;
      return;
    }
    const kind = str(section.kind);
    const label = str(section.label);
    if ((kind && CONFIG_KINDS.has(kind)) || (label && CONFIG_LABEL.test(label))) {
      result[index] = 'config';
      return;
    }
    if (label && OUTPUT_LABEL.test(label)) {
      result[index] = 'output';
      return;
    }
    if (label && INPUT_LABEL.test(label)) {
      result[index] = 'input';
      return;
    }
    if (modelEvent) {
      result[index] = index > lastSent && isModelAuthored(section) ? 'output' : 'input';
      return;
    }
    result[index] = kind === 'tool_result' ? 'output' : 'input';
  });

  return result;
}

export interface EventResponse {
  /** Tools the model asked for in this call's answer, in order, de-duplicated. */
  toolNames: string[];
  /** The answer carried text for the user rather than (only) tool calls. */
  answered: boolean;
}

/**
 * What a model call returned, read from its sections. Unlike the stored
 * `toolName` — derived at ingest from the first section that names a tool,
 * which for a model call is usually a tool call replayed from history — this
 * only looks at the answer.
 */
export function eventResponse(
  eventType: string | undefined,
  sections: readonly SectionShell[] | undefined,
): EventResponse | undefined {
  if (!isModelEvent(eventType) || !sections || sections.length === 0) return undefined;
  const directions = classifySections(eventType, sections);
  const toolNames: string[] = [];
  let answered = false;
  sections.forEach((section, index) => {
    if (directions[index] !== 'output') return;
    const kind = str(section.kind);
    if (kind === 'tool_call') {
      const name = sectionToolName(section);
      if (name && !toolNames.includes(name)) toolNames.push(name);
    } else if (kind === 'message' && str(section.role) === 'assistant') {
      answered = true;
    }
  });
  if (toolNames.length === 0 && !answered) return undefined;
  return { toolNames, answered };
}

// ─── Steps a person took ───────────────────────────────────────────────────

export type HumanStepKind = 'approval' | 'question' | 'client_tool';
export type HumanStepState = 'pending' | 'approved' | 'rejected' | 'answered' | 'cancelled' | 'expired' | 'error';

export interface HumanStep {
  kind: HumanStepKind;
  /** approvalId / questionId: the request and its outcome share it, so a viewer can fold them. */
  key?: string;
  state: HumanStepState;
  /** Who decided or answered, when the integration said so. */
  by?: string;
}

const HUMAN_STATES = new Set<HumanStepState>(['pending', 'approved', 'rejected', 'answered', 'cancelled', 'expired', 'error']);

function sectionData(section: SectionShell): Record<string, unknown> | undefined {
  const data = section.data;
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
}

/** Event types that are a person's step, whatever the integration calls them. */
export function isHumanEventType(type: string | undefined): boolean {
  const t = type?.toLowerCase() ?? '';
  return t === 'tool_approval' || t === 'user_question' || t.includes('approval') || t === 'human_input' || t === 'interrupt';
}

/**
 * The approval, question or host-run tool an event records, and where it
 * stands. agent-sdk ≥ 0.14 writes one event when the run pauses
 * (`status: pending`) and one when it resumes (`decision` / `status`), both
 * keyed by `approvalId` / `questionId`; the console writes the third ending
 * (cancelled / expired) when a pause is abandoned. Other integrations that
 * only send a `tool_approval`-like type still get a kind and a state.
 */
export function humanStep(event: {
  type?: string;
  status?: string;
  sections?: readonly SectionShell[];
}): HumanStep | undefined {
  const type = event.type?.toLowerCase() ?? '';
  const sections = event.sections ?? [];
  let data: Record<string, unknown> | undefined;
  for (const section of sections) {
    const candidate = sectionData(section);
    if (candidate && (str(candidate.approvalId) || str(candidate.questionId))) {
      data = candidate;
      break;
    }
  }

  let kind: HumanStepKind | undefined;
  if (type === 'user_question') kind = 'question';
  else if (isHumanEventType(type)) kind = 'approval';
  else if (data && str(data.questionId) && (type === 'tool_call' || type.startsWith('tool'))) kind = 'client_tool';
  if (!kind) return undefined;

  const declared = str(data?.decision) ?? str(data?.status);
  let state: HumanStepState;
  if (declared && HUMAN_STATES.has(declared as HumanStepState)) state = declared as HumanStepState;
  else if (event.status === 'pending') state = 'pending';
  else if (event.status === 'error') state = 'error';
  else if (event.status === 'skipped') state = 'cancelled';
  else state = kind === 'approval' ? 'approved' : 'answered';
  // A host-run tool reports `answered` when its result came back.
  if (kind === 'client_tool' && state === 'answered' && event.status === 'error') state = 'error';

  return {
    kind,
    key: str(data?.approvalId) ?? str(data?.questionId),
    state,
    by: str(data?.decidedBy) ?? str(data?.answeredBy),
  };
}
