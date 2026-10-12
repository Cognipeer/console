/**
 * Typed client of the IAM center API (`/api/iam/*`) plus the few non-IAM
 * endpoints the center needs (projects, resource registry, session).
 *
 * The shapes mirror the API contract of the IAM center. Responses go through
 * tolerant normalizers, so a missing OPTIONAL field becomes a safe default
 * instead of a crash in the UI, while the field names and meanings stay exactly
 * the contract's. Pure module: no React, no Mantine (unit-testable in node).
 *
 * Errors: every non-2xx answer is thrown as `IamApiError` carrying the HTTP
 * status, the contract's `code` and `details` (`[{ message, line?, col? }]` for
 * `validation`). `IamApiError` extends `ApiError`, so `instanceof ApiError`
 * checks keep working for either.
 */

/** The error `code` and message of a failed API call (`{ error, code }` bodies). */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

// ── primitives ───────────────────────────────────────────────────────────

export type IamEffect = 'permit' | 'forbid';
export type IamPolicyEffect = IamEffect | 'mixed';
export type IamChannel = 'dashboard' | 'api' | 'portal';
export type IamPrincipalType = 'user' | 'group' | 'token';
export type IamLevel = 'none' | 'read' | 'write' | 'admin';

export const IAM_CHANNELS: readonly IamChannel[] = ['dashboard', 'api', 'portal'];

// ── policy spec (what the visual editor produces) ────────────────────────

export type PolicySpecPrincipals =
  | { any: true }
  | {
      users?: string[];
      groups?: string[];
      tokens?: string[];
      anyUser?: boolean;
      anyToken?: boolean;
    };

export type PolicySpecResources =
  | { any: true }
  | {
      services?: string[];
      projects?: string[];
      resources?: Array<{ type: string; id: string }>;
    };

export interface PolicySpecConditions {
  validFrom?: string;
  validUntil?: string;
  ipRanges?: string[];
  channels?: IamChannel[];
}

export interface PolicySpec {
  effect: IamEffect;
  principals: PolicySpecPrincipals;
  /** Catalog action ids, including the level groups `Read` / `Write` / `Admin`. At least one. */
  actions: string[];
  resources: PolicySpecResources;
  conditions?: PolicySpecConditions;
}

// ── catalog ──────────────────────────────────────────────────────────────

export interface CatalogService {
  id: string;
  labelKey: string;
  adminService: boolean;
  /** The product's own English name (a fallback when `labelKey` does not resolve). */
  label?: string;
  /** build | data | operate | admin: how the product groups its services. */
  category?: string;
  /** A retired service: still resolvable, never offered for a new policy. */
  deprecated?: boolean;
}

export type CatalogActionKind = 'group' | 'service' | 'resource';

export interface CatalogAction {
  id: string;
  kind: CatalogActionKind;
  level: 'read' | 'write' | 'admin';
  service?: string;
  resourceType?: string;
  verb?: string;
  labelKey: string;
  labelParams: Record<string, string>;
  /**
   * The channels in which a real request is decided on this action in this build
   * (service actions: the gates, `dashboard` and `api`; `portal.use` / `agent.invoke`:
   * `portal`, where portals exist). Absent: only the Access check evaluates it.
   */
  enforcedIn?: IamChannel[];
}

export interface CatalogResourceType {
  type: string;
  service: string;
  labelKey: string;
}

export interface IamCatalog {
  services: CatalogService[];
  actions: CatalogAction[];
  resourceTypes: CatalogResourceType[];
  contextAttrs: string[];
  channels: IamChannel[];
}

// ── policies ─────────────────────────────────────────────────────────────

export interface ManagedPolicy {
  id: string;
  name: string;
  description: string;
  /** i18n keys of the same texts (`iamApi.managed.<slug>.name|description`), when the server sends them. */
  nameKey?: string;
  descriptionKey?: string;
  /** `rbac`: reproduces role-based access; `boundary`: a limit no allow can exceed; `portal`: who may open a portal and run its agents; `agent`: who may answer an agent session's pending requests. */
  group: 'rbac' | 'boundary' | 'portal' | 'agent';
  effect: IamEffect;
  cedar: string;
}

export interface PolicyRow {
  policyId: string;
  name: string;
  description: string;
  effect: IamPolicyEffect;
  /** A policy is simply enabled or disabled; a disabled one is kept but never applied. */
  enabled: boolean;
  /** `null` = the policy was written as raw Cedar. */
  spec: PolicySpec | null;
  cedar: string;
  statementCount: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  /** Name or email of the last editor (the id when they no longer exist). */
  updatedByLabel: string;
  /** Only in a list filtered by a resource: `this` names it, `all` applies to every resource of its kind. */
  scope?: 'this' | 'all';
}

export interface PoliciesResponse {
  managed: ManagedPolicy[];
  custom: PolicyRow[];
}

/** Body of POST /policies and PUT /policies/:id: exactly one of `spec` / `cedar`. */
export interface PolicyWriteBody {
  name: string;
  description?: string;
  enabled: boolean;
  spec?: PolicySpec;
  cedar?: string;
}

export interface ValidationDetail {
  message: string;
  /** Kind of issue the editor can explain in the user's language (`not_enforced_actions`...); `message` is the English fallback. */
  code?: string;
  params?: Record<string, string>;
  line?: number;
  col?: number;
  /** Which part of the spec the message is about (`principals.users`, `conditions.ipRanges`...). */
  field?: string;
  help?: string;
}

export type PolicySource = { spec: PolicySpec } | { cedar: string };

export interface CompileResponse {
  cedar: string;
  ok: boolean;
  errors: ValidationDetail[];
  warnings: ValidationDetail[];
}

export interface PreviewRequest {
  policyId?: string;
  spec?: PolicySpec;
  cedar?: string;
}

export interface PrincipalRefView {
  type: string;
  id: string;
  label: string;
}

export interface PreviewSample {
  principal: PrincipalRefView;
  action: string;
  /** Left as the server sent it (string or `{ kind, ... }`): render with `describeResource`. */
  resource: unknown;
  /** `true` = allowed, `false` = denied, `null` = unknown. */
  before: boolean | null;
  after: boolean | null;
}

export interface PreviewResponse {
  evaluated: number;
  truncated: boolean;
  /**
   * How many people / tokens the draft was checked for, out of how many it reaches
   * (`targeted` is exact when the audience is named or the whole directory was
   * listed; null = the audience is larger than what was listed).
   */
  principals: { evaluated: number; targeted: number | null };
  flips: { allowToDeny: number; denyToAllow: number };
  samples: PreviewSample[];
}

// ── simulate / decisions ─────────────────────────────────────────────────

export type SimulateResource =
  | { kind: 'service'; service: string }
  | { kind: 'resource'; type: string; id: string }
  | { kind: 'project'; projectId: string };

export interface SimulateContext {
  projectId?: string;
  channel?: IamChannel;
  /** The portal an agent is run through, or answered through (`agent.invoke` / `agent.approve` in the portal channel). */
  portalId?: string;
  /** A session action: the person who started the session (a user id). */
  ownerId?: string;
  /** A session action: which answerers the agent accepts (default `owner_or_admin`). */
  approvers?: AgentApprovers;
  /** Portal channel: the request arrived through the portal's embed with a host-verified identity (a replayed denial carries it). */
  embedded?: boolean;
  /** Portal channel: a test session of a workspace owner or admin (a replayed denial carries it). */
  test?: boolean;
  ip?: string;
  /** ISO timestamp. */
  at?: string;
}

/** The agent's "who can approve" setting (`humanInTheLoop.approvers`). */
export type AgentApprovers = 'owner' | 'owner_or_admin' | 'project_members';
export const AGENT_APPROVERS: readonly AgentApprovers[] = ['owner', 'owner_or_admin', 'project_members'];

export interface SimulateRequest {
  principal: { type: 'user' | 'token'; id: string };
  action: string;
  resource: SimulateResource;
  context?: SimulateContext;
}

export interface SimulateReason {
  cedarId: string;
  policyId: string | null;
  managed: boolean;
  name: string;
  effect: IamEffect;
}

export interface SimulateResponse {
  allowed: boolean;
  reasons: SimulateReason[];
  defaultDeny: boolean;
  principalSummary: {
    type: string;
    id: string;
    label: string;
    role: string;
    groups: Array<{ id: string; name: string }>;
    tokenScope: Record<string, string> | null;
    /** `disabled` for a disabled account. */
    status: string | null;
  };
  /** The project the check ran in; null = none applied. */
  projectId: string | null;
  /** The workspace owner always reaches the Authorization Engine: this decision came from that rule. */
  ownerSafety: boolean;
  /** False for a check about one resource: the request gates only decide whole services, so real requests are not held to it. */
  enforcedAtGate: boolean;
  /** Problems the engine met while evaluating (the decision already accounts for them). */
  errors: string[];
  /** The portal a `portal.use` / `agent.invoke` check was about: what its access list is (counts only, never the names). */
  portal: SimulatePortal | null;
  /** The session a session action was checked for: who started it (null = nobody in particular) and the answerers the agent was assumed to accept. */
  session: { ownerId: string | null; approvers: AgentApprovers } | null;
}

export interface SimulatePortal {
  id: string;
  key: string;
  name: string;
  status: 'enabled' | 'disabled';
  mode: 'all' | 'selected';
  userCount: number;
  groupCount: number;
  /** The network boundary: `any`, or `allow_list` with how many ranges (the ranges are not listed). */
  networks: { mode: 'any' | 'allow_list'; count: number };
  /** What the access list means for people who arrive through the embed. */
  embedded: 'access_list' | 'any_verified';
}

/** A custom policy that decided a request, and what became of it since. */
export interface DecisionPolicy {
  policyId: string;
  /** Its name now, else the one the denial or the policy-change trail kept; null when none is known. */
  name: string | null;
  /** `deleted`: the policy no longer exists. `disabled`: it exists but takes no part in decisions. */
  status: 'active' | 'disabled' | 'deleted';
}

export interface DecisionRecord {
  decisionId: string;
  at: string;
  principal: PrincipalRefView;
  service: string;
  required: string;
  route: string;
  method: string;
  code: string;
  /** The channel the request arrived on, when the record says (`portal` for a refusal of the portal runtime). */
  channel: string | null;
  /** What the decision was about, for a refusal about a single resource (a portal, an agent run through one). */
  resource: { type: string; id: string; label?: string } | null;
  /** The portal an agent action was asked through, named apart from the agent above (portal channel). */
  portal?: { id: string; key?: string; label?: string };
  /** Ready to feed Access check; `null` when the server could not reconstruct it. */
  simulateInput: SimulateRequest | null;
  /** Custom policies that decided it (empty = default deny or built-in rules). */
  policyIds: string[];
  /** `policyIds` with their names and whether they are still in force. */
  policies: DecisionPolicy[];
}

// ── principals ───────────────────────────────────────────────────────────

export interface PrincipalListItem {
  type: IamPrincipalType;
  id: string;
  label: string;
  sublabel: string;
  role?: string;
  status?: string;
  memberCount?: number;
  policyCount: number;
}

export interface PrincipalListParams {
  type: IamPrincipalType;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface PrincipalListResponse {
  items: PrincipalListItem[];
  nextCursor: string | null;
}

export interface EffectiveSource {
  kind: 'role' | 'direct' | 'group' | 'token-scope' | 'project' | 'policy';
  label: string;
  level: string;
}

export interface EffectiveService {
  service: string;
  level: IamLevel;
  sources: EffectiveSource[];
}

export interface PrincipalDetail {
  principal: PrincipalRefView & Record<string, unknown>;
  effective: EffectiveService[];
  groups: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string; role?: string }>;
  policies: PolicyRow[];
  tokens: Array<Record<string, unknown>> | null;
}

// ── audit ────────────────────────────────────────────────────────────────

export type AuditKind = 'denials' | 'changes';

export interface AuditParams {
  kind: AuditKind;
  from?: string;
  to?: string;
  principalType?: IamPrincipalType;
  principalId?: string;
  service?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditItem {
  id: string;
  at: string;
  kind: AuditKind;
  principal: PrincipalRefView | null;
  actor: string | null;
  service: string;
  action: string;
  route: string | null;
  method: string | null;
  code: string | null;
  decisionId: string | null;
  policyId: string | null;
  summary: string;
}

export interface AuditResponse {
  items: AuditItem[];
  nextCursor: string | null;
}

// ── settings ─────────────────────────────────────────────────────────────

export interface IamSettings {
  tokens: { maxLifetimeDays: number | null; requireExpiry: boolean };
}

// ── engine health ────────────────────────────────────────────────────────

export type EngineStatus = 'ok' | 'degraded' | 'down';
export type EngineUnavailableReason = 'engine_unavailable' | 'principal_unavailable' | 'evaluation_error';

/**
 * `GET /api/iam/engine/stats`: whether the engine is deciding, how many
 * decisions this workspace has had and what went wrong. The latency and cache
 * figures are per server process and only exist on single-organisation
 * deployments (`null` on a shared platform).
 */
export interface EngineStats {
  /** `process`: the figures describe this whole server; `tenant`: this workspace only. */
  statsScope: 'process' | 'tenant';
  generatedAt: string | null;
  health: { status: EngineStatus; message: string | null };
  /** This workspace's policy set; `null` when it could not be read. */
  policySet: { version: number; custom: number; skipped: string[] } | null;
  /** Routes the gate would refuse because they carry no authorization declaration (none in a healthy build). */
  undeclaredRoutes: { count: number; sample: Array<{ method: string; url: string }> };
  /** This workspace's counters since the server process started. */
  decisions: number;
  allows: number;
  denies: number;
  /** Requests refused with 503 because the engine could not decide. */
  unavailable: number;
  undeclaredDenies: number;
  ownerSafety: number;
  lastUnavailableAt: string | null;
  lastUnavailableReason: EngineUnavailableReason | null;
  p50Us: number | null;
  p99Us: number | null;
  /** 0..1 */
  cacheHitRate: number | null;
}

// ── projects / resources (outside /api/iam) ──────────────────────────────

export interface ProjectOption {
  id: string;
  name: string;
}

export interface ResourceOption {
  type: string;
  id: string;
  key: string | null;
  name: string;
  projectName: string | null;
}

export interface ResourceSearchParams {
  type?: string;
  q?: string;
  projectId?: string;
  limit?: number;
}

export interface ResourceSearchResponse {
  items: ResourceOption[];
  total: number;
}

export interface SessionInfo {
  userId: string;
  role: string;
  servicePermissions: Record<string, string>;
  /**
   * What the engine allows this person per service in the active project (groups,
   * policies and project limits included), `null` when the engine could not say.
   */
  effectivePermissions: Record<string, IamLevel> | null;
  /** The project those levels were computed for; null = none. */
  effectiveProjectId: string | null;
}

// ── errors ───────────────────────────────────────────────────────────────

export class IamApiError extends ApiError {
  readonly details: ValidationDetail[];

  constructor(message: string, status: number, code?: string, details: ValidationDetail[] = []) {
    super(message, status, code);
    this.name = 'IamApiError';
    this.details = details;
  }
}

/** True for an aborted request (the caller moved on; never worth showing). */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

// ── tolerant readers ─────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

export const asRecord = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const nullableStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
const strings = (v: unknown): string[] =>
  asArray(v).filter((x): x is string => typeof x === 'string');

function toEffect(v: unknown): IamEffect {
  return v === 'forbid' ? 'forbid' : 'permit';
}

function toChannel(v: unknown): IamChannel | null {
  return v === 'dashboard' || v === 'api' || v === 'portal' ? v : null;
}

/** `true` / `false` for the usual spellings of a verdict, `null` when unknown. */
export function toAllowed(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (['allow', 'allowed', 'permit', 'permitted', 'true'].includes(s)) return true;
    if (['deny', 'denied', 'forbid', 'forbidden', 'false'].includes(s)) return false;
  }
  return null;
}

function normalizeDetails(raw: unknown): ValidationDetail[] {
  return asArray(raw).map((entry): ValidationDetail => {
    if (typeof entry === 'string') return { message: entry };
    const o = asRecord(entry);
    const line = typeof o.line === 'number' ? o.line : undefined;
    const col = typeof o.col === 'number' ? o.col : undefined;
    const params = asRecord(o.params);
    const paramEntries = Object.entries(params).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;
    return {
      message: str(o.message, str(o.error)),
      ...(optStr(o.code) ? { code: optStr(o.code) } : {}),
      ...(paramEntries.length > 0 ? { params: Object.fromEntries(paramEntries) } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(col !== undefined ? { col } : {}),
      ...(optStr(o.field) ? { field: optStr(o.field) } : {}),
      ...(optStr(o.help) ? { help: optStr(o.help) } : {}),
    };
  });
}

// ── normalizers ──────────────────────────────────────────────────────────

export function normalizeSpec(raw: unknown): PolicySpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = asRecord(raw);

  const p = asRecord(o.principals);
  let principals: PolicySpecPrincipals;
  if (p.any === true) {
    principals = { any: true };
  } else {
    const users = strings(p.users);
    const groups = strings(p.groups);
    const tokens = strings(p.tokens);
    principals = {
      ...(users.length ? { users } : {}),
      ...(groups.length ? { groups } : {}),
      ...(tokens.length ? { tokens } : {}),
      ...(p.anyUser === true ? { anyUser: true } : {}),
      ...(p.anyToken === true ? { anyToken: true } : {}),
    };
  }

  const r = asRecord(o.resources);
  let resources: PolicySpecResources;
  if (r.any === true || Object.keys(r).length === 0) {
    resources = { any: true };
  } else {
    const services = strings(r.services);
    const projects = strings(r.projects);
    const list = asArray(r.resources)
      .map((x) => asRecord(x))
      .filter((x) => typeof x.type === 'string' && typeof x.id === 'string')
      .map((x) => ({ type: x.type as string, id: x.id as string }));
    resources =
      services.length || projects.length || list.length
        ? {
            ...(services.length ? { services } : {}),
            ...(projects.length ? { projects } : {}),
            ...(list.length ? { resources: list } : {}),
          }
        : { any: true };
  }

  const c = asRecord(o.conditions);
  const channels = asArray(c.channels)
    .map(toChannel)
    .filter((x): x is IamChannel => x !== null);
  const ipRanges = strings(c.ipRanges);
  const conditions: PolicySpecConditions = {
    ...(optStr(c.validFrom) ? { validFrom: optStr(c.validFrom) } : {}),
    ...(optStr(c.validUntil) ? { validUntil: optStr(c.validUntil) } : {}),
    ...(ipRanges.length ? { ipRanges } : {}),
    ...(channels.length ? { channels } : {}),
  };

  return {
    effect: toEffect(o.effect),
    principals,
    actions: strings(o.actions),
    resources,
    ...(Object.keys(conditions).length ? { conditions } : {}),
  };
}

export function normalizePolicyRow(raw: unknown): PolicyRow {
  const o = asRecord(raw);
  const effect = o.effect === 'permit' || o.effect === 'forbid' ? o.effect : 'mixed';
  return {
    policyId: str(o.policyId),
    name: str(o.name, str(o.policyId)),
    description: str(o.description),
    effect,
    // A policy is enabled or disabled. (An older server may still send `mode`; it is not read.)
    enabled: bool(o.enabled, true),
    spec: normalizeSpec(o.spec),
    cedar: str(o.cedar),
    statementCount: num(o.statementCount, 1),
    createdAt: str(o.createdAt),
    updatedAt: str(o.updatedAt),
    updatedBy: str(o.updatedBy),
    updatedByLabel: str(o.updatedByLabel, str(o.updatedBy)),
    ...(o.scope === 'this' || o.scope === 'all' ? { scope: o.scope } : {}),
  };
}

export function normalizeCatalog(raw: unknown): IamCatalog {
  const o = asRecord(raw);
  const services = asArray(o.services).map((s): CatalogService => {
    const r = asRecord(s);
    return {
      id: str(r.id),
      labelKey: str(r.labelKey),
      adminService: bool(r.adminService),
      ...(optStr(r.label) ? { label: optStr(r.label) } : {}),
      ...(optStr(r.category) ? { category: optStr(r.category) } : {}),
      ...(r.deprecated === true ? { deprecated: true } : {}),
    };
  });
  const actions = asArray(o.actions).map((a): CatalogAction => {
    const r = asRecord(a);
    const kind: CatalogActionKind = r.kind === 'group' || r.kind === 'resource' ? r.kind : 'service';
    const level = r.level === 'write' || r.level === 'admin' ? r.level : 'read';
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(asRecord(r.labelParams))) {
      if (typeof v === 'string') params[k] = v;
    }
    const enforcedIn = asArray(r.enforcedIn).map(toChannel).filter((x): x is IamChannel => x !== null);
    return {
      id: str(r.id),
      kind,
      level,
      ...(optStr(r.service) ? { service: optStr(r.service) } : {}),
      ...(optStr(r.resourceType) ? { resourceType: optStr(r.resourceType) } : {}),
      ...(optStr(r.verb) ? { verb: optStr(r.verb) } : {}),
      labelKey: str(r.labelKey),
      labelParams: params,
      ...(enforcedIn.length > 0 ? { enforcedIn } : {}),
    };
  });
  const resourceTypes = asArray(o.resourceTypes).map((t): CatalogResourceType => {
    const r = asRecord(t);
    return { type: str(r.type), service: str(r.service), labelKey: str(r.labelKey) };
  });
  const channels = asArray(o.channels)
    .map(toChannel)
    .filter((x): x is IamChannel => x !== null);
  return {
    services: services.filter((s) => s.id),
    actions: actions.filter((a) => a.id),
    resourceTypes: resourceTypes.filter((t) => t.type),
    contextAttrs: strings(o.contextAttrs),
    channels: channels.length ? channels : [...IAM_CHANNELS],
  };
}

function normalizeRef(raw: unknown): PrincipalRefView {
  const o = asRecord(raw);
  const id = str(o.id);
  return { type: str(o.type, 'user'), id, label: str(o.label, id) };
}

function normalizeReason(raw: unknown): SimulateReason {
  const o = asRecord(raw);
  const cedarId = str(o.cedarId);
  return {
    cedarId,
    policyId: nullableStr(o.policyId),
    managed: bool(o.managed, cedarId.startsWith('managed:')),
    name: str(o.name, cedarId),
    effect: toEffect(o.effect),
  };
}

export function normalizeSimulate(raw: unknown): SimulateResponse {
  const o = asRecord(raw);
  const ps = asRecord(o.principalSummary);
  const scope = asRecord(ps.tokenScope);
  const hasScope = !!ps.tokenScope && typeof ps.tokenScope === 'object' && !Array.isArray(ps.tokenScope);
  const tokenScope: Record<string, string> = {};
  for (const [k, v] of Object.entries(scope)) if (typeof v === 'string') tokenScope[k] = v;
  return {
    allowed: bool(o.allowed),
    reasons: asArray(o.reasons).map(normalizeReason),
    defaultDeny: bool(o.defaultDeny),
    principalSummary: {
      type: str(ps.type),
      id: str(ps.id),
      label: str(ps.label, str(ps.id)),
      role: str(ps.role),
      groups: asArray(ps.groups).map((g) => {
        const r = asRecord(g);
        return { id: str(r.id), name: str(r.name, str(r.id)) };
      }),
      tokenScope: hasScope ? tokenScope : null,
      status: nullableStr(ps.status),
    },
    projectId: nullableStr(o.projectId),
    ownerSafety: bool(o.ownerSafety),
    // Older servers do not say: they only ever evaluated what the gates evaluate.
    enforcedAtGate: o.enforcedAtGate === false ? false : true,
    errors: strings(o.errors),
    portal: normalizeSimulatePortal(o.portal),
    session: normalizeSimulateSession(o.session),
  };
}

function normalizeSimulateSession(raw: unknown): SimulateResponse['session'] {
  const o = asRecord(raw);
  const approvers = AGENT_APPROVERS.find((value) => value === o.approvers);
  return approvers ? { ownerId: nullableStr(o.ownerId), approvers } : null;
}

function normalizeSimulatePortal(raw: unknown): SimulatePortal | null {
  const o = asRecord(raw);
  if (!optStr(o.id)) return null;
  return {
    id: str(o.id),
    key: str(o.key),
    name: str(o.name, str(o.id)),
    status: o.status === 'disabled' ? 'disabled' : 'enabled',
    mode: o.mode === 'all' ? 'all' : 'selected',
    userCount: num(o.userCount),
    groupCount: num(o.groupCount),
    networks: {
      mode: asRecord(o.networks).mode === 'allow_list' ? 'allow_list' : 'any',
      count: num(asRecord(o.networks).count),
    },
    embedded: o.embedded === 'any_verified' ? 'any_verified' : 'access_list',
  };
}

export function normalizeSimulateInput(raw: unknown): SimulateRequest | null {
  const o = asRecord(raw);
  const p = asRecord(o.principal);
  const r = asRecord(o.resource);
  const type = p.type === 'token' ? 'token' : p.type === 'user' ? 'user' : null;
  if (!type || !optStr(p.id) || !optStr(o.action)) return null;
  let resource: SimulateResource | null = null;
  if (r.kind === 'service' && optStr(r.service)) {
    resource = { kind: 'service', service: r.service as string };
  } else if (r.kind === 'resource' && optStr(r.type) && optStr(r.id)) {
    resource = { kind: 'resource', type: r.type as string, id: r.id as string };
  } else if (r.kind === 'project' && optStr(r.projectId)) {
    resource = { kind: 'project', projectId: r.projectId as string };
  }
  if (!resource) return null;
  const c = asRecord(o.context);
  const channel = toChannel(c.channel);
  const context: SimulateContext = {
    ...(optStr(c.projectId) ? { projectId: optStr(c.projectId) } : {}),
    ...(channel ? { channel } : {}),
    ...(optStr(c.portalId) ? { portalId: optStr(c.portalId) } : {}),
    ...(optStr(c.ownerId) ? { ownerId: optStr(c.ownerId) } : {}),
    ...(AGENT_APPROVERS.find((value) => value === c.approvers) ? { approvers: AGENT_APPROVERS.find((value) => value === c.approvers) } : {}),
    ...(c.embedded === true ? { embedded: true } : {}),
    ...(c.test === true ? { test: true } : {}),
    ...(optStr(c.ip) ? { ip: optStr(c.ip) } : {}),
    ...(optStr(c.at) ? { at: optStr(c.at) } : {}),
  };
  return {
    principal: { type, id: p.id as string },
    action: o.action as string,
    resource,
    ...(Object.keys(context).length ? { context } : {}),
  };
}

export function normalizeDecision(raw: unknown): DecisionRecord {
  const o = asRecord(raw);
  const policyIds = strings(o.policyIds);
  const resource = asRecord(o.resource);
  const known = asArray(o.policies).map((entry): DecisionPolicy => {
    const p = asRecord(entry);
    return {
      policyId: str(p.policyId),
      name: nullableStr(p.name),
      status: p.status === 'disabled' || p.status === 'deleted' ? p.status : 'active',
    };
  }).filter((p) => p.policyId);
  return {
    decisionId: str(o.decisionId),
    at: str(o.at),
    principal: normalizeRef(o.principal),
    service: str(o.service),
    required: str(o.required),
    route: str(o.route),
    method: str(o.method),
    code: str(o.code),
    channel: nullableStr(o.channel),
    resource: optStr(resource.type) && optStr(resource.id)
      ? { type: str(resource.type), id: str(resource.id), ...(optStr(resource.label) ? { label: optStr(resource.label) } : {}) }
      : null,
    simulateInput: normalizeSimulateInput(o.simulateInput),
    policyIds,
    // An older server sends the ids only: they are all the UI can say, and none is known to have changed.
    policies: known.length > 0 ? known : policyIds.map((policyId): DecisionPolicy => ({ policyId, name: null, status: 'active' })),
  };
}

export function normalizePreview(raw: unknown): PreviewResponse {
  const o = asRecord(raw);
  const flips = asRecord(o.flips);
  const principals = asRecord(o.principals);
  return {
    evaluated: num(o.evaluated),
    truncated: bool(o.truncated),
    principals: {
      evaluated: num(principals.evaluated),
      targeted: typeof principals.targeted === 'number' && Number.isFinite(principals.targeted) ? principals.targeted : null,
    },
    flips: { allowToDeny: num(flips.allowToDeny), denyToAllow: num(flips.denyToAllow) },
    samples: asArray(o.samples).map((s): PreviewSample => {
      const r = asRecord(s);
      return {
        principal: normalizeRef(r.principal),
        action: str(r.action),
        resource: r.resource,
        before: toAllowed(r.before),
        after: toAllowed(r.after),
      };
    }),
  };
}

export function normalizeCompile(raw: unknown): CompileResponse {
  const o = asRecord(raw);
  const errors = normalizeDetails(o.errors);
  return {
    cedar: str(o.cedar),
    ok: typeof o.ok === 'boolean' ? o.ok : errors.length === 0,
    errors,
    warnings: normalizeDetails(o.warnings),
  };
}

export function normalizePrincipalList(raw: unknown): PrincipalListResponse {
  const o = asRecord(raw);
  return {
    items: asArray(o.items).map((entry): PrincipalListItem => {
      const r = asRecord(entry);
      const type: IamPrincipalType = r.type === 'group' || r.type === 'token' ? r.type : 'user';
      const id = str(r.id);
      return {
        type,
        id,
        label: str(r.label, id),
        sublabel: str(r.sublabel),
        ...(optStr(r.role) ? { role: optStr(r.role) } : {}),
        ...(optStr(r.status) ? { status: optStr(r.status) } : {}),
        ...(typeof r.memberCount === 'number' ? { memberCount: r.memberCount } : {}),
        policyCount: num(r.policyCount),
      };
    }),
    nextCursor: nullableStr(o.nextCursor),
  };
}

export function normalizePrincipalDetail(raw: unknown): PrincipalDetail {
  const o = asRecord(raw);
  const principal = asRecord(o.principal);
  const base = normalizeRef(principal);
  return {
    principal: { ...principal, ...base },
    effective: asArray(o.effective).map((entry): EffectiveService => {
      const r = asRecord(entry);
      return {
        service: str(r.service),
        level: toLevel(r.level),
        sources: asArray(r.sources).map((s): EffectiveSource => {
          const x = asRecord(s);
          const kind = ['role', 'direct', 'group', 'token-scope', 'project', 'policy'].includes(str(x.kind))
            ? (x.kind as EffectiveSource['kind'])
            : 'role';
          return { kind, label: str(x.label), level: str(x.level) };
        }),
      };
    }),
    groups: asArray(o.groups).map((g) => {
      const r = asRecord(g);
      return { id: str(r.id), name: str(r.name, str(r.label, str(r.id))) };
    }),
    projects: asArray(o.projects).map((p) => {
      const r = asRecord(p);
      return { id: str(r.id), name: str(r.name, str(r.id)), ...(optStr(r.role) ? { role: optStr(r.role) } : {}) };
    }),
    policies: asArray(o.policies).map(normalizePolicyRow),
    tokens: Array.isArray(o.tokens) ? o.tokens.map((t) => asRecord(t)) : null,
  };
}

export function normalizeAudit(raw: unknown): AuditResponse {
  const o = asRecord(raw);
  return {
    items: asArray(o.items).map((entry): AuditItem => {
      const r = asRecord(entry);
      const kind: AuditKind = r.kind === 'changes' ? 'changes' : 'denials';
      return {
        id: str(r.id),
        at: str(r.at),
        kind,
        principal: r.principal && typeof r.principal === 'object' ? normalizeRef(r.principal) : null,
        actor: nullableStr(r.actor),
        service: str(r.service),
        action: str(r.action),
        route: nullableStr(r.route),
        method: nullableStr(r.method),
        code: nullableStr(r.code),
        decisionId: nullableStr(r.decisionId),
        policyId: nullableStr(r.policyId),
        summary: str(r.summary),
      };
    }),
    nextCursor: nullableStr(o.nextCursor),
  };
}

export function normalizeSettings(raw: unknown): IamSettings {
  const tokens = asRecord(asRecord(raw).tokens);
  const days = tokens.maxLifetimeDays;
  return {
    tokens: {
      maxLifetimeDays: typeof days === 'number' && Number.isFinite(days) && days > 0 ? days : null,
      requireExpiry: bool(tokens.requireExpiry),
    },
  };
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toLevel(v: unknown): IamLevel {
  return v === 'read' || v === 'write' || v === 'admin' ? v : 'none';
}

/** `{ service: level }` for the services the server named; `null` when the map is absent (the engine could not answer). */
export function normalizeLevels(raw: unknown): Record<string, IamLevel> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, IamLevel> = {};
  for (const [service, level] of Object.entries(raw as Rec)) {
    if (typeof level === 'string') out[service] = toLevel(level);
  }
  return out;
}

export function normalizeEngineStats(raw: unknown): EngineStats {
  const o = asRecord(raw);
  const scope = o.statsScope === 'tenant' ? 'tenant' : 'process';
  const health = asRecord(o.health);
  const status: EngineStatus = health.status === 'degraded' || health.status === 'down' ? health.status : 'ok';
  const policySet = asRecord(o.policySet);
  const hasPolicySet = o.policySet !== null && typeof o.policySet === 'object' && !Array.isArray(o.policySet);
  const undeclared = asRecord(o.undeclaredRoutes);
  // In process scope `enforce` counts the whole server; this workspace's own figures are `tenantEnforce`.
  const own = asRecord(o.tenantEnforce && typeof o.tenantEnforce === 'object' ? o.tenantEnforce : o.enforce);
  const engine = asRecord(o.engine);
  const reason = own.lastUnavailableReason;
  return {
    statsScope: scope,
    generatedAt: nullableStr(o.generatedAt),
    health: { status, message: nullableStr(health.message) },
    policySet: hasPolicySet
      ? { version: num(policySet.version), custom: num(policySet.custom), skipped: strings(policySet.skipped) }
      : null,
    undeclaredRoutes: {
      count: num(undeclared.count),
      sample: asArray(undeclared.sample).map((entry) => {
        const r = asRecord(entry);
        return { method: str(r.method), url: str(r.url) };
      }),
    },
    decisions: num(own.engineDecisions),
    allows: num(own.engineAllows),
    denies: num(own.engineDenies),
    unavailable: num(own.unavailable),
    undeclaredDenies: num(own.undeclaredDenies),
    ownerSafety: num(own.ownerSafety),
    lastUnavailableAt: nullableStr(own.lastUnavailableAt),
    lastUnavailableReason:
      reason === 'engine_unavailable' || reason === 'principal_unavailable' || reason === 'evaluation_error' ? reason : null,
    p50Us: scope === 'process' ? numOrNull(engine.p50Us) : null,
    p99Us: scope === 'process' ? numOrNull(engine.p99Us) : null,
    cacheHitRate: scope === 'process' ? numOrNull(asRecord(engine.principalCache).hitRate) : null,
  };
}

// ── transport ────────────────────────────────────────────────────────────

type Query = Record<string, string | number | boolean | null | undefined>;

export function buildQuery(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function errorFrom(res: Response): Promise<IamApiError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  let details: ValidationDetail[] = [];
  try {
    const body = asRecord(await res.json());
    if (typeof body.error === 'string' && body.error) message = body.error;
    else if (typeof body.message === 'string' && body.message) message = body.message;
    if (typeof body.code === 'string') code = body.code;
    details = normalizeDetails(body.details);
  } catch {
    /* not JSON */
  }
  return new IamApiError(message, res.status, code, details);
}

interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

async function request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(`${path}${buildQuery(opts.query)}`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: opts.signal,
    ...(hasBody
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) }
      : {}),
  });
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new IamApiError('Invalid JSON in response', res.status, 'invalid_response');
  }
}

const seg = encodeURIComponent;

// ── IAM endpoints ────────────────────────────────────────────────────────

export const iamApi = {
  async getCatalog(signal?: AbortSignal): Promise<IamCatalog> {
    return normalizeCatalog(await request('GET', '/api/iam/catalog', { signal }));
  },

  async listPolicies(signal?: AbortSignal): Promise<PoliciesResponse> {
    const o = asRecord(await request('GET', '/api/iam/policies', { signal }));
    return {
      managed: asArray(o.managed).map((m): ManagedPolicy => {
        const r = asRecord(m);
        const id = str(r.id);
        return {
          id,
          name: str(r.name, id),
          description: str(r.description),
          ...(optStr(r.nameKey) ? { nameKey: optStr(r.nameKey) } : {}),
          ...(optStr(r.descriptionKey) ? { descriptionKey: optStr(r.descriptionKey) } : {}),
          group:
            r.group === 'portal' || id.includes(':portal:')
              ? 'portal'
              : r.group === 'agent' || id.includes(':agent:')
                ? 'agent'
                : r.group === 'boundary' || (r.group !== 'rbac' && !id.includes(':rbac:'))
                  ? 'boundary'
                  : 'rbac',
          effect: toEffect(r.effect),
          cedar: str(r.cedar),
        };
      }),
      custom: asArray(o.custom).map(normalizePolicyRow),
    };
  },

  async getPolicy(policyId: string, signal?: AbortSignal): Promise<PolicyRow> {
    return normalizePolicyRow(await request('GET', `/api/iam/policies/${seg(policyId)}`, { signal }));
  },

  async createPolicy(body: PolicyWriteBody): Promise<PolicyRow> {
    return normalizePolicyRow(await request('POST', '/api/iam/policies', { body }));
  },

  async updatePolicy(policyId: string, body: Partial<PolicyWriteBody>): Promise<PolicyRow> {
    return normalizePolicyRow(await request('PUT', `/api/iam/policies/${seg(policyId)}`, { body }));
  },

  async deletePolicy(policyId: string): Promise<void> {
    await request('DELETE', `/api/iam/policies/${seg(policyId)}`);
  },

  async compilePolicy(source: PolicySource, signal?: AbortSignal): Promise<CompileResponse> {
    return normalizeCompile(await request('POST', '/api/iam/policies/compile', { body: source, signal }));
  },

  async previewPolicy(input: PreviewRequest, signal?: AbortSignal): Promise<PreviewResponse> {
    return normalizePreview(await request('POST', '/api/iam/policies/preview', { body: input, signal }));
  },

  async simulate(input: SimulateRequest, signal?: AbortSignal): Promise<SimulateResponse> {
    return normalizeSimulate(await request('POST', '/api/iam/simulate', { body: input, signal }));
  },

  async getDecision(decisionId: string, signal?: AbortSignal): Promise<DecisionRecord> {
    return normalizeDecision(await request('GET', `/api/iam/decisions/${seg(decisionId)}`, { signal }));
  },

  async listPrincipals(params: PrincipalListParams, signal?: AbortSignal): Promise<PrincipalListResponse> {
    return normalizePrincipalList(
      await request('GET', '/api/iam/principals', {
        query: { type: params.type, q: params.q, limit: params.limit, cursor: params.cursor },
        signal,
      }),
    );
  },

  async getPrincipal(
    type: IamPrincipalType,
    id: string,
    projectId?: string,
    signal?: AbortSignal,
  ): Promise<PrincipalDetail> {
    return normalizePrincipalDetail(
      await request('GET', `/api/iam/principals/${seg(type)}/${seg(id)}`, {
        query: { projectId },
        signal,
      }),
    );
  },

  async listAudit(params: AuditParams, signal?: AbortSignal): Promise<AuditResponse> {
    return normalizeAudit(await request('GET', '/api/iam/audit', { query: auditQuery(params), signal }));
  },

  /** Same-origin URL of the CSV export for the same filters (use as a link `href`). */
  auditExportUrl(params: Omit<AuditParams, 'limit' | 'cursor'>): string {
    return `/api/iam/audit/export${buildQuery(auditQuery(params))}`;
  },

  async getSettings(signal?: AbortSignal): Promise<IamSettings> {
    return normalizeSettings(await request('GET', '/api/iam/settings', { signal }));
  },

  async updateSettings(settings: IamSettings): Promise<IamSettings> {
    return normalizeSettings(await request('PUT', '/api/iam/settings', { body: settings }));
  },

  /** Engine health and counters (`GET /api/iam/engine/stats`). */
  async getEngineStats(signal?: AbortSignal): Promise<EngineStats> {
    return normalizeEngineStats(await request('GET', '/api/iam/engine/stats', { signal }));
  },
};

function auditQuery(params: Partial<AuditParams>): Query {
  return {
    kind: params.kind,
    from: params.from,
    to: params.to,
    principalType: params.principalType,
    principalId: params.principalId,
    service: params.service,
    limit: params.limit,
    cursor: params.cursor,
  };
}

// ── non-IAM endpoints the center reads ───────────────────────────────────

export const iamLookupApi = {
  /** Projects the caller can see (`GET /api/projects`). */
  async listProjects(signal?: AbortSignal): Promise<ProjectOption[]> {
    const o = asRecord(await request('GET', '/api/projects', { signal }));
    return asArray(o.projects)
      .map((p) => {
        const r = asRecord(p);
        const id = str(r._id, str(r.id));
        return { id, name: str(r.name, id) };
      })
      .filter((p) => p.id);
  },

  /** Resource registry search (`GET /api/resources`; needs the `resources` service). */
  async searchResources(params: ResourceSearchParams, signal?: AbortSignal): Promise<ResourceSearchResponse> {
    const o = asRecord(
      await request('GET', '/api/resources', {
        query: { type: params.type, q: params.q, projectId: params.projectId, limit: params.limit ?? 20 },
        signal,
      }),
    );
    return {
      items: asArray(o.items).map((entry): ResourceOption => {
        const r = asRecord(entry);
        const id = str(r.id);
        return {
          type: str(r.type),
          id,
          key: nullableStr(r.key),
          name: str(r.name, str(r.key, id)),
          projectName: nullableStr(r.projectName),
        };
      }),
      total: num(o.total),
    };
  },

  /** The signed-in user's session (`GET /api/auth/session`). */
  async getSession(signal?: AbortSignal): Promise<SessionInfo> {
    const o = asRecord(await request('GET', '/api/auth/session', { signal }));
    const perms: Record<string, string> = {};
    for (const [k, v] of Object.entries(asRecord(o.servicePermissions))) {
      if (typeof v === 'string') perms[k] = v;
    }
    return {
      userId: str(o.userId),
      role: str(o.role),
      servicePermissions: perms,
      effectivePermissions: normalizeLevels(o.effectivePermissions),
      effectiveProjectId: nullableStr(o.effectiveProjectId),
    };
  },
};

// ── error presentation ───────────────────────────────────────────────────

/** A one-line, human readable message for any thrown value. */
export function errorMessage(error: unknown, fallback = ''): string {
  if (error instanceof IamApiError) {
    if (error.details.length > 0 && error.code === 'validation') {
      return error.details.map((d) => d.message).filter(Boolean).join('; ') || error.message;
    }
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
