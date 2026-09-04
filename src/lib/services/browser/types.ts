import type {
  BrowserActionType,
  BrowserFlowStatus,
  BrowserFlowTrigger,
  BrowserSessionStatus,
  BrowserStatus,
  IBrowser,
  IBrowserAccessRules,
  IBrowserFlow,
  IBrowserFlowInput,
  IBrowserFlowRun,
  IBrowserFlowStep,
  IBrowserSession,
  IBrowserSessionConfig,
  IBrowserSessionEvent,
} from '@/lib/database';

// ── DTO views (id-stringified, no Mongo internals) ──────────────────────

export interface BrowserView extends Omit<IBrowser, '_id'> {
  id: string;
}

export interface BrowserSessionView extends Omit<IBrowserSession, '_id'> {
  id: string;
}

export interface BrowserSessionEventView extends Omit<IBrowserSessionEvent, '_id'> {
  id: string;
}

export interface BrowserFlowView extends Omit<IBrowserFlow, '_id'> {
  id: string;
}

export interface BrowserFlowRunView extends Omit<IBrowserFlowRun, '_id'> {
  id: string;
}

// ── Flow service inputs ─────────────────────────────────────────────────

export interface CreateBrowserFlowInput {
  key?: string;
  name: string;
  description?: string;
  status?: BrowserFlowStatus;
  browserId: string;
  inputs?: IBrowserFlowInput[];
  steps?: Array<Partial<IBrowserFlowStep>>;
  sessionConfig?: IBrowserSessionConfig;
  recordedFromSessionId?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateBrowserFlowInput {
  name?: string;
  description?: string;
  status?: BrowserFlowStatus;
  browserId?: string;
  inputs?: IBrowserFlowInput[];
  steps?: Array<Partial<IBrowserFlowStep>>;
  sessionConfig?: IBrowserSessionConfig;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

export interface RecordBrowserFlowInput {
  sessionId: string;
  name: string;
  key?: string;
  description?: string;
  status?: 'draft' | 'active';
  excludeTypes?: string[];
  createdBy: string;
}

export interface RunBrowserFlowInput {
  inputs?: Record<string, unknown>;
  keepSessionOpen?: boolean;
  maxSteps?: number;
  trigger?: BrowserFlowTrigger;
  createdBy: string;
}

// ── Service inputs ──────────────────────────────────────────────────────

export interface CreateBrowserInput {
  key?: string;
  name: string;
  description?: string;
  status?: BrowserStatus;
  artifactBucketKey?: string;
  defaultSessionConfig?: IBrowserSessionConfig;
  defaultModelKey?: string;
  defaultRunOptions?: IBrowser['defaultRunOptions'];
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateBrowserInput {
  name?: string;
  description?: string;
  status?: BrowserStatus;
  artifactBucketKey?: string;
  defaultSessionConfig?: IBrowserSessionConfig;
  defaultModelKey?: string;
  defaultRunOptions?: IBrowser['defaultRunOptions'];
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

export interface CreateBrowserSessionInput {
  browserId: string;
  name?: string;
  agentKey?: string;
  agentId?: string;
  artifactBucketKey?: string;
  config?: IBrowserSessionConfig;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

// ── Element targeting ───────────────────────────────────────────────────

/**
 * How an action names the element it acts on.
 *
 * TWO CLASSES OF FIELD, and the difference is the whole reason flows can be
 * replayed. `ref` is VOLATILE: it is a marker Playwright mints for one
 * `browser_snapshot` and renumbers on the next, so it addresses an element
 * only within the turn that produced it. Everything else is DURABLE: it
 * describes the element the way a person would ("the button labelled Sign
 * in"), so it still resolves tomorrow, after a re-render, and usually after a
 * deploy.
 *
 * A live agent uses `ref` because it is unambiguous and cheap. A RECORDED
 * flow step must never store one — the recorder resolves the ref through the
 * snapshot index into `role`/`name` before persisting it. See
 * `describeRef` in `browserManager`.
 */
export interface BrowserTarget {
  /** Volatile aria marker from the most recent snapshot. Never persist this. */
  ref?: string;
  /** ARIA role. Durable, and paired with `name` in almost every case. */
  role?: string;
  /** Accessible name. Exact match unless `nameContains` is set. */
  name?: string;
  /** Match `name` as a substring rather than in full. */
  nameContains?: boolean;
  /** `data-testid` value — the most durable target when the app provides it. */
  testId?: string;
  /** Text of the associated `<label>`. */
  label?: string;
  /** Input placeholder text. */
  placeholder?: string;
  /** Visible text content. */
  text?: string;
  /** CSS selector. Last resort: breaks on markup changes. */
  selector?: string;
  /** Disambiguates when the strategy above matches several elements. */
  nth?: number;
  /** CSS selector of an iframe to resolve inside, outermost first. */
  frame?: string | string[];
}

/** Which strategy actually resolved a target, for recording and for traces. */
export type BrowserTargetStrategy =
  | 'ref'
  | 'testId'
  | 'role'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'selector';

// ── Browser actions ─────────────────────────────────────────────────────

export interface BrowserActionGoto {
  type: 'goto';
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export interface BrowserActionClick extends BrowserTarget {
  type: 'click';
  button?: 'left' | 'right' | 'middle';
  clickCount?: 1 | 2;
  timeout?: number;
}

export interface BrowserActionHover extends BrowserTarget {
  type: 'hover';
  timeout?: number;
}

export interface BrowserActionTyping extends BrowserTarget {
  type: 'type';
  text: string;
  delay?: number;
  clear?: boolean;
  /** Press Enter after typing — the single most common follow-up. */
  submit?: boolean;
  timeout?: number;
}

export interface BrowserActionPress extends BrowserTarget {
  type: 'press';
  key: string;
  timeout?: number;
}

export interface BrowserActionWait {
  type: 'wait';
  selector?: string;
  ms?: number;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  /** Wait until this text appears anywhere on the page. */
  text?: string;
  /** Wait for a navigation/network state instead of an element. */
  loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export interface BrowserActionScroll extends BrowserTarget {
  type: 'scroll';
  x?: number;
  y?: number;
  timeout?: number;
}

export interface BrowserActionSelect extends BrowserTarget {
  type: 'select';
  /** Option values, labels, or indices — whichever the page exposes. */
  values?: string[];
  labels?: string[];
  timeout?: number;
}

export interface BrowserActionCheck extends BrowserTarget {
  type: 'check';
  /** false unchecks. Idempotent either way, unlike a click. */
  checked?: boolean;
  timeout?: number;
}

export interface BrowserActionUpload extends BrowserTarget {
  type: 'upload';
  /** Files service ids to feed into the file input. */
  fileIds: string[];
  timeout?: number;
}

export interface BrowserActionNavigateHistory {
  type: 'back' | 'forward' | 'reload';
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export interface BrowserActionDrag {
  type: 'drag';
  from: BrowserTarget;
  to: BrowserTarget;
  timeout?: number;
}

export interface BrowserActionTab {
  type: 'tab';
  op: 'new' | 'switch' | 'close' | 'list';
  /** Index into the session's page list, for switch/close. */
  index?: number;
  /** Initial URL, for `new`. */
  url?: string;
}

export type BrowserAction =
  | BrowserActionGoto
  | BrowserActionClick
  | BrowserActionHover
  | BrowserActionTyping
  | BrowserActionPress
  | BrowserActionWait
  | BrowserActionScroll
  | BrowserActionSelect
  | BrowserActionCheck
  | BrowserActionUpload
  | BrowserActionNavigateHistory
  | BrowserActionDrag
  | BrowserActionTab;

export interface BrowserActionResult {
  ok: boolean;
  url?: string;
  pageTitle?: string;
  /** Aria reference snapshot of the page after the action (YAML). */
  ariaSnapshot?: string;
  /**
   * DURABLE description of the element the action actually hit.
   *
   * Present whenever a target resolved. This is what the recorder persists
   * into a flow step, and it is the reason a session driven by volatile refs
   * can still be replayed months later.
   */
  resolvedTarget?: BrowserTarget;
  /** Which strategy won, for trace readers debugging a drifted selector. */
  targetStrategy?: BrowserTargetStrategy;
  /** Open tabs after the action, when the action touched the tab set. */
  tabs?: Array<{ index: number; url: string; title?: string; active: boolean }>;
  /** Optional artifact reference (screenshot triggered after action). */
  artifact?: BrowserArtifactRef;
  errorMessage?: string;
}

export interface BrowserArtifactRef {
  bucketKey: string;
  fileId: string;
  objectKey: string;
  url?: string;
  contentType?: string;
}

export interface BrowserExtractInput extends BrowserTarget {
  /** Mode of extraction. text=innerText, html=outerHTML, attr=attribute value. */
  mode?: 'text' | 'html' | 'attr' | 'value';
  /** Required when mode='attr'. */
  attribute?: string;
  /** When true, extracts from all matching elements. */
  multiple?: boolean;
}

export interface BrowserExtractResult {
  ok: boolean;
  values: string[];
  resolvedTarget?: BrowserTarget;
  errorMessage?: string;
}

export interface BrowserScreenshotInput extends BrowserTarget {
  fullPage?: boolean;
  type?: 'png' | 'jpeg';
  quality?: number;
}

/** One console message or failed request the page produced. */
export interface BrowserObservations {
  console: Array<{ type: string; text: string; at: string }>;
  networkFailures: Array<{ url: string; method?: string; failure?: string; at: string }>;
  lastDialog?: { type: string; message: string; action: string; at: string };
}

export interface BrowserPdfInput {
  format?: 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5';
  landscape?: boolean;
  printBackground?: boolean;
}

export type {
  BrowserActionType as BrowserDbActionType,
  BrowserSessionStatus,
  IBrowserAccessRules,
  IBrowserSession,
  IBrowserSessionConfig,
  IBrowserSessionEvent,
};
