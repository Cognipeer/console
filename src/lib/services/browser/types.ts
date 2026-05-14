import type {
  BrowserActionType,
  BrowserAgentStatus,
  BrowserSessionStatus,
  BrowserStatus,
  IBrowser,
  IBrowserAccessRules,
  IBrowserAgent,
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

export interface BrowserAgentView extends Omit<IBrowserAgent, '_id'> {
  id: string;
}

export interface BrowserSessionEventView extends Omit<IBrowserSessionEvent, '_id'> {
  id: string;
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

export interface CreateBrowserAgentInput {
  browserId: string;
  key?: string;
  name: string;
  description?: string;
  modelKey?: string;
  systemPrompt?: string;
  browserConfig?: IBrowserSessionConfig;
  artifactBucketKey?: string;
  runOptions?: IBrowserAgent['runOptions'];
  status?: BrowserAgentStatus;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateBrowserAgentInput {
  name?: string;
  description?: string;
  modelKey?: string;
  systemPrompt?: string;
  browserConfig?: IBrowserSessionConfig;
  artifactBucketKey?: string;
  runOptions?: IBrowserAgent['runOptions'];
  status?: BrowserAgentStatus;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

// ── Browser actions ─────────────────────────────────────────────────────

export interface BrowserActionGoto {
  type: 'goto';
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

export interface BrowserActionClick {
  type: 'click';
  selector?: string;
  ref?: string;
  button?: 'left' | 'right' | 'middle';
  timeout?: number;
}

export interface BrowserActionHover {
  type: 'hover';
  selector?: string;
  ref?: string;
  timeout?: number;
}

export interface BrowserActionTyping {
  type: 'type';
  selector?: string;
  ref?: string;
  text: string;
  delay?: number;
  clear?: boolean;
}

export interface BrowserActionPress {
  type: 'press';
  selector?: string;
  ref?: string;
  key: string;
}

export interface BrowserActionWait {
  type: 'wait';
  selector?: string;
  ms?: number;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

export interface BrowserActionScroll {
  type: 'scroll';
  selector?: string;
  ref?: string;
  x?: number;
  y?: number;
}

export type BrowserAction =
  | BrowserActionGoto
  | BrowserActionClick
  | BrowserActionHover
  | BrowserActionTyping
  | BrowserActionPress
  | BrowserActionWait
  | BrowserActionScroll;

export interface BrowserActionResult {
  ok: boolean;
  url?: string;
  pageTitle?: string;
  /** Aria reference snapshot of the page after the action (YAML). */
  ariaSnapshot?: string;
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

export interface BrowserExtractInput {
  /** CSS selector or aria ref (one required). */
  selector?: string;
  ref?: string;
  /** Mode of extraction. text=innerText, html=outerHTML, attr=attribute value. */
  mode?: 'text' | 'html' | 'attr';
  /** Required when mode='attr'. */
  attribute?: string;
  /** When true, extracts from all matching elements. */
  multiple?: boolean;
}

export interface BrowserExtractResult {
  ok: boolean;
  values: string[];
  errorMessage?: string;
}

export interface BrowserScreenshotInput {
  fullPage?: boolean;
  selector?: string;
  ref?: string;
  type?: 'png' | 'jpeg';
  quality?: number;
}

export interface BrowserPdfInput {
  format?: 'A4' | 'Letter' | 'Legal' | 'A3' | 'A5';
  landscape?: boolean;
  printBackground?: boolean;
}

export interface BrowserAgentRunInput {
  prompt: string;
  /** Reuse an existing session by sessionKey instead of creating a new one. */
  sessionKey?: string;
  /** Override session config for this run. */
  sessionConfig?: IBrowserSessionConfig;
  /** Custom metadata applied to the spawned session. */
  metadata?: Record<string, unknown>;
}

export interface BrowserAgentRunResult {
  sessionKey: string;
  sessionId: string;
  output: string;
  toolCalls: number;
  durationMs: number;
  status: 'success' | 'error';
  errorMessage?: string;
}

export type {
  BrowserActionType as BrowserDbActionType,
  BrowserAgentStatus,
  BrowserSessionStatus,
  IBrowserAccessRules,
  IBrowserAgent,
  IBrowserSession,
  IBrowserSessionConfig,
  IBrowserSessionEvent,
};
