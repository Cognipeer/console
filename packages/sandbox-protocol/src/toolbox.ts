/**
 * Toolbox daemon API contract.
 *
 * The toolbox daemon runs INSIDE each sandbox container and exposes
 * filesystem / process / PTY operations over HTTP + WebSocket. The console
 * reaches it by proxying through the runner agent
 * (`/api/sandbox/instances/:id/toolbox/*`). These request/response shapes are
 * the wire contract between the console-side proxy and the daemon.
 *
 * Upload/download of file bytes use raw streams (not JSON) and are documented
 * inline at the route level; the rest is JSON.
 */

/* ----------------------------- Filesystem ------------------------------ */

export interface FsEntry {
  name: string;
  /** Absolute path inside the sandbox. */
  path: string;
  isDir: boolean;
  size: number;
  /** Octal mode string, e.g. "0644". */
  mode: string;
  modifiedAt: string;
}

export interface FsListRequest {
  path: string;
}
export interface FsListResponse {
  entries: FsEntry[];
}

export interface FsInfoRequest {
  path: string;
}
export interface FsInfoResponse {
  entry: FsEntry | null;
}

export interface FsCreateFolderRequest {
  path: string;
  /** Octal mode, defaults to "0755". */
  mode?: string;
}

export interface FsDeleteRequest {
  path: string;
  recursive?: boolean;
}

export interface FsMoveRequest {
  source: string;
  destination: string;
}

export interface FsSetPermissionsRequest {
  path: string;
  mode?: string;
  owner?: string;
  group?: string;
}

/** Recursive content search (grep-like). */
export interface FsFindRequest {
  path: string;
  pattern: string;
}
export interface FsFindMatch {
  file: string;
  line: number;
  content: string;
}
export interface FsFindResponse {
  matches: FsFindMatch[];
}

export interface FsReplaceRequest {
  files: string[];
  pattern: string;
  newValue: string;
}
export interface FsReplaceResponse {
  replaced: number;
}

/* ------------------------------- Process ------------------------------- */

export interface ExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
}
export interface ExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type CodeLanguage = 'python' | 'javascript' | 'typescript' | 'bash';

export interface CodeArtifact {
  type: 'image' | 'file' | 'json';
  name: string;
  mimeType?: string;
  /** Storage key when the artifact was persisted to the volume. */
  key?: string;
}

export interface CodeRunRequest {
  code: string;
  language?: CodeLanguage;
  cwd?: string;
  timeoutSec?: number;
  /** Stateful interpreter context id; omit for stateless run. */
  contextId?: string;
}
export interface CodeRunResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts?: CodeArtifact[];
}

export interface CreateContextRequest {
  contextId: string;
  language: CodeLanguage;
}

/* ---- Long-running sessions (background processes) ---- */

export interface CreateSessionRequest {
  sessionId: string;
}
export interface SessionExecRequest {
  command: string;
  /** Run without blocking; poll logs via the logs endpoint. */
  runAsync?: boolean;
}
export interface SessionExecResponse {
  commandId: string;
  exitCode?: number;
}
export interface SessionCommandInfo {
  id: string;
  command: string;
  exitCode: number | null;
}
export interface SessionInfo {
  sessionId: string;
  commands: SessionCommandInfo[];
}
export interface SessionInputRequest {
  commandId: string;
  input: string;
}

/* --------------------------------- PTY --------------------------------- */

export interface PtyCreateRequest {
  ptyId: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  shell?: string;
}
export interface PtySessionInfo {
  ptyId: string;
  cols: number;
  rows: number;
  active: boolean;
}
export interface PtyResizeRequest {
  cols: number;
  rows: number;
}
