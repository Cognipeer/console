import type { ObjectId } from 'mongodb';
import type { IUsageAttributionFields } from './types.base';
import type { GuardrailAction, GuardrailType } from './types.domain';
// ── Memory types ─────────────────────────────────────────────────────────

export type MemoryScope = 'user' | 'agent' | 'session' | 'global';
export type MemorySource = 'chat' | 'api' | 'agent' | 'manual';
export type MemoryStoreStatus = 'active' | 'inactive' | 'error';
export type MemoryItemStatus = 'active' | 'archived' | 'expired';

export interface IMemoryStoreConfig {
  embeddingDimension: number;
  metric: 'cosine' | 'euclidean' | 'dotproduct';
  defaultScope: MemoryScope;
  deduplication: boolean;
  autoSummarize: boolean;
  maxMemories?: number;
  ttlDays?: number;
}

export interface IMemoryStore {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  key: string;
  name: string;
  description?: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  embeddingModelKey: string;
  config: IMemoryStoreConfig;
  status: MemoryStoreStatus;
  memoryCount: number;
  lastActivityAt?: Date;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IMemoryItem {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  storeKey: string;
  content: string;
  contentHash: string;
  summary?: string;
  scope: MemoryScope;
  scopeId?: string;
  metadata: Record<string, unknown>;
  tags: string[];
  source?: MemorySource;
  importance: number;
  accessCount: number;
  lastAccessedAt?: Date;
  embeddingVersion: string;
  vectorId: string;
  expiresAt?: Date;
  status: MemoryItemStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IGuardrailEvaluationLog extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  guardrailId: string;
  guardrailKey: string;
  guardrailName: string;
  guardrailType: GuardrailType;
  /** Phase the evaluation ran in — decided by the binding slot, not the guardrail. */
  target: 'input' | 'output';
  action: GuardrailAction;
  passed: boolean;
  findings: Array<{
    type: string;
    category: string;
    severity: 'low' | 'medium' | 'high';
    message: string;
    action: string;
    block: boolean;
    value?: string;
  }>;
  inputText?: string;
  latencyMs?: number;
  source?: string;
  requestId?: string;
  message?: string | null;
  createdAt?: Date;
}

export interface IGuardrailEvalAggregate {
  guardrailId: string;
  totalEvaluations: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  avgLatencyMs: number | null;
  findingsByType: Record<string, number>;
  findingsBySeverity: Record<string, number>;
  timeseries?: Array<{
    period: string;
    total: number;
    passed: number;
    failed: number;
  }>;
}

// ── Config (Secret/Configuration Management) types ───────────────────────

export type ConfigValueType = 'string' | 'number' | 'boolean' | 'json';

export interface IConfigGroup {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IConfigItem {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  groupId: string;
  key: string;
  name: string;
  description?: string;
  /** Stored value. If `isSecret` is true, this is encrypted at rest. */
  value: string;
  valueType: ConfigValueType;
  isSecret: boolean;
  tags?: string[];
  version: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IConfigAuditLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  configKey: string;
  action: 'create' | 'update' | 'delete' | 'read';
  previousValue?: string;
  newValue?: string;
  version?: number;
  performedBy: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

// ── MCP Server types ─────────────────────────────────────────────────────

export type McpServerStatus = 'active' | 'disabled';

export type McpAuthType = 'none' | 'token' | 'header' | 'basic';

export interface IMcpAuthConfig {
  type: McpAuthType;
  /** For 'token': the bearer token value */
  token?: string;
  /** For 'header': custom header name + value */
  headerName?: string;
  headerValue?: string;
  /** For 'basic': username + password */
  username?: string;
  password?: string;
  /**
   * Encrypted-at-rest secret payload (AES-256-GCM). When set, the plaintext
   * secret fields above are absent from the stored record and must be
   * recovered through the MCP secret vault before use.
   */
  sealed?: string;
}

/** Where the server's tools come from. Legacy records (no field) are 'openapi'. */
export type McpSourceType = 'openapi' | 'remote' | 'stdio';

/** Protocols the gateway exposes for a server. */
export type McpExposureProtocol = 'streamable-http' | 'sse';

/** How callers authenticate against the exposed MCP endpoint. */
export type McpAccessMode = 'token' | 'public';

export interface IMcpExposureConfig {
  protocols: McpExposureProtocol[];
  accessMode: McpAccessMode;
}

/** Upstream remote MCP server the gateway proxies. */
export interface IMcpRemoteConfig {
  url: string;
  transport: 'streamable-http' | 'sse';
}

export type McpStdioRuntime = 'npx' | 'uvx';
export type McpStdioExecutionMode = 'subprocess' | 'sandbox';

export interface IMcpSandboxResources {
  cpuCores?: number;
  memoryMb?: number;
}

/** Locally-launched MCP server (npx / uvx package) config. */
export interface IMcpStdioConfig {
  runtime: McpStdioRuntime;
  /** Package spec, e.g. "@modelcontextprotocol/server-everything" or "mcp-server-fetch" */
  packageName: string;
  args?: string[];
  /** Plaintext env var names → values. Secret values are sealed into envSealed. */
  env?: Record<string, string>;
  /** Encrypted-at-rest env payload (AES-256-GCM JSON of Record<string,string>). */
  envSealed?: string;
  executionMode: McpStdioExecutionMode;
  /** Only for executionMode 'sandbox'. */
  sandbox?: {
    templateKey?: string;
    resources?: IMcpSandboxResources;
    /** Persistent sandbox instance backing this server (set once provisioned). */
    instanceId?: string;
  };
}

/** Aegis integration seam — enforcement is wired by the enterprise overlay. */
export interface IMcpAegisConfig {
  shieldId?: string;
  mode: 'off' | 'monitor' | 'enforce';
}

export interface IMcpServer {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  /** Tool source. Legacy records without the field are treated as 'openapi'. */
  sourceType?: McpSourceType;
  /** Raw OpenAPI spec JSON string (sourceType 'openapi' only). */
  openApiSpec?: string;
  /** Remote upstream MCP config (sourceType 'remote'). */
  remoteConfig?: IMcpRemoteConfig;
  /** Stdio launch config (sourceType 'stdio'). */
  stdioConfig?: IMcpStdioConfig;
  /** Parsed/discovered tool definitions */
  tools: IMcpTool[];
  /** When tools were last discovered from a remote/stdio source. */
  toolsDiscoveredAt?: Date;
  /** Upstream base URL (sourceType 'openapi'). */
  upstreamBaseUrl?: string;
  /** Authentication for upstream API/MCP calls */
  upstreamAuth: IMcpAuthConfig;
  /** Endpoint exposure: enabled protocols + access mode. Default: both + token. */
  exposure?: IMcpExposureConfig;
  /** Aegis shield binding (prep — enforcement lands with the EE integration). */
  aegis?: IMcpAegisConfig;
  status: McpServerStatus;
  /** Unique slug used in the public MCP endpoint URL */
  endpointSlug: string;
  totalRequests?: number;
  /** Last runtime error observed for this server (stdio spawn/remote probe). */
  lastError?: { message: string; at: Date } | null;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IMcpTool {
  name: string;
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: Record<string, unknown>;
  /** HTTP method mapped from the OpenAPI operation (sourceType 'openapi'). */
  httpMethod?: string;
  /** Path template from the OpenAPI spec (sourceType 'openapi'). */
  httpPath?: string;
}

/** Who initiated an MCP tool call. */
export type McpCallerType = 'dashboard' | 'api' | 'agent' | 'public';

/** Which surface the call arrived on. */
export type McpCallTransport = 'rest' | 'jsonrpc' | 'sse' | 'internal';

export interface IMcpRequestLog extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  serverKey: string;
  toolName: string;
  status: 'success' | 'error';
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  errorMessage?: string;
  latencyMs?: number;
  callerTokenId?: string;
  callerType?: McpCallerType;
  callerUserId?: string;
  transport?: McpCallTransport;
  sourceType?: McpSourceType;
  /** SSE session id when the call arrived over an SSE session. */
  sessionId?: string;
  createdAt?: Date;
}

// ── MCP audit log ─────────────────────────────────────────────────────────

export type McpAuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'status_change'
  | 'exposure_change'
  | 'secrets_change'
  | 'tools_refresh'
  | 'playground_execute';

export interface IMcpAuditLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  serverId?: string;
  serverKey: string;
  action: McpAuditAction;
  /** Field-level diff with secrets masked. */
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  performedBy: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface IMcpRequestAggregate {
  serverKey: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  toolBreakdown: Record<string, number>;
  timeseries?: Array<{
    period: string;
    total: number;
    success: number;
    errors: number;
  }>;
}

// ── Cluster: nodes & instance assignments ────────────────────────────────

export type NodeRole = 'main' | 'worker' | 'all';
export type NodeStatus = 'online' | 'offline' | 'draining';

export interface INodeRecord {
  name: string;
  role: NodeRole;
  url: string | null;
  tags: string[];
  status: NodeStatus;
  lastHeartbeatAt: Date;
  startedAt: Date;
  version: string | null;
  hostname: string | null;
  pid: number | null;
}

export type InstanceEntityType =
  | 'agent'
  | 'mcp'
  | 'browser'
  | 'inference-server'
  | 'alert-rule'
  | 'automation'
  | 'crawler'
  | 'ocr'
  | 'batch';

export type InstanceAssignmentMode = 'strict' | 'preferred';

export interface IInstanceAssignment {
  entityType: InstanceEntityType;
  entityId: string;
  nodeName: string;
  mode: InstanceAssignmentMode;
  updatedAt: Date;
  updatedBy: string | null;
}

// ── Beta access codes (main database) ────────────────────────────────────

export type BetaAccessCodeStatus = 'active' | 'used' | 'disabled';

export interface IBetaAccessCode {
  /** The code itself (stored normalized: trimmed, uppercase). Unique. */
  code: string;
  status: BetaAccessCodeStatus;
  note: string | null;
  usedByEmail: string | null;
  usedAt: Date | null;
  createdAt: Date;
}

// ── GPU fleet (tenant-scoped) ────────────────────────────────────────────

export type GpuHostStatus =
  /** Created via console, awaiting first agent handshake. (legacy single-host flow) */
  | 'pending'
  /** Self-registered via fleet token, awaiting admin claim. */
  | 'pending_claim'
  | 'online'
  | 'offline'
  | 'draining'
  | 'archived';
export type GpuHostProvider = 'azure' | 'aws' | 'gcp' | 'self';
export type GpuHostAccelerator =
  | 'nvidia-gpu'
  | 'apple-silicon'
  | 'amd-gpu'
  | 'cpu';
export type GpuHostGpuFramework = 'cuda' | 'rocm' | 'metal' | 'none';

export interface IGpuHost {
  _id?: string;
  tenantId: string;
  /** UUID, stable across rename. Used in agent JWT as `sub`. */
  id: string;
  /** Admin-facing name. Defaults to OS hostname; renamable. */
  name: string;
  provider: GpuHostProvider;
  status: GpuHostStatus;
  /** Hash of the active agent token; raw token never stored. */
  agentTokenHash: string | null;
  /** Token version — bumped on rotation. */
  agentTokenVersion: number;
  /** Hash of the pending one-time registration token (cleared after handshake). */
  registrationTokenHash: string | null;
  registrationTokenExpiresAt: Date | null;
  /** Last reported inventory (snapshot JSON). */
  inventory: Record<string, unknown> | null;
  /** Accelerator family — derived from inventory, surfaced for fast filtering. */
  accelerator: GpuHostAccelerator;
  /** GPU framework available on this host. */
  gpuFramework: GpuHostGpuFramework;
  /** IP/hostname the console + pool proxy use to reach this host's containers. */
  serviceAddress: string | null;
  /** When true, admins may open remote shell sessions. Defaults to false. */
  terminalEnabled: boolean;
  /** Free-form labels admin attaches. */
  labels: Record<string, string>;
  lastHeartbeatAt: Date | null;
  lastEventSequence: number;
  agentVersion: string | null;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type GpuSliceKind = 'full-gpu' | 'mig';

export interface IGpuSlice {
  _id?: string;
  tenantId: string;
  hostId: string;
  /** UUID from nvidia-smi (GPU UUID for full-gpu, MIG UUID for mig slices). */
  uuid: string;
  gpuUuid: string;
  migGiId: number | null;
  migCiId: number | null;
  kind: GpuSliceKind;
  profile: string | null;
  memoryMiB: number;
  /**
   * Deployment ids currently bound to this slice. A slice can host more than
   * one deployment at once (e.g. several small models sharing one GPU/MIG
   * partition) — capacity/VRAM budgeting across members is the operator's
   * responsibility, the console does not enforce it.
   */
  assignedDeploymentIds: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export type LlmDeploymentRuntime = 'vllm' | 'tgi' | 'ollama' | 'custom';

export type LlmDeploymentDesiredState = 'running' | 'stopped';

export type LlmDeploymentActualState =
  | 'pending'
  | 'pulling'
  | 'starting'
  | 'healthy'
  | 'unhealthy'
  | 'stopped'
  | 'failed'
  | 'draining'
  | 'removing';

export interface ILlmDeployment {
  _id?: string;
  tenantId: string;
  /** Stable UUID, used as the docker container name suffix. */
  id: string;
  hostId: string;
  /** Slice UUID this deployment is pinned to. May be null when draining for MIG reconfig. */
  sliceUuid: string | null;
  name: string;
  runtime: LlmDeploymentRuntime;
  image: string;
  modelName: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  healthPath: string;
  volumes: Array<{
    hostPath: string;
    containerPath: string;
    readOnly?: boolean;
  }>;
  restart: 'no' | 'on-failure' | 'always' | 'unless-stopped';
  desiredState: LlmDeploymentDesiredState;
  actualState: LlmDeploymentActualState;
  /** Container id from the agent's last report. */
  containerId: string | null;
  lastHealthyAt: Date | null;
  lastError: string | null;
  /**
   * When healthy, the console auto-registers an `IInferenceServer` pointing at
   * this deployment. Storing the key here lets us tear it back down on stop.
   */
  inferenceServerKey: string | null;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type GpuFleetCommandStatus =
  | 'pending'
  | 'delivered'
  | 'completed'
  | 'failed';

export interface IGpuFleetCommand {
  _id?: string;
  tenantId: string;
  id: string;
  hostId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: GpuFleetCommandStatus;
  attempts: number;
  lastError: string | null;
  issuedAt: Date;
  deliveredAt: Date | null;
  completedAt: Date | null;
  /** Optional reference back to the entity being mutated (deployment id, gpuUuid…). */
  resourceRef: string | null;
  createdBy: string;
}

export interface IGpuFleetEvent {
  _id?: string;
  tenantId: string;
  hostId: string;
  sequence: number;
  kind: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
  createdAt?: Date;
}

export type AgentDistributionMode = 'console-served' | 'external-url';

// ── LLM pool (load-balanced multi-host deployment) ───────────────────────

export type LlmPoolAlgorithm =
  | 'round-robin'
  | 'least-busy'
  | 'weighted-static'
  | 'random';
export type LlmPoolStatus = 'active' | 'disabled';

export interface ILlmPool {
  _id?: string;
  tenantId: string;
  /** Pool key — used in the proxy URL: /api/internal/gpu-pool/<key>/v1/*. */
  key: string;
  name: string;
  description: string | null;
  /** Model identifier this pool serves (HF repo id or library id). */
  modelName: string;
  /** Library id when the pool was created from the catalog; null for custom. */
  modelLibraryId: string | null;
  algorithm: LlmPoolAlgorithm;
  status: LlmPoolStatus;
  /** Deployment ids that are members of this pool. Maintained by the ingestor. */
  deploymentIds: string[];
  /** Optional weights for weighted-static; keyed by deploymentId. */
  weights: Record<string, number>;
  /** Once auto-registration runs, these are the records the pool published. */
  providerKey: string | null;
  modelKey: string | null;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IGpuFleetSettings {
  _id?: string;
  tenantId: string;
  /** SHA-256 hash of the tenant-wide fleet registration token. */
  fleetTokenHash: string | null;
  fleetTokenRotatedAt: Date | null;
  fleetTokenRotatedBy: string | null;
  agentDistributionMode: AgentDistributionMode;
  /** Used when mode === 'external-url'; supports {{platform}} placeholder. */
  agentDistributionExternalUrlTemplate: string | null;
  terminalSessionTtlSeconds: number;
  /**
   * Encrypted Hugging Face access token, auto-injected as
   * HUGGING_FACE_HUB_TOKEN/HF_TOKEN into vLLM/TGI/Ollama deployments so
   * gated/private model repos can be pulled without per-deployment setup.
   */
  huggingFaceTokenEnc: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * One `nvidia-smi` reading for one physical GPU on one host, recorded at a
 * throttled cadence (see recordGpuHostMetrics in hostService.ts) so history
 * charts have reasonable resolution without unbounded row growth.
 */
export interface IGpuHostMetrics {
  _id?: string;
  tenantId: string;
  hostId: string;
  /** Physical GPU UUID — matches IGpuSlice.gpuUuid. */
  gpuUuid: string;
  gpuIndex: number;
  timestamp: Date;
  utilizationGpuPercent: number | null;
  utilizationMemoryPercent: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
  createdAt?: Date;
}

// =====================================================================
// Agent Runtime Sandbox
//
// A self-contained subsystem, independent of the GPU fleet types above.
// Tables are prefixed `sandbox_` and share nothing with gpu-fleet/cluster.
// =====================================================================

export type SandboxRunnerStatus =
  | 'pending'
  | 'online'
  | 'offline'
  | 'pending_claim';

/** A DinD (later K8s) compute node that runs sandbox containers. */
export interface ISandboxRunner {
  id: string;
  tenantId: string;
  name: string;
  status: SandboxRunnerStatus;
  labels: Record<string, string>;
  /** Free-form node inventory: cpu/ram/disk + supported runtime classes. */
  inventory: Record<string, unknown> | null;
  agentTokenHash: string | null;
  agentTokenVersion: number;
  registrationTokenHash: string | null;
  registrationTokenExpiresAt: Date | null;
  lastSeenAt: Date | null;
  /** Watermark of the last applied event sequence (replay protection). */
  lastEventSequence: number;
  terminalEnabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Reusable, admin-defined sandbox recipe. */
export interface ISandboxTemplate {
  id: string;
  tenantId: string;
  projectId: string | null;
  key: string;
  name: string;
  description: string | null;
  baseImage: string;
  /** SandboxRuntimeKind from the wire protocol. */
  runtime: string;
  /** SandboxIsolation: runc | gvisor | kata. */
  isolation: string;
  resources: Record<string, unknown>;
  env: Record<string, string>;
  entrypoint: string[] | null;
  toolboxPort: number;
  previewPorts: Array<Record<string, unknown>>;
  volumeMounts: Array<Record<string, unknown>>;
  /** Idle window (seconds) before reaping a sandbox of this template; null = use the tenant/config default. */
  idleReapSeconds: number | null;
  /** Number of pre-started "warm" sandboxes kept ready for instant launch (0/null = off). */
  warmPoolSize: number | null;
  enabled: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SandboxInstanceState =
  | 'pending'
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'deleted';

export type SandboxDesiredState = 'running' | 'stopped' | 'deleted';

/**
 * A running (or desired) sandbox container.
 *
 * Carries the usage attribution envelope (userId/apiTokenId/actorType),
 * stamped at creation/claim time so the stop-time usage rollup can attribute
 * runtime to the owner even when the lifecycle transition is system-initiated
 * (idle reaper). `createdBy` predates the envelope and remains the raw caller
 * label (dashboard userId, or markers like 'api-token' / 'system:warm').
 */
export interface ISandboxInstance extends IUsageAttributionFields {
  id: string;
  tenantId: string;
  projectId: string | null;
  templateId: string;
  runnerId: string | null;
  name: string;
  containerId: string | null;
  /**
   * The concrete image this instance was launched from. Set when the instance
   * was created from a snapshot/fork (the captured image) instead of the plain
   * template base. Persisted so every later lifecycle rebuild (start after
   * stop, boot redrive, volume attach) relaunches from the SAME image — without
   * it, `resolveSpec` silently falls back to `template.baseImage`, which for a
   * snapshot-restored sandbox swaps it to a bare base image (the meeting-bot
   * "snapshot rot" failure: Xvfb/PulseAudio/deps vanish). null = use the base.
   */
  imageRef?: string | null;
  desiredState: SandboxDesiredState;
  actualState: SandboxInstanceState;
  volumeId: string | null;
  toolboxPort: number | null;
  previewPorts: Array<Record<string, unknown>>;
  isolation: string;
  /** Per-instance environment variables passed to the container. */
  env: Record<string, string>;
  /**
   * Persistent sandbox: the control plane keeps it alive across node/daemon
   * failures (boot reconcile recreates the container and re-mounts the same
   * volume) and exempts it from the idle reaper. Ephemeral boxes (`false`) are
   * reaped on idle and not recreated.
   */
  persist: boolean;
  /** Block all outbound network access from the sandbox container. */
  blockNetwork: boolean;
  /**
   * Port preview enabled for this sandbox. When false, the preview proxy (and
   * share links) refuse access regardless of running state. Defaults to true.
   */
  previewEnabled?: boolean;
  /**
   * Allow public (session-less, signed share-link) preview access. When false,
   * preview is private — reachable only through the authenticated proxy (login).
   * Public links additionally require SANDBOX_PREVIEW_SECRET. Defaults to false.
   */
  previewPublic?: boolean;
  /** Per-instance resource limit override ({cpuCores,memoryMb,diskMb,pids}); null = use the template's. */
  resources: Record<string, unknown> | null;
  /** True while this is an unassigned pre-warmed pool container (hidden from users). */
  warm: boolean;
  /** Which warm pool this belongs to: `template:<id>` or `snapshot:<id>` (null when not pooled). */
  warmKey: string | null;
  lastError: string | null;
  lastActivityAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type SandboxCommandStatus =
  | 'pending'
  | 'delivered'
  | 'completed'
  | 'failed';

export interface ISandboxCommand {
  id: string;
  tenantId: string;
  runnerId: string;
  instanceId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: SandboxCommandStatus;
  attempts: number;
  lastError: string | null;
  issuedAt: Date;
  deliveredAt: Date | null;
  completedAt: Date | null;
  createdBy: string;
}

export interface ISandboxEvent {
  id: string;
  tenantId: string;
  runnerId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  receivedAt: Date;
}

export type SandboxStorageProviderKind = 'azure-blob' | 's3' | 'local';

/**
 * Persistent volume backed by object storage. Volumes are created from a file
 * **bucket** (see `bucketKey`): the bucket's storage provider supplies the
 * concrete object-store coordinates (`provider`/`container`) and credentials,
 * so the volume rides the same proven storage layer as the files module. The
 * agent mounts it live via FUSE; the console can read/write objects under
 * `prefix` directly through the bucket's provider runtime (no container needed).
 */
export interface ISandboxVolume {
  id: string;
  tenantId: string;
  projectId: string | null;
  name: string;
  provider: SandboxStorageProviderKind;
  /** Azure Blob container or S3 bucket. */
  container: string;
  prefix: string;
  /** File-bucket this volume is backed by (resolves provider + credentials). */
  bucketKey: string | null;
  sizeBytes: number | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What a snapshot captures and where it lives. */
export type SandboxSnapshotKind = 'snapshot' | 'backup';

/** Lifecycle of a snapshot as it is committed and (optionally) exported. */
export type SandboxSnapshotStatus =
  | 'committing'
  | 'exporting'
  | 'ready'
  | 'failed';

/**
 * A point-in-time capture of a sandbox container filesystem (`docker commit`).
 * A `snapshot` lives only as a local image on its runner; a `backup` has also
 * been exported to object storage so it survives the runner and can be
 * re-imported elsewhere. Snapshots are the primitive behind resume, fork and
 * file-level backup.
 */
export interface ISandboxSnapshot {
  id: string;
  tenantId: string;
  projectId: string | null;
  /** Source instance (may have been deleted since the snapshot was taken). */
  instanceId: string | null;
  /** Template the source used; needed to rebuild a spec on restore/fork. */
  templateId: string | null;
  /** Runner holding the local image (null once only the export remains). */
  runnerId: string | null;
  name: string;
  description: string | null;
  kind: SandboxSnapshotKind;
  /** Local docker image tag/ref the snapshot was committed to. */
  imageRef: string;
  /** Storage location of the exported image tarball (when kind='backup'). */
  storageProvider: SandboxStorageProviderKind | null;
  storageContainer: string | null;
  storageKey: string | null;
  /** Source volume captured alongside the image (for fork volume copy). */
  volumeId: string | null;
  /** Network policy captured at snapshot time; launches from here default to it. */
  blockNetwork: boolean;
  /** Resource override captured at snapshot time ({cpuCores,memoryMb,diskMb}); null = template's. */
  resources: Record<string, unknown> | null;
  /** Pre-started "warm" sandboxes kept ready to resume from this snapshot (0/null = off; only for volume-less snapshots). */
  warmPoolSize: number | null;
  sizeBytes: number | null;
  status: SandboxSnapshotStatus;
  lastError: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISandboxSettings {
  id: string;
  tenantId: string;
  fleetTokenHash: string | null;
  terminalSessionTtlSeconds: number;
  defaultStorageProvider: string | null;
  defaultIsolation: string | null;
  idleReapSeconds: number;
  /**
   * Per-project default resource limits for new sandboxes, keyed by projectId.
   * Each value is a partial `{cpuCores,memoryMb,diskMb,pids}`. Falls back to the
   * platform default (SANDBOX_DEFAULT_*) and is clamped to the hard cap
   * (SANDBOX_MAX_*). Empty/absent = use the platform default for every project.
   */
  projectResourceDefaults?: Record<string, Record<string, number>> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── OCR jobs (persistent container + per-file extraction) ──────────────────

/**
 * An OCR Job is a persistent "container": it holds the extraction rules
 * (models, outputs, schema), a storage area (bucket + prefix) and an optional
 * callback. Files are sent to it over time; each file becomes an item that is
 * processed independently via per-item queue fan-out.
 */
export type OcrJobStatus = 'active' | 'paused' | 'archived';

export type OcrJobItemStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** Which outputs to collect per file. `full_text` is always produced. */
export type OcrOutputKind = 'full_text' | 'summary' | 'structured';

/** Per-file delivery mode when sending files to a job. */
export type OcrJobMode = 'sync' | 'async';

/** Per-file webhook events plus the job-level completion signal. */
export type OcrJobWebhookEvent =
  | 'item.succeeded'
  | 'item.failed'
  | 'job.completed';

export type OcrJobItemCallbackStatus = 'delivered' | 'failed' | 'skipped';

/**
 * Per-item input source. `bucket` references a Document Store object (the
 * default at scale); `inline` carries base64 bytes (small/ad-hoc); `url`
 * points at a remote file.
 */
export type OcrJobItemSource =
  | { kind: 'inline'; data: string; fileName?: string; contentType?: string }
  | { kind: 'bucket'; bucketKey: string; objectKey: string }
  | { kind: 'url'; url: string; contentType?: string };

export interface IOcrJob extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  name?: string;
  status: OcrJobStatus;
  // ── Storage (files land here) ──
  /** File bucket key where uploaded documents are stored. */
  bucketKey: string;
  /** Prefix namespacing this job's files (e.g. `ocr-jobs/<id>/`). */
  prefix?: string;
  // ── Rules ──
  /** Registered model key with category 'ocr'. */
  ocrModelKey: string;
  /** Registered LLM model key; required when outputs include summary/structured. */
  llmModelKey?: string;
  outputs: OcrOutputKind[];
  /** Optional free-text instruction (or stored prompt) used for summarization. */
  summaryPrompt?: string;
  /** JSON schema passed to the LLM as response_format for structured extraction. */
  structuredSchema?: Record<string, unknown>;
  language?: string;
  features?: string[];
  /** Max PDF pages to rasterize for VLM OCR; 0/undefined = unlimited. */
  pdfMaxPages?: number;
  // ── Callback ──
  callbackUrl?: string;
  callbackSecret?: string;
  callbackEvents?: OcrJobWebhookEvent[];
  // ── Running aggregates ──
  itemsTotal: number;
  itemsProcessed: number;
  itemsFailed: number;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  usageTotalTokens?: number;
  usagePages?: number;
  /** Token/cost split by stage for detailed usage reporting. */
  usageOcrTokens?: number;
  usageLlmTokens?: number;
  costOcr?: number;
  costLlm?: number;
  costTotal?: number;
  costCurrency?: string;
  lastItemAt?: Date;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IOcrJobItemResult {
  fullText?: string;
  summary?: string;
  structured?: Record<string, unknown>;
  pages?: number;
}

export interface IOcrJobItem {
  _id?: ObjectId | string;
  tenantId: string;
  jobId: string;
  index: number;
  source: OcrJobItemSource;
  fileName?: string;
  status: OcrJobItemStatus;
  result?: IOcrJobItemResult;
  usage?: {
    ocr?: Record<string, unknown>;
    llm?: Record<string, unknown>;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    pages?: number;
  };
  costTotal?: number;
  costCurrency?: string;
  callbackStatus?: OcrJobItemCallbackStatus;
  errorMessage?: string;
  startedAt?: Date;
  endedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Atomic aggregate increments applied to a job as items complete. */
export interface OcrJobAggregateDelta {
  itemsTotal?: number;
  itemsProcessed?: number;
  itemsFailed?: number;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  usageTotalTokens?: number;
  usagePages?: number;
  usageOcrTokens?: number;
  usageLlmTokens?: number;
  costOcr?: number;
  costLlm?: number;
  costTotal?: number;
}

// ── Batch API (OpenAI-compatible async bulk inference) ─────────────────────

/**
 * A Batch is a one-shot bulk inference job: a set of chat-completion or
 * embedding requests submitted together (inline or as a JSONL file in a
 * Document Store bucket) and executed asynchronously via per-item queue
 * fan-out. Mirrors the OpenAI `/v1/batches` lifecycle.
 */
export type BatchJobStatus =
  | 'validating'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled';

/** Target route each line of the batch is executed against. */
export type BatchJobEndpoint = '/v1/chat/completions' | '/v1/embeddings';

export type BatchJobItemStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Reference to a JSONL object in a Document Store bucket. */
export interface BatchFileRef {
  bucketKey: string;
  objectKey: string;
}

export interface IBatchJob extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  endpoint: BatchJobEndpoint;
  status: BatchJobStatus;
  /** Informational (OpenAI compat); items run as soon as workers are free. */
  completionWindow?: string;
  /** Where the input JSONL came from (absent for inline submissions). */
  inputFile?: BatchFileRef;
  /**
   * Output JSONL destination. `bucketKey` is set at submission when the
   * caller requested a file; `objectKey` is filled in by the finalizer.
   */
  outputFile?: { bucketKey: string; objectKey?: string };
  /** Batch-level failure reason (validation/finalization errors). */
  errorMessage?: string;
  itemsTotal: number;
  itemsSucceeded: number;
  itemsFailed: number;
  itemsCancelled: number;
  usageInputTokens: number;
  usageOutputTokens: number;
  usageTotalTokens: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBatchJobItem {
  _id?: ObjectId | string;
  tenantId: string;
  batchId: string;
  /** Original line position in the submitted input (0-based). */
  index: number;
  /** Caller-supplied correlation id (OpenAI `custom_id`). */
  customId?: string;
  /** Request body of this line (chat-completion or embedding payload). */
  requestBody: Record<string, unknown>;
  status: BatchJobItemStatus;
  /** HTTP-equivalent status of the executed request (200 on success). */
  responseStatusCode?: number;
  responseBody?: Record<string, unknown>;
  errorMessage?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  startedAt?: Date;
  endedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Atomic aggregate increments applied to a batch as items complete. */
export interface BatchJobAggregateDelta {
  itemsTotal?: number;
  itemsSucceeded?: number;
  itemsFailed?: number;
  itemsCancelled?: number;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  usageTotalTokens?: number;
}

// ── Realtime API (named realtime models + session logs) ────────────────────

/**
 * A Realtime Model is a named, reusable session preset: which chat model
 * answers, which STT model transcribes committed audio, which TTS model and
 * voice speak the answers, plus turn-detection settings for telephony
 * bridges. Clients connect with `?model=<key>` and get the whole bundle.
 */
export type RealtimeModelStatus = 'active' | 'disabled';

export interface IRealtimeModel {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** Stable identifier clients connect with (`?model=<key>`). */
  key: string;
  name: string;
  description?: string;
  status: RealtimeModelStatus;
  /** Chat model key responses are generated with (unless `agentKey` is set). */
  chatModelKey?: string;
  /** Agent key responses are generated with (takes precedence over `chatModelKey`). */
  agentKey?: string;
  instructions?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** STT model key for committed audio (optional — text-only otherwise). */
  sttModelKey?: string;
  /** Audio MIME type of appended input chunks (default audio/webm). */
  inputAudioFormat?: string;
  /** TTS model key; when set, responses are also synthesized to audio. */
  ttsModelKey?: string;
  voice?: string;
  ttsFormat?: string;
  // ── Turn detection (telephony bridges) ──
  /** Silence duration that ends a caller turn, in ms (default 700). */
  turnSilenceMs?: number;
  /** RMS energy threshold (0..1) below which a frame counts as silence. */
  turnSilenceThreshold?: number;
  /** Greeting spoken/sent when a telephony call connects. */
  greeting?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type RealtimeSessionTransport = 'websocket' | 'twilio';
export type RealtimeSessionLogStatus = 'active' | 'ended' | 'error';

/** One realtime connection, recorded for the observability dashboard. */
export interface IRealtimeSessionLog extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** RealtimeSession id (rt_*). */
  sessionId: string;
  realtimeModelKey?: string;
  chatModelKey?: string;
  transport: RealtimeSessionTransport;
  status: RealtimeSessionLogStatus;
  responseCount: number;
  inputAudioSeconds: number;
  usageInputTokens: number;
  usageOutputTokens: number;
  usageTotalTokens: number;
  /** Time from response.create to the first streamed delta (last response). */
  firstTokenLatencyMs?: number;
  errorMessage?: string;
  clientInfo?: Record<string, unknown>;
  startedAt: Date;
  endedAt?: Date;
  durationMs?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Atomic counters applied to a session log as the conversation progresses. */
export interface RealtimeSessionLogDelta {
  responseCount?: number;
  inputAudioSeconds?: number;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  usageTotalTokens?: number;
}
