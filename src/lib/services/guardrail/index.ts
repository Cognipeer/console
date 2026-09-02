export {
  createGuardrail,
  updateGuardrail,
  deleteGuardrail,
  getGuardrail,
  getGuardrailByKey,
  listGuardrails,
  evaluateGuardrail,
  serializeGuardrail,
  buildDefaultPresetPolicy,
  buildDefaultPolicy,
  PII_CATEGORIES,
  MODERATION_CATEGORIES,
  PROMPT_SHIELD_ISSUES,
  WORD_FILTER_BUILTIN_LISTS,
} from './guardrailService';

export type {
  CreateGuardrailInput,
  UpdateGuardrailInput,
  GuardrailView,
  GuardrailEvaluationResult,
  GuardrailFinding,
  EvaluateGuardrailInput,
  PiiCategoryDefinition,
  ModerationCategoryDefinition,
  PromptShieldIssueDefinition,
  WordFilterListDefinition,
} from './types';

export {
  createWordList,
  updateWordList,
  deleteWordList,
  getWordList,
  listWordLists,
  parseWordListContent,
  normalizeWordArray,
  resolveCustomWordLists,
  serializeWordList,
  WordListValidationError,
  WORD_LIST_LIMITS,
} from './wordListService';
export type { WordListView } from './wordListService';

export {
  ModerationRequestError,
  normalizeModerationInput,
  resolveModerationGuardrailKey,
  runModeration,
} from './moderationApi';
export type {
  ModerationContext,
  ModerationResponse,
  ModerationResult,
} from './moderationApi';

// ── Hook plane ────────────────────────────────────────────────────────────
//
// The five enforcement points, exported from the barrel so no consumer has to
// reach into `./hooks/*` by path. `evaluateGuardrail` above is one of them
// (`input.pre` / `output.pre` over a plain string); these are the other four,
// plus the pure credential scanner the AI App Gateway calls directly.
//
// Deliberately NOT re-exported: `resolveGuardrail`, `recordCache`'s
// invalidators, `mergeVerdicts`, `applyMutations` and the family runners. They
// are the engine's internals — a caller that reaches for them is building a
// second evaluation path, which is exactly what this rewrite exists to remove.

export { runHook, ensureDefaultToolGuardrail, DEFAULT_TOOL_GUARDRAIL_KEY } from './hooks/engine';
export type {
  HookCall,
  HookVerdict,
  HookSubject,
  HookScope,
  HookActor,
  HookId,
  HookSurface,
  SafetyFinding,
  SafetyAction,
  Mutation,
  PolicyFamily,
  GuardrailHooksConfig,
  GuardrailPolicy,
} from './hooks/contract';
export {
  GUARDRAIL_CONTRACT_VERSION,
  GuardrailEnforcementError,
  textSubject,
  toolCallSubject,
  toolResultSubject,
} from './hooks/contract';

/** Tool enforcement — evaluates `tool.pre`, runs the tool, evaluates
 *  `tool.post`. Throws `GuardrailEnforcementError` when a hook blocks. */
export { executeEnforcedTool } from './hooks/enforce';

/** Real-time streaming enforcement over model chunks. */
export { createStreamGate } from './hooks/streamGate';

/** The MCP seam's tool-call gate. */
export { consoleMcpGuardrailHook } from './hooks/mcpHook';

/** Compiles a guardrail record into the agent SDK's guardrail shape. The only
 *  module that touches `@cognipeer/agent-sdk`, reached via `await import()`. */
export { compileToSdkGuardrail } from './sdkAdapter';

/** Pure, synchronous, DB-free credential detection — no tenant scope, no
 *  policy lookup. This is what the AI App Gateway's hot path calls instead of
 *  borrowing `runPiiDetection` with a synthetic `{ apiKey: true }` policy. */
export { scanSecrets } from './families/secrets';
export type { SecretMatch, ScanSecretsOptions } from './families/secrets';
