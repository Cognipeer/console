/**
 * Agent manifests — the portable, reviewable form of an agent.
 *
 * A manifest is the agent's config with every tenant-local id stripped and
 * every dependency reduced to a *key*. That is deliberate: keys are what a
 * customer's second environment also has, ids are not. Importing therefore
 * becomes a reconciliation ("does this tenant have `jira-mcp`?") rather than a
 * restore, and the dry run below is what turns a missing dependency into a
 * reviewable list instead of a runtime failure three turns into a chat.
 *
 * Secrets never enter a manifest. `connection.apiKeyEnc` is encrypted with the
 * source tenant's key and would be undecryptable anywhere else anyway — but the
 * more important reason is that a manifest is meant to be pasted into a PR.
 */

import YAML from 'yaml';

import { getDatabase, runWithTenantScope } from '@/lib/database';
import type { DatabaseProvider, IAgent, IAgentConfig, IAgentToolBinding } from '@/lib/database';
import {
    addsConfigTargets,
    configRefTargets,
    loadProjectConfigIndex,
    normalizeConfigGroupRefs,
    normalizeConfigValueRefs,
    rawConfigRefTargets,
} from '@/lib/services/config/configRefs';
import { subagentConfigIssues } from './subagentConfigRules';
import { createLogger } from '@/lib/core/logger';
import { maskAgentSandboxConfig, sealAgentConfigSecrets } from './agentSandboxSecrets';
import { maskAgentCallbackConfig, stripLegacyExecutionConfig } from './agentCallbackConfig';
import { validateVariableDeclaration } from './agentVariables';
import { assertMayNameBucket, type CanNameBucket } from './attachmentsBucketAccess';
import type { ManifestResources } from './manifestResources';


const logger = createLogger('agent-manifest');

export const AGENT_MANIFEST_API_VERSION = 'cognipeer.console/v1' as const;

export type AgentManifestFormat = 'json' | 'yaml';

export interface AgentManifestDependency {
    /** What the key points at, so the importer can send the user to the right page. */
    type: 'model' | 'prompt' | 'tool' | 'mcp' | 'knowledge' | 'guardrail' | 'agent' | 'skill';
    key: string;
    /** Where in the spec it is referenced — shown next to a missing dependency. */
    usedBy: string;
}

export interface AgentManifest {
    apiVersion: typeof AGENT_MANIFEST_API_VERSION;
    kind: 'Agent';
    metadata: {
        key: string;
        name: string;
        description?: string;
        status?: string;
        /** Version the manifest was taken from; null when exported from the draft. */
        version?: number | null;
        exportedAt: string;
    };
    spec: IAgentConfig;
    /** Flat list of every key the spec references. Informational — derived, not authoritative. */
    dependencies: AgentManifestDependency[];
    /**
     * Opt-in embedded definitions (see `manifestResources.ts`) so an importer
     * can create what its project is missing. Absent = references only.
     */
    resources?: ManifestResources;
}

// ── Build ────────────────────────────────────────────────────────────────

/** Strips secret material from a config destined for export. */
function sanitizeConfig(config: IAgentConfig): IAgentConfig {
    const spec: IAgentConfig = JSON.parse(JSON.stringify(config ?? {}));
    if (spec.connection) {
        // Encrypted with the source tenant's key — useless elsewhere, and a
        // manifest is a document people paste into pull requests.
        delete spec.connection.apiKeyEnc;
    }
    if (spec.sandbox) {
        // Same reasoning for sandbox secrets: the keys travel (so an importer
        // sees which secrets to fill in), the sealed values never do.
        spec.sandbox = maskAgentSandboxConfig(spec.sandbox);
        // A persistent sandbox is one project's machine: its id means nothing
        // elsewhere, and an import over this agent keeps the one it has.
        if (spec.sandbox) delete spec.sandbox.instanceId;
    }
    if (spec.callback) {
        // The callback URL travels; its sealed secret never does (masked, so an
        // importer sees one is expected and an import over this agent keeps its own).
        spec.callback = maskAgentCallbackConfig(spec.callback);
    }
    return stripLegacyExecutionConfig(spec);
}

function collectBindingDependencies(
    bindings: IAgentToolBinding[] | undefined,
    usedBy: string,
    out: AgentManifestDependency[],
): void {
    for (const binding of bindings ?? []) {
        if (binding.source === 'tool') out.push({ type: 'tool', key: binding.sourceKey, usedBy });
        else if (binding.source === 'mcp') out.push({ type: 'mcp', key: binding.sourceKey, usedBy });
        // 'system' bindings (browser_use and friends) are built into the binary —
        // there is nothing for an importing tenant to be missing.
    }
}

export function collectManifestDependencies(spec: IAgentConfig): AgentManifestDependency[] {
    const out: AgentManifestDependency[] = [];
    if (spec.modelKey) out.push({ type: 'model', key: spec.modelKey, usedBy: 'spec.modelKey' });
    for (const [index, extra] of (spec.additionalModels ?? []).entries()) {
        if (extra?.modelKey) out.push({ type: 'model', key: extra.modelKey, usedBy: `spec.additionalModels[${index}]` });
    }
    // The model that reads uploaded files with OCR: a project model like the main one, so a missing one is reported.
    const ocrModelKey = typeof spec.attachments?.ocr?.modelKey === 'string' ? spec.attachments.ocr.modelKey.trim() : '';
    if (ocrModelKey) out.push({ type: 'model', key: ocrModelKey, usedBy: 'spec.attachments.ocr.modelKey' });
    if (spec.promptKey) out.push({ type: 'prompt', key: spec.promptKey, usedBy: 'spec.promptKey' });
    for (const skill of spec.skills ?? []) out.push({ type: 'skill', key: skill, usedBy: 'spec.skills' });
    if (spec.knowledgeEngineKey) {
        out.push({ type: 'knowledge', key: spec.knowledgeEngineKey, usedBy: 'spec.knowledgeEngineKey' });
    }
    for (const [index, binding] of (spec.knowledgeBindings ?? []).entries()) {
        if (binding?.key) out.push({ type: 'knowledge', key: binding.key, usedBy: `spec.knowledgeBindings[${index}]` });
    }
    for (const guardrail of spec.guardrails ?? []) {
        if (guardrail.key) out.push({ type: 'guardrail', key: guardrail.key, usedBy: 'spec.guardrails' });
    }
    if (spec.inputGuardrailKey) {
        out.push({ type: 'guardrail', key: spec.inputGuardrailKey, usedBy: 'spec.inputGuardrailKey' });
    }
    if (spec.outputGuardrailKey) {
        out.push({ type: 'guardrail', key: spec.outputGuardrailKey, usedBy: 'spec.outputGuardrailKey' });
    }
    collectBindingDependencies(spec.toolBindings, 'spec.toolBindings', out);

    for (const subagent of spec.subagents ?? []) {
        const where = `spec.subagents[${subagent.name}]`;
        if (subagent.kind === 'ref' && subagent.agentKey) {
            out.push({ type: 'agent', key: subagent.agentKey, usedBy: where });
            // A reference may override the model its agent runs on: the importing project needs that model too.
            if (subagent.modelKey) out.push({ type: 'model', key: subagent.modelKey, usedBy: where });
            continue;
        }
        if (subagent.modelKey) out.push({ type: 'model', key: subagent.modelKey, usedBy: where });
        if (subagent.knowledgeEngineKey) {
            out.push({ type: 'knowledge', key: subagent.knowledgeEngineKey, usedBy: where });
        }
        collectBindingDependencies(subagent.toolBindings, where, out);
    }

    // Dedupe on type+key; `usedBy` keeps the first reference, which is enough to
    // point a reader at where to look.
    const seen = new Set<string>();
    return out.filter((dep) => {
        const id = `${dep.type}:${dep.key}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

export function buildAgentManifest(
    agent: Pick<IAgent, 'key' | 'name' | 'description' | 'status'>,
    config: IAgentConfig,
    version: number | null = null,
    resources?: ManifestResources,
): AgentManifest {
    const spec = sanitizeConfig(config);
    const hasResources = Boolean(resources && Object.values(resources).some((list) => list && list.length > 0));
    return {
        apiVersion: AGENT_MANIFEST_API_VERSION,
        kind: 'Agent',
        metadata: {
            key: agent.key,
            name: agent.name,
            ...(agent.description ? { description: agent.description } : {}),
            ...(agent.status ? { status: agent.status } : {}),
            version,
            exportedAt: new Date().toISOString(),
        },
        spec,
        dependencies: collectManifestDependencies(spec),
        ...(hasResources ? { resources } : {}),
    };
}

export function serializeAgentManifest(manifest: AgentManifest, format: AgentManifestFormat): string {
    return format === 'yaml'
        ? YAML.stringify(manifest, { lineWidth: 0 })
        : `${JSON.stringify(manifest, null, 2)}\n`;
}

// ── Parse & validate ─────────────────────────────────────────────────────

export class AgentManifestError extends Error {
    readonly issues: string[];
    /** Set when the failure has its own HTTP meaning: `agent_key_conflict` (409), `agent_not_found` (404). */
    readonly code?: 'agent_key_conflict' | 'agent_not_found';
    constructor(message: string, issues: string[] = [], code?: 'agent_key_conflict' | 'agent_not_found') {
        super(message);
        this.name = 'AgentManifestError';
        this.issues = issues;
        this.code = code;
    }
}

/** The HTTP status an import route answers for a manifest error: 409 key clash, 404 update of a missing key, else 400. */
export function manifestErrorStatus(error: AgentManifestError): 400 | 404 | 409 {
    if (error.code === 'agent_key_conflict') return 409;
    if (error.code === 'agent_not_found') return 404;
    return 400;
}

/**
 * Parses a manifest from text. The format is detected rather than declared:
 * YAML is a superset of JSON, so one parser would do — but a JSON syntax error
 * reported as a YAML error is confusing, and people paste both.
 */
export function parseAgentManifest(text: string, format?: AgentManifestFormat): AgentManifest {
    const trimmed = text.trim();
    if (!trimmed) throw new AgentManifestError('Manifest is empty');

    const detected: AgentManifestFormat = format ?? (trimmed.startsWith('{') ? 'json' : 'yaml');
    let parsed: unknown;
    try {
        parsed = detected === 'json' ? JSON.parse(trimmed) : YAML.parse(trimmed);
    } catch (error) {
        throw new AgentManifestError(
            `Manifest is not valid ${detected.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const issues = validateAgentManifest(parsed);
    if (issues.length > 0) throw new AgentManifestError('Manifest failed validation', issues);
    return parsed as AgentManifest;
}

export function validateAgentManifest(input: unknown): string[] {
    const issues: string[] = [];
    if (!input || typeof input !== 'object') return ['Manifest must be an object'];
    const manifest = input as Partial<AgentManifest>;

    if (manifest.apiVersion !== AGENT_MANIFEST_API_VERSION) {
        issues.push(`apiVersion must be "${AGENT_MANIFEST_API_VERSION}" (got ${String(manifest.apiVersion)})`);
    }
    if (manifest.kind !== 'Agent') {
        issues.push(`kind must be "Agent" (got ${String(manifest.kind)})`);
    }
    if (!manifest.metadata?.key || typeof manifest.metadata.key !== 'string') {
        issues.push('metadata.key is required');
    } else if (!/^[a-z0-9][a-z0-9-_]{0,63}$/i.test(manifest.metadata.key)) {
        issues.push('metadata.key must be alphanumeric with dashes/underscores, max 64 chars');
    }
    if (!manifest.metadata?.name || typeof manifest.metadata.name !== 'string') {
        issues.push('metadata.name is required');
    }
    if (!manifest.spec || typeof manifest.spec !== 'object') {
        issues.push('spec is required');
        return issues;
    }

    const spec = manifest.spec as IAgentConfig;
    const kind = spec.kind ?? 'native';
    if (kind === 'native' && !spec.modelKey) {
        issues.push('spec.modelKey is required for native agents');
    }
    if (kind === 'external' && !spec.connection?.url) {
        issues.push('spec.connection.url is required for connected agents');
    }
    // A flow is referenced by id/key of this tenant's Flows service and is not part of the manifest, so
    // a FlowBase agent or a flow tool would arrive pointing at nothing. Move flows with Flow export/import.
    if (kind === 'flow') {
        issues.push('spec.kind "flow" (FlowBase agents) cannot be imported: export the flow and its agent separately');
    }
    (spec.toolBindings ?? []).forEach((binding, index) => {
        if (binding?.source === 'flow') issues.push(`spec.toolBindings[${index}]: flow tools cannot be imported (flows are not part of an agent manifest)`);
    });

    const names = new Set<string>();
    for (const subagent of spec.subagents ?? []) {
        if (!subagent.name) issues.push('every spec.subagents entry needs a name');
        else if (names.has(subagent.name)) issues.push(`duplicate sub-agent name "${subagent.name}"`);
        else names.add(subagent.name);
        if (subagent.kind === 'ref' && !subagent.agentKey) {
            issues.push(`sub-agent "${subagent.name}" is a reference but has no agentKey`);
        }
        if (subagent.kind !== 'ref' && subagent.kind !== 'inline') {
            issues.push(`sub-agent "${subagent.name}" has an unknown kind "${String(subagent.kind)}"`);
        }
    }

    for (const issue of subagentConfigIssues(spec)) issues.push(`spec.${issue.field} ${issue.message}`);

    if (spec.structuredOutput?.enabled && !spec.structuredOutput.schema) {
        issues.push('spec.structuredOutput.enabled is true but no schema is set');
    }

    // The declared variables travel with the agent: a malformed list is refused on import like on save.
    for (const issue of validateVariableDeclaration(spec.variables)) issues.push(`spec.${issue.field}: ${issue.message}`);

    return issues;
}

// ── Dependency reconciliation ────────────────────────────────────────────

export interface ManifestDependencyStatus extends AgentManifestDependency {
    present: boolean;
}

export interface AgentImportPreview {
    manifest: AgentManifest;
    /** True when an agent with this key already exists in the target project. */
    exists: boolean;
    dependencies: ManifestDependencyStatus[];
    missing: ManifestDependencyStatus[];
}

async function dependencyExists(
    db: Awaited<ReturnType<typeof getDatabase>>,
    projectId: string,
    dep: AgentManifestDependency,
): Promise<boolean> {
    try {
        switch (dep.type) {
            case 'model':
                return Boolean(await db.findModelByKey(dep.key, projectId));
            case 'prompt':
                return Boolean(await db.findPromptByKey(dep.key, projectId));
            case 'tool':
                return Boolean(await db.findToolByKey(dep.key, projectId));
            case 'mcp':
                return Boolean(await db.findMcpServerByKey(dep.key, projectId));
            case 'knowledge':
                return Boolean(await db.findRagModuleByKey(dep.key, projectId));
            case 'guardrail':
                return Boolean(await db.findGuardrailByKey(dep.key, projectId));
            case 'agent':
                return Boolean(await db.findAgentByKey(dep.key, projectId));
            case 'skill':
                return Boolean(await db.findSkillByKey(dep.key, projectId));
            default:
                return false;
        }
    } catch (error) {
        // A lookup that throws is reported as missing, not as a failed import —
        // the preview's whole job is to say what will not work.
        logger.warn('Dependency lookup failed', {
            type: dep.type,
            key: dep.key,
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}

/**
 * Dry run. Never writes. Returns the manifest alongside what the target project
 * is missing, so the UI can refuse (or warn) before anything is created.
 */
export async function previewAgentImport(
    tenantDbName: string,
    projectId: string,
    manifest: AgentManifest,
): Promise<AgentImportPreview> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const declared = collectManifestDependencies(manifest.spec);
    const dependencies: ManifestDependencyStatus[] = [];
    for (const dep of declared) {
        dependencies.push({ ...dep, present: await dependencyExists(db, projectId, dep) });
    }

    const existing = await db.findAgentByKey(manifest.metadata.key, projectId);

    return {
        manifest,
        exists: Boolean(existing),
        dependencies,
        missing: dependencies.filter((dep) => !dep.present),
    };
}

// ── Apply ────────────────────────────────────────────────────────────────

async function assertMayReferenceConfig(
    next: IAgentConfig,
    previous: IAgentConfig | undefined,
    canReferenceConfig: (() => Promise<boolean>) | undefined,
): Promise<void> {
    const field = addedConfigRefField(next, previous);
    if (field && !(canReferenceConfig && await canReferenceConfig())) throw new ConfigReferenceForbiddenError(field);
}

/**
 * The same question as `assertMayReferenceConfig`, asked of the manifest's RAW references (ids or keys, before
 * any lookup in the target project): a caller without Config read is refused before the project's Config is
 * touched, so the re-binding warnings cannot tell it what the project holds.
 */
async function assertMayReferenceConfigRaw(
    spec: IAgentConfig,
    previous: IAgentConfig | undefined,
    canReferenceConfig: (() => Promise<boolean>) | undefined,
): Promise<void> {
    for (const field of ['envRefs', 'secretRefs', 'groupRefs'] as const) {
        const isGroups = field === 'groupRefs';
        const raw = rawConfigRefTargets(isGroups ? { groupRefs: [spec.sandbox?.[field]] } : { refs: [spec.sandbox?.[field]] });
        if (raw.size === 0) continue;
        const stored = previous?.sandbox?.[field] as never;
        if (!addsConfigTargets(raw, configRefTargets(isGroups ? { groupRefs: [stored] } : { refs: [stored] }))) continue;
        if (canReferenceConfig && await canReferenceConfig()) return;
        throw new ConfigReferenceForbiddenError(`config.sandbox.${field}`);
    }
}

export type AgentImportMode = 'create' | 'update' | 'upsert';

export interface AgentImportResult {
    agent: IAgent;
    action: 'created' | 'updated';
    /** Dependencies the target project does not have. The agent is still written. */
    missing: ManifestDependencyStatus[];
    /** Config references of the manifest the target project cannot resolve (they were dropped). */
    warnings: Array<{ code: string; message: string }>;
}

/** Thrown when an import points the sandbox at config the caller may not read (the routes answer 403). */
export class ConfigReferenceForbiddenError extends Error {
    readonly field: string;

    constructor(field: string) {
        super('Taking a value from Config needs read access to Config in this project.');
        this.name = 'ConfigReferenceForbiddenError';
        this.field = field;
    }
}

/**
 * Re-binds the sandbox's Config references to the target project: a reference keeps its item (or group) when
 * that id is in the project, else it is looked up by key. What cannot be resolved (no such key, the key is in
 * two groups, a secret under `envRefs`) is dropped and reported; an import never fails over a reference.
 * `storedSecretNames`: the typed secrets the target agent keeps (a manifest carries none, so they stay).
 */
/**
 * A manifest never carries a persistent sandbox (see `sanitizeConfig`): an import over an agent keeps the one it
 * has, so re-importing an export does not take its sandbox away. An agent left set to a persistent sandbox it does
 * not have is reported, not refused; it runs without its sandbox tools until one is picked.
 */
function keepStoredSandboxInstance(
    config: IAgentConfig,
    previous: IAgentConfig | undefined,
    warnings: Array<{ code: string; message: string }>,
): IAgentConfig {
    if (!config.sandbox) return config;
    const stored = previous?.sandbox?.instanceId;
    const sandbox = { ...config.sandbox };
    if (stored) sandbox.instanceId = stored;
    else delete sandbox.instanceId;
    if (sandbox.enabled && sandbox.mode === 'instance' && !sandbox.instanceId) {
        warnings.push({
            code: 'sandbox_instance_unset',
            message: 'sandbox.mode is "instance", but a persistent sandbox is chosen in each project: pick one in the agent\'s Sandbox settings.',
        });
    }
    return { ...config, sandbox };
}

async function rebindSandboxConfigRefs(
    db: DatabaseProvider,
    projectId: string,
    config: IAgentConfig,
    storedSecretNames: string[] = [],
): Promise<{ config: IAgentConfig; warnings: Array<{ code: string; message: string }> }> {
    const sandbox = config.sandbox;
    if (!sandbox || (sandbox.envRefs === undefined && sandbox.secretRefs === undefined && sandbox.groupRefs === undefined)) {
        return { config, warnings: [] };
    }
    const index = await loadProjectConfigIndex(db, projectId);
    const warnings: Array<{ code: string; message: string }> = [];
    const next = { ...sandbox };
    const itemIds = new Set(index.items.map((item) => String(item._id)));
    const groupIds = new Set(index.groups.map((group) => String(group._id)));
    const malformed = (field: string) => warnings.push({
        code: 'config_reference_dropped',
        message: `sandbox.${field} was left out: it is not in the expected shape.`,
    });

    for (const [field, allowSecret] of [['envRefs', false], ['secretRefs', true]] as const) {
        const stored = sandbox[field];
        if (stored === undefined) continue;
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            if (stored !== null) malformed(field);
            delete next[field];
            continue;
        }
        // A name that is also a typed value is set in one place only (the write path refuses it); the typed value stays.
        const typedNames = new Set(Object.keys((field === 'envRefs' ? sandbox.env : sandbox.secrets) ?? {}));
        if (field === 'secretRefs' && sandbox.secrets === undefined) storedSecretNames.forEach((name) => typedNames.add(name));
        const kept: NonNullable<typeof stored> = {};
        for (const [name, ref] of Object.entries(stored)) {
            if (typedNames.has(name)) {
                warnings.push({
                    code: 'config_reference_dropped',
                    message: `${name} (config item "${ref?.key ?? '?'}") was left out: ${name} is also set in ${field === 'envRefs' ? 'env' : 'secrets'}.`,
                });
                continue;
            }
            const lookup = ref?.configId && itemIds.has(ref.configId) ? { configId: ref.configId } : { configKey: ref?.key };
            const { refs, issues } = await normalizeConfigValueRefs(db, index, { [name]: lookup }, `sandbox.${field}`, { allowSecret });
            if (refs?.[name]) {
                kept[name] = refs[name];
            } else {
                warnings.push({
                    code: 'config_reference_dropped',
                    message: `${name} (config item "${ref?.key ?? '?'}") was left out: ${issues[0]?.message ?? 'it cannot be resolved in this project'}.`,
                });
            }
        }
        if (Object.keys(kept).length > 0) next[field] = kept;
        else delete next[field];
    }
    if (sandbox.groupRefs !== undefined && !Array.isArray(sandbox.groupRefs)) {
        if (sandbox.groupRefs !== null) malformed('groupRefs');
        delete next.groupRefs;
    } else if (Array.isArray(sandbox.groupRefs)) {
        const kept: NonNullable<typeof sandbox.groupRefs> = [];
        for (const ref of sandbox.groupRefs) {
            const lookup = ref?.groupId && groupIds.has(ref.groupId) ? { groupId: ref.groupId } : { groupKey: ref?.key };
            const { refs, issues } = await normalizeConfigGroupRefs(db, index, [lookup], 'sandbox.groupRefs');
            if (refs?.[0]) {
                kept.push(refs[0]);
            } else {
                warnings.push({
                    code: 'config_reference_dropped',
                    message: `Config group "${ref?.key ?? '?'}" was left out: ${issues[0]?.message ?? 'it cannot be resolved in this project'}.`,
                });
            }
        }
        if (kept.length > 0) next.groupRefs = kept;
        else delete next.groupRefs;
    }
    return { config: { ...config, sandbox: next }, warnings };
}

/** The field of the first sandbox reference `next` adds over `previous` (it needs Config read access), else null. */
function addedConfigRefField(next: IAgentConfig, previous: IAgentConfig | undefined): string | null {
    for (const field of ['envRefs', 'secretRefs'] as const) {
        const pick = (config: IAgentConfig | undefined) => configRefTargets({ refs: [config?.sandbox?.[field]] });
        if (addsConfigTargets(pick(next), pick(previous))) return `config.sandbox.${field}`;
    }
    const groups = (config: IAgentConfig | undefined) => configRefTargets({ groupRefs: [config?.sandbox?.groupRefs] });
    return addsConfigTargets(groups(next), groups(previous)) ? 'config.sandbox.groupRefs' : null;
}

/**
 * Writes a manifest into the target project.
 *
 * The imported agent always lands as a **draft** config on the existing record
 * (or a new one): importing must never change what `/v1/responses` is serving.
 * Publishing stays a separate, deliberate action — the same rule the playground
 * follows.
 *
 * Missing dependencies do not block the write by default. They are returned, and
 * `allowMissingDependencies: false` turns them into a refusal for callers (CI,
 * the import dialog's strict mode) that would rather fail early.
 */
export async function applyAgentManifest(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    manifest: AgentManifest,
    options: {
        mode?: AgentImportMode;
        /** Override the manifest's own key — used when importing a copy alongside the original. */
        key?: string;
        name?: string;
        allowMissingDependencies?: boolean;
        /**
         * May the caller name this bucket (by key) in an agent's settings? A Files decision about THAT bucket,
         * asked before anything is written whenever the manifest sets or changes `attachments.bucketKey` - the
         * same question the create and update routes ask. Required, so a new caller cannot leave it out; a
         * refusal throws `BucketNamingForbiddenError`.
         */
        canNameBucket: CanNameBucket;
        /**
         * May the caller read Config in the target project? Asked only when the (re-bound) manifest points the
         * sandbox at a config item or group the agent it overwrites did not; a refusal throws
         * `ConfigReferenceForbiddenError`. A caller that passes none cannot add references (it fails closed).
         */
        canReferenceConfig?: () => Promise<boolean>;
    },
): Promise<AgentImportResult> {
    const issues = validateAgentManifest(manifest);
    if (issues.length > 0) throw new AgentManifestError('Manifest failed validation', issues);

    const preview = await previewAgentImport(tenantDbName, projectId, manifest);
    if (preview.missing.length > 0 && options.allowMissingDependencies === false) {
        throw new AgentManifestError(
            'Manifest references dependencies this project does not have',
            preview.missing.map((dep) => `${dep.type} "${dep.key}" (${dep.usedBy})`),
        );
    }

    // One tenant binding for every read and write below (and the config lookups of the re-binding): a
    // process-global switchToTenant can be overwritten by another tenant's request between the awaits.
    return runWithTenantScope(tenantDbName, (db) => importManifest(db, tenantId, projectId, userId, manifest, options, preview));
}

async function importManifest(
    db: DatabaseProvider,
    tenantId: string,
    projectId: string,
    userId: string,
    manifest: AgentManifest,
    options: Parameters<typeof applyAgentManifest>[5],
    preview: Awaited<ReturnType<typeof previewAgentImport>>,
): Promise<AgentImportResult> {
    const key = options.key?.trim() || manifest.metadata.key;
    const name = options.name?.trim() || manifest.metadata.name;
    const mode = options.mode ?? 'upsert';
    const existing = await db.findAgentByKey(key, projectId);

    if (existing) {
        if (mode === 'create') throw new AgentManifestError(`Agent key "${key}" already exists`, [], 'agent_key_conflict');
        const spec = sanitizeConfig(manifest.spec);
        await assertMayReferenceConfigRaw(spec, existing.config, options.canReferenceConfig);
        const storedSecretNames = Object.keys(maskAgentSandboxConfig(existing.config?.sandbox)?.secrets ?? {});
        const rebound = await rebindSandboxConfigRefs(db, projectId, spec, storedSecretNames);
        const incoming = keepStoredSandboxInstance(rebound.config, existing.config, rebound.warnings);
        await assertMayNameBucket(incoming, existing.config, options.canNameBucket);
        await assertMayReferenceConfig(incoming, existing.config, options.canReferenceConfig);
        const updated = await db.updateAgent(String(existing._id), {
            name,
            description: manifest.metadata.description,
            // Masked secret values keep what this agent already stores.
            config: sealAgentConfigSecrets(incoming, existing.config),
            updatedBy: userId,
        });
        if (!updated) throw new AgentManifestError(`Agent "${key}" could not be updated`);
        logger.info('Agent imported over existing record', { key, projectId, missing: preview.missing.length });
        return { agent: updated, action: 'updated', missing: preview.missing, warnings: rebound.warnings };
    }

    if (mode === 'update') throw new AgentManifestError(`Agent "${key}" does not exist`, [], 'agent_not_found');

    const spec = sanitizeConfig(manifest.spec);
    await assertMayReferenceConfigRaw(spec, undefined, options.canReferenceConfig);
    const rebound = await rebindSandboxConfigRefs(db, projectId, spec);
    const incoming = keepStoredSandboxInstance(rebound.config, undefined, rebound.warnings);
    await assertMayNameBucket(incoming, undefined, options.canNameBucket);
    await assertMayReferenceConfig(incoming, undefined, options.canReferenceConfig);
    const created = await db.createAgent({
        tenantId,
        projectId,
        key,
        name,
        description: manifest.metadata.description,
        config: sealAgentConfigSecrets(incoming, undefined),
        // Imported agents start inactive: an import is a proposal until someone
        // opens it, checks the dependency list and publishes.
        status: 'draft',
        createdBy: userId,
    });
    logger.info('Agent imported as new record', { key, projectId, missing: preview.missing.length });
    return { agent: created, action: 'created', missing: preview.missing, warnings: rebound.warnings };
}
