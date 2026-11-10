'use client';

import { Fragment, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Paper,
  Text,
  Group,
  Stack,
  Button,
  Textarea,
  Select,
  ActionIcon,
  Tabs,
  Divider,
  Badge,
  Code,
  Tooltip,
  Modal,
  Table,
  VisuallyHidden,
  Switch,
  SegmentedControl,
  Alert,
  Menu,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconMessageCircle,
  IconCode,
  IconThumbUp,
  IconSettings,
  IconDatabase,
  IconShield,
  IconShieldLock,
  IconTool,
  IconRocket,
  IconGitBranch,
  IconArrowsExchange,
  IconPlugConnected,
  IconPencil,
  IconAlertTriangle,
  IconLayoutDashboard,
  IconPlus,
  IconArrowsLeftRight,
  IconRoute,
  IconTopologyStar3,
  IconX,
  IconUpload,
  IconDots,
  IconFileExport,
} from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { fetchResourceUsage, useConfirm, type ResourceUsageResponse } from '@/components/common/confirm';
import EmptyState from '@/components/common/EmptyState';
import GuardrailBindingList, {
  bindingRowsFromLegacySlots,
  bindingRowsFromStored,
  type GuardrailBindingOption,
  type GuardrailBindingRow,
} from '@/components/guardrails/GuardrailBindingList';
import LoadingState from '@/components/common/LoadingState';
import DataGrid from '@/components/common/ui/DataGrid';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import SectionCard from '@/components/common/SectionCard';
import { KnowledgeBindingsEditor } from './KnowledgeBindingsEditor';
import AgentUsagePanel from './AgentUsagePanel';
import { a2aSendCurl, sampleVariables, variablesOfRunVersion } from './agentUsageSnippets';
import CopyableCode from './CopyableCode';
import type { ToolBinding } from './toolSources';
import ConnectAgentModal from './ConnectAgentModal';
import {
  AgentFlowsPanel,
  FlowAgentCard,
  useFlowDetailTexts,
  useFlowsAccess,
} from '@/components/enterprise/EnterpriseFlowAgentUi';
import { withoutOwnedAgents } from '@/lib/utils/ownedAgents';
import AgentAdvancedSettings from './studio/AgentAdvancedSettings';
import AgentRemindersSettings from './studio/AgentRemindersSettings';
import AgentRemindersTable from './studio/AgentRemindersTable';
import { showRemindersView, type AgentRemindersResponse } from './studio/reminderUi';
import AgentStructuredOutputEditor from './studio/AgentStructuredOutputEditor';
import AgentSubagentsPanel from './studio/AgentSubagentsPanel';
import AgentExportPanel from './studio/AgentExportPanel';
import ImportAgentShell from './ImportAgentShell';
import AgentPromptPanel, { type PromptOption } from './studio/AgentPromptPanel';
import AgentOverviewPanel from './studio/AgentOverviewPanel';
import AgentOverviewAside, { splitAgentUsedBy } from './studio/AgentOverviewAside';
import SessionList, { type SessionListItem } from './studio/SessionList';
import StartSessionModal from './studio/StartSessionModal';
import SessionDetailDrawer from './studio/SessionDetailDrawer';
import { isSessionOngoing } from '@/lib/services/agents/sessionActivityState';
import { SESSION_QUERY_PARAM } from './session/sessionLinks';
import AgentRunSettingsPanel from './studio/AgentRunSettingsPanel';
import AgentVariablesEditor from './studio/AgentVariablesEditor';
import AgentFilesPanel from './studio/AgentFilesPanel';
import { filesEnabled, filesSaveErrors, MAX_FOLDER_LENGTH, type AttachmentsSettings } from './studio/filesSettings';
import { SESSION_FILES_DEFAULTS } from '@/lib/services/agents/sessionFilesConfig';
import AgentClientToolsPanel from './studio/AgentClientToolsPanel';
import { normalizeClientTools } from './studio/clientToolsSettings';
import AgentHumanInTheLoopPanel from './studio/AgentHumanInTheLoopPanel';
import { boundToolKinds, type KindSourceRecord } from './studio/hitlSettings';
import ClientToolsSurfaces from './studio/ClientToolsSurfaces';
import AgentFeedbackPanel from './studio/AgentFeedbackPanel';
import {
  BUILD_SECTION_GROUPS,
  BUILD_SECTION_ORDER,
  changedConfigSections,
  configSectionTitle,
  unsetConfigSections,
} from './studio/configSections';
import BuildSectionIndex, { type BuildIndexGroup } from './studio/BuildSectionIndex';
import CompareVersionsDrawer from './studio/CompareVersionsDrawer';
import AgentTriggersPanel from './studio/AgentTriggersPanel';
import AgentSkillsPanel from './studio/AgentSkillsPanel';
import AgentToolsList from './studio/AgentToolsList';
import AgentMemoryPanel, { type MemoryStoreOption } from './studio/AgentMemoryPanel';
import AgentSandboxPanel from './studio/AgentSandboxPanel';
import { resolveSandboxMode, type ResolvedSandboxMode } from '@/lib/services/agents/agentSandboxMode';
import EnterpriseAgentShipSections from './EnterpriseAgentShipSections';
import ConfigSection, { ConfigBlock } from './studio/ConfigSection';
import PiiProtectionField from '@/components/pii/PiiProtectionField';
import { piiPolicyKeyOf, piiProtectionPayload } from '@/components/pii/piiProtectionForm';
import AgentAdditionalModels from './studio/AgentAdditionalModels';
import AgentReasoningPicker, { type ReasoningPickerValue } from './studio/AgentReasoningPicker';
import { subagentPolicyToStore } from './studio/subagentSettings';
import { migrateAgentReasoning } from '@/lib/services/agents/agentReasoning';
import type { SkillView } from '@/components/skills/types';
import type {
  IAgentConfig,
  IAgentMemoryConfig,
  IAgentSandboxConfig,
  IAgentCallbackConfig,
  IAgentClientToolSurfaces,
  IAgentHumanInTheLoopConfig,
  IAgentRemindersConfig,
  IAgentAdditionalModel,
  IAgentClientToolConfig,
  IAgentRuntimeConfig,
  IAgentKnowledgeBinding,
  IAgentSkillPolicy,
  IAgentStructuredOutput,
  IAgentSubagent,
  IAgentSubagentPolicy,
  IExternalAgentConnection,
} from '@/lib/database/provider/types.domain';
import classes from './AgentDetailPage.module.css';

interface A2aMetadata {
  enabled?: boolean;
  accessMode?: 'token' | 'public';
  /** Server-generated unguessable slug for the public endpoint. */
  endpointSlug?: string;
}

interface Agent {
  _id: string;
  tenantId: string;
  key: string;
  projectId?: string;
  name: string;
  description?: string;
  // The API never returns the encrypted key — only whether one is stored.
  config: Omit<IAgentConfig, 'connection'> & {
    connection?: Partial<Omit<IExternalAgentConnection, 'apiKeyEnc'>> & { hasApiKey?: boolean };
  };
  status: string;
  publishedVersion?: number | null;
  latestVersion?: number;
  metadata?: { a2a?: A2aMetadata } & Record<string, unknown>;
}

interface AgentVersion {
  _id: string;
  agentId: string;
  agentKey: string;
  version: number;
  snapshot: {
    name: string;
    description?: string;
    config: Agent['config'];
    status: string;
  };
  changelog?: string;
  publishedBy: string;
  createdAt: string;
}

interface Model {
  _id: string;
  key: string;
  name: string;
  modelId: string;
  category: string;
  providerKey?: string;
  providerDriver?: string;
  capabilities?: { supportsReasoning?: boolean } | null;
  settings?: Record<string, unknown>;
  /** The model's own PII protection: the agent's choice replaces it, and it applies when the agent has none. */
  piiProtection?: { policyKey?: string } | null;
}

interface RagModule {
  _id: string;
  key: string;
  name: string;
  status: string;
}

/** Loads one list endpoint into state; a failed load is logged and leaves the list as it was. */
async function loadList<T>(
  url: string,
  pick: (data: Record<string, unknown>) => unknown,
  set: (rows: T[]) => void,
  what: string,
) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) set((pick(await res.json()) ?? []) as T[]);
  } catch (err) {
    console.error(`Failed to load ${what}`, err);
  }
}

/** The Sandbox section's header badge. */
const SANDBOX_MODE_BADGES: Record<ResolvedSandboxMode, string> = {
  session: 'session',
  ephemeral: 'per message',
  instance: 'persistent',
};

/**
 * Deep-link compatibility for `?tab=`.
 *
 * The page used to have thirteen flat tabs; they are now five, and Configure
 * and Deploy are single pages whose `sub` is a section to scroll to rather
 * than a pane to show. Every old value still resolves —
 * a bookmark or the Sessions page's own back link must not land on a tab that
 * no longer exists.
 */
const TAB_ALIASES: Record<string, { top: string; sub?: string }> = {
  overview: { top: 'overview' },
  sessions: { top: 'sessions' },
  playground: { top: 'sessions' },
  configure: { top: 'configure' },
  build: { top: 'configure' },
  ship: { top: 'deploy' },
  // Operate was folded into Sessions (same list, its filters moved there).
  operate: { top: 'sessions' },
  settings: { top: 'configure', sub: 'basic' },
  basic: { top: 'configure', sub: 'basic' },
  prompt: { top: 'configure', sub: 'prompt' },
  subagents: { top: 'configure', sub: 'subagents' },
  skills: { top: 'configure', sub: 'skills' },
  memory: { top: 'configure', sub: 'memory' },
  sandbox: { top: 'configure', sub: 'sandbox' },
  callback: { top: 'configure', sub: 'callback' },
  // Old links to the removed Execution section land on what is left of it.
  execution: { top: 'configure', sub: 'callback' },
  budget: { top: 'configure', sub: 'callback' },
  files: { top: 'configure', sub: 'files' },
  attachments: { top: 'configure', sub: 'files' },
  hitl: { top: 'configure', sub: 'hitl' },
  approvals: { top: 'configure', sub: 'hitl' },
  clienttools: { top: 'configure', sub: 'clienttools' },
  'client-tools': { top: 'configure', sub: 'clienttools' },
  feedback: { top: 'feedback' },
  // Flows of the agent: the entry flow of a FlowBase agent, or the flows a Smart Agent calls as tools.
  flows: { top: 'flows' },
  advanced: { top: 'configure', sub: 'advanced' },
  output: { top: 'configure', sub: 'output' },
  // Parts of General, each with its own anchor (the Overview's "Needs attention" links here).
  knowledge: { top: 'configure', sub: 'knowledge' },
  guardrails: { top: 'configure', sub: 'guardrails' },
  pii: { top: 'configure', sub: 'pii' },
  tools: { top: 'configure', sub: 'tools' },
  variables: { top: 'configure', sub: 'variables' },
  deploy: { top: 'deploy' },
  versions: { top: 'deploy', sub: 'versions' },
  publish: { top: 'deploy', sub: 'publish' },
  triggers: { top: 'deploy', sub: 'triggers' },
  channels: { top: 'deploy', sub: 'channels' },
  // The section triggers replaced; old links land on it.
  schedules: { top: 'deploy', sub: 'triggers' },
  export: { top: 'deploy', sub: 'export' },
  observe: { top: 'sessions' },
  traces: { top: 'sessions' },
  usage: { top: 'usage' },
  api: { top: 'usage' },
};

/** Build sections that make no sense for a flow-owned agent: it is never called by URL, callback or a chat client. */
const OWNED_HIDDEN_SECTIONS: ReadonlySet<string> = new Set(['callback', 'clienttools']);

/** Versions per page in Ship's version history. */
const VERSIONS_PAGE_SIZE = 5;

function resolveTabFromQuery(raw: string | null): string {
  return TAB_ALIASES[raw ?? '']?.top ?? 'overview';
}

/** The sub-tab a deep link asks for, or the group's default. */
function resolveSubTabFromQuery(raw: string | null, group: string, fallback: string): string {
  const alias = TAB_ALIASES[raw ?? ''];
  return alias?.top === group && alias.sub ? alias.sub : fallback;
}

export interface AgentDetailPageProps {
  /** The agent to edit. Without it the id comes from the route (`/dashboard/agents/[agentId]`). */
  agentId?: string;
  /**
   * The agent is owned by a flow (a hidden, ad-hoc agent) and the editor is embedded in the flow editor:
   * only Sessions and Build remain; publishing, versions, deploy, usage and the deep-link/URL handling are off,
   * and sessions open in a new tab so the flow editor stays where it is.
   */
  ownedByFlow?: boolean;
  /** Traces link for the Sessions list; defaults to the tracing page filtered by the agent name. */
  tracesHref?: string;
  /** Viewing only: the save bar is not rendered (the host also disables the controls). */
  readOnly?: boolean;
}

export default function AgentDetailPage({ agentId: agentIdProp, ownedByFlow = false, tracesHref, readOnly = false }: AgentDetailPageProps = {}) {
  const params = useParams()!;
  const router = useRouter();
  const searchParams = useSearchParams()!;
  const agentId = agentIdProp ?? (params.agentId as string);
  const t = useTranslations('agents');
  const tPii = useTranslations('piiProtection');
  const locale = useLocale();
  const tIdentity = useTranslations('consoleIdentity');
  const flowTexts = useFlowDetailTexts();
  const flowsPermission = useFlowsAccess();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [additionalModels, setAdditionalModels] = useState<IAgentAdditionalModel[]>([]);
  // The main model's own reasoning pick, side by side with the model ("Model default" = unset).
  const [mainReasoning, setMainReasoning] = useState<ReasoningPickerValue>({});
  const [showReasoning, setShowReasoning] = useState(true);
  const [prompts, setPrompts] = useState<PromptOption[]>([]);
  const [ragModules, setRagModules] = useState<RagModule[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailBindingOption[]>([]);
  const [providers, setProviders] = useState<Array<{ key: string; label?: string; name?: string; driver?: string }>>([]);
  const driverByProviderKey = useMemo(
    () => Object.fromEntries(providers.map((p) => [p.key, p.driver])) as Record<string, string | undefined>,
    [providers],
  );
  const [editConnectionOpen, setEditConnectionOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // Overview is the landing tab — it's the one screen that answers "is this
  // agent healthy and what has it been doing", which is a better first thing
  // to see than a blank chat box. A deep link (Sessions' "back to agent",
  // a bookmark) can still land on any tab via `?tab=`.
  const [activeTab, setActiveTab] = useState<string | null>(() => (ownedByFlow ? 'configure' : resolveTabFromQuery(searchParams.get('tab'))));
  // Configure has no rail any more, so this is no longer "which pane is
  // showing" — it is "which section a deep link asked for", and the effect
  // below scrolls to it.
  const [configureTab, setConfigureTab] = useState<string | null>(
    () => (ownedByFlow ? 'basic' : resolveSubTabFromQuery(searchParams.get('tab'), 'configure', 'basic')),
  );
  const [deployTab, setDeployTab] = useState<string | null>(
    () => resolveSubTabFromQuery(searchParams.get('tab'), 'deploy', 'versions'),
  );

  const [toolBindings, setToolBindings] = useState<ToolBinding[]>([]);

  // Advanced runtime knobs, structured output and the delegation roster. These
  // live outside `configForm` for the same reason the guardrail bindings do:
  // they are nested objects and lists, and `getInputProps` has nothing to offer
  // them. Absent stays absent — an untouched agent must serialize the same
  // config it had before these sections existed.
  const [runtimeConfig, setRuntimeConfig] = useState<IAgentRuntimeConfig>({});
  // Per-call output limit (`config.maxTokens` -> `max_tokens` on every model call). Blank = the model's own default.
  const [maxTokens, setMaxTokens] = useState<number | undefined>(undefined);
  const [structuredOutput, setStructuredOutput] = useState<IAgentStructuredOutput | undefined>(undefined);
  const [variablesConfig, setVariablesConfig] = useState<IAgentConfig['variables']>(undefined);
  const [subagents, setSubagents] = useState<IAgentSubagent[]>([]);
  const [subagentPolicy, setSubagentPolicy] = useState<IAgentSubagentPolicy | undefined>(undefined);
  /** Other agents in the project — the `ref` sub-agent picker's options. */
  const [projectAgents, setProjectAgents] = useState<Array<{ key: string; name: string; publishedVersion?: number | null }>>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillPolicy, setSkillPolicy] = useState<IAgentSkillPolicy | undefined>(undefined);
  const [skillLibrary, setSkillLibrary] = useState<SkillView[]>([]);
  const [memoryConfig, setMemoryConfig] = useState<IAgentMemoryConfig | undefined>(undefined);
  const [sandboxConfig, setSandboxConfig] = useState<IAgentSandboxConfig | undefined>(undefined);
  const [callbackConfig, setCallbackConfig] = useState<IAgentCallbackConfig | undefined>(undefined);
  const [budgetConfig, setBudgetConfig] = useState<IAgentConfig['budget']>(undefined);
  const [hitlConfig, setHitlConfig] = useState<IAgentHumanInTheLoopConfig | undefined>(undefined);
  // The records behind the bound tools: the approvals table reads what each tool does (reads / writes…) from them.
  const [toolRecords, setToolRecords] = useState<{ tools: KindSourceRecord[]; mcp: KindSourceRecord[] }>({ tools: [], mcp: [] });
  // Bumped when one of the agent's own MCP servers was created, changed or deleted: the tool records are read again.
  const [ownedMcpVersion, setOwnedMcpVersion] = useState(0);
  const [remindersConfig, setRemindersConfig] = useState<IAgentRemindersConfig | undefined>(undefined);
  const [clientToolsConfig, setClientToolsConfig] = useState<IAgentClientToolConfig[] | undefined>(undefined);
  const [clientToolSurfaces, setClientToolSurfaces] = useState<IAgentClientToolSurfaces | undefined>(undefined);
  const [attachmentsConfig, setAttachmentsConfig] = useState<AttachmentsSettings | undefined>(undefined);
  // A save was refused because Files is on without a bucket: the field shows its error from then on.
  const [filesSaveRefused, setFilesSaveRefused] = useState(false);
  // Build page: the published snapshot, to flag changed sections.
  const [publishedConfig, setPublishedConfig] = useState<Record<string, unknown> | null>(null);
  // What `publishedConfig` has answered for, as `<agent id>@<version>` (it holds that snapshot, or the request failed):
  // the Usage tab and the Overview quick start wait for it, because a call runs the snapshot, not the draft.
  const [publishedConfigKey, setPublishedConfigKey] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);
  // Build: what Save would send for the config as last loaded or saved, to tell which sections have unsaved edits.
  // `hydration` counts loads, so the baseline is taken once the loaded config has rendered.
  const [savedPayload, setSavedPayload] = useState<Record<string, unknown> | null>(null);
  const [hydration, setHydration] = useState(0);
  // Sections the agent does not use that were opened with "Set up" (or a link to them): they stay open.
  const [expandedUnset, setExpandedUnset] = useState<ReadonlySet<string>>(() => new Set());
  // Overview and Ship: what uses the agent and what it uses (one request, shared), and how many triggers start it.
  const [agentUsage, setAgentUsage] = useState<ResourceUsageResponse | null>(null);
  const [agentUsageFailed, setAgentUsageFailed] = useState(false);
  const [triggerCount, setTriggerCount] = useState<number | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [updateFromFileOpen, setUpdateFromFileOpen] = useState(false);
  const [memoryStores, setMemoryStores] = useState<MemoryStoreOption[]>([]);

  // Guardrail bindings live outside `configForm`: they are a list of objects,
  // not a scalar field, and the form's `getInputProps` contract has nothing to
  // offer them.
  //
  // THE MIGRATION CEREMONY IS GONE. An agent still on `inputGuardrailKey` /
  // `outputGuardrailKey` used to get a read-only list plus a "Migrate to list"
  // step, so that converting was an explicit act rather than a side effect of
  // an unrelated save. That guarded against a conversion LOSING something —
  // and it does not: `resolveBindings` projects the legacy output slot onto
  // `output.pre` AND `output.stream.delta` (binding.ts:48-55) while the seed
  // writes only `output.pre`, but a pre-hook-plane guardrail is lifted with
  // `stream: { enabled: false }` and no policy on the stream hook
  // (legacy.ts:537), so the stream projection resolves to a key with nothing
  // to run. The conversion is lossless, and the ceremony was friction with no
  // protective value — it is also exactly the "why am I picking two?" the
  // owner hit. The API still derives the deprecated columns from the list, so
  // an older console binary on the same tenant DB keeps enforcing.
  const [guardrailBindings, setGuardrailBindings] = useState<GuardrailBindingRow[]>([]);
  // Reversible PII protection: the key of a PII policy of the project, or null (off). Outside `configForm` like
  // the knobs above, so an agent that never had it serializes exactly the config it had.
  const [piiPolicyKey, setPiiPolicyKey] = useState<string | null>(null);

  // Publish & version state
  const [a2aSaving, setA2aSaving] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishChangelog, setPublishChangelog] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [versionsTotal, setVersionsTotal] = useState(0);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [compareVersionA, setCompareVersionA] = useState<string | null>(null);
  const [compareVersionB, setCompareVersionB] = useState<string | null>(null);
  // Ship lists the versions five at a time (newest first); the two picked for Compare stay picked across pages.
  const [versionsPage, setVersionsPage] = useState(1);
  const [compareModalOpen, setCompareModalOpen] = useState(false);

  // Sessions list (for the Sessions tab — the actual chat now lives at its
  // own route, see AgentSessionView).
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsOwnOnly, setSessionsOwnOnly] = useState(false);
  const [startSessionOpen, setStartSessionOpen] = useState(false);
  const [viewedSessionId, setViewedSessionId] = useState<string | null>(null);
  const [sessionsView, setSessionsView] = useState<'sessions' | 'reminders'>('sessions');
  /** Sessions narrowed to the ones one trigger started (its "Runs" link). */
  const [sessionsTrigger, setSessionsTrigger] = useState<{ id: string; name: string } | null>(null);
  /** The agent has (had) reminders — shows the Reminders view even when the setting is off now. */
  const [hasReminders, setHasReminders] = useState(false);
  const [activeReminderCount, setActiveReminderCount] = useState(0);
  const [savingConfig, setSavingConfig] = useState(false);
  /**
   * What the server's config check said on the last save: errors blocked it,
   * warnings did not. Shown next to the Save button, where the operator is
   * looking — a toast alone listed one problem and disappeared.
   */
  const [configIssues, setConfigIssues] = useState<{
    errors: Array<{ field: string; message: string }>;
    warnings: Array<{ field: string; message: string }>;
  } | null>(null);
  // Config form
  const configForm = useForm({
    initialValues: {
      modelKey: '',
      promptMode: 'custom' as 'custom' | 'prompt',
      systemPrompt: '',
      promptKey: '',
      knowledgeBindings: [] as IAgentKnowledgeBinding[],
      knowledgeToolMode: 'combined' as 'combined' | 'separate',
    },
  });

  // ── Data Loading ──────────────────────────────────────────────

  const loadAgent = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setAgent(data.agent);

        // Populate form from agent config
        const cfg = data.agent.config;
        configForm.setValues({
          modelKey: cfg.modelKey || '',
          promptMode: cfg.promptKey ? 'prompt' : 'custom',
          systemPrompt: cfg.systemPrompt || '',
          promptKey: cfg.promptKey || '',
          knowledgeBindings: cfg.knowledgeBindings?.length
            ? cfg.knowledgeBindings
            : cfg.knowledgeEngineKey ? [{ key: cfg.knowledgeEngineKey }] : [],
          knowledgeToolMode: cfg.knowledgeToolMode === 'separate' ? 'separate' : 'combined',
        });
        setToolBindings(cfg.toolBindings ?? []);
        // Old Advanced-tab reasoning is folded into the model's own fields (the server does it on read too).
        const migrated = migrateAgentReasoning(cfg);
        setAdditionalModels(migrated.additionalModels ?? []);
        setMainReasoning({
          ...(migrated.reasoningEffort ? { reasoningEffort: migrated.reasoningEffort } : {}),
          ...(migrated.reasoningBudgetTokens ? { reasoningBudgetTokens: migrated.reasoningBudgetTokens } : {}),
        });
        setShowReasoning(migrated.showReasoning !== false);
        setRuntimeConfig(migrated.runtime ?? {});
        setMaxTokens(typeof cfg.maxTokens === 'number' && cfg.maxTokens > 0 ? cfg.maxTokens : undefined);
        setStructuredOutput(cfg.structuredOutput);
        setVariablesConfig(cfg.variables);
        setSubagents(cfg.subagents ?? []);
        setSubagentPolicy(cfg.subagentPolicy);
        setSkills(cfg.skills ?? []);
        setSkillPolicy(cfg.skillPolicy);
        setMemoryConfig(cfg.memory);
        setSandboxConfig(cfg.sandbox);
        setCallbackConfig(cfg.callback);
        setBudgetConfig(cfg.budget);
        setHitlConfig(cfg.humanInTheLoop);
        setRemindersConfig(cfg.reminders);
        setClientToolsConfig(cfg.clientTools);
        setClientToolSurfaces(cfg.clientToolSurfaces);
        setAttachmentsConfig(cfg.attachments);
        setPiiPolicyKey(piiPolicyKeyOf(cfg.piiProtection));
        setFilesSaveRefused(false);

        // An array — even an empty one — means the operator has already moved
        // to the list, and "bound to nothing" is a real decision, so it must not
        // fall back to the legacy slots.
        //
        // Shared mapping: an absent `hooks` means "wherever the guardrail
        // declares it runs" and must stay absent, or the binding is silently
        // parked the next time this config is saved for any reason, while the
        // row still renders as attached.
        setGuardrailBindings(Array.isArray(cfg.guardrails)
          ? bindingRowsFromStored(cfg.guardrails)
          : bindingRowsFromLegacySlots(cfg.inputGuardrailKey, cfg.outputGuardrailKey));
        setHydration((count) => count + 1);
      }
    } catch (err) {
      console.error('Failed to load agent', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const loadVersions = useCallback(async () => {
    if (!agent) return;
    setVersionsLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/versions?limit=100`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        setVersions(data.versions ?? []);
        setVersionsTotal(data.total ?? 0);
        // A reload follows a publish: the new version is on the first page.
        setVersionsPage(1);
      }
    } catch (err) {
      console.error('Failed to load versions', err);
    } finally {
      setVersionsLoading(false);
    }
  }, [agent, agentId]);

  const loadSessions = useCallback(async (silent = false) => {
    if (!silent) setSessionsLoading(true);
    try {
      const triggerQuery = sessionsTrigger ? `?triggerId=${encodeURIComponent(sessionsTrigger.id)}` : '';
      const res = await fetch(`/api/agents/${agentId}/sessions${triggerQuery}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions ?? []);
        // The caller may not view other people's sessions of this agent: the list holds only their own.
        setSessionsOwnOnly(data.scope?.viewOthers === false);
      }
    } catch (err) {
      console.error('Failed to load sessions', err);
    } finally {
      setSessionsLoading(false);
    }
  }, [agentId, sessionsTrigger]);

  // Whether the agent has any reminder at all (the Reminders view is hidden for one that never used them).
  const loadReminderSummary = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/reminders?status=all&limit=1`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as AgentRemindersResponse;
      setHasReminders((data.reminders ?? []).length > 0);
      setActiveReminderCount(data.summary?.active ?? 0);
    } catch {
      // Without the answer the view just stays hidden unless the setting is on.
    }
  }, [agentId]);

  /**
   * Sessions are created from StartSessionModal, which collects the name and
   * the session context before the first message — that context is stored on
   * the session and applied to every turn, so it has to exist by turn one.
   *
   * The chat itself lives at its own route now (AgentSessionView), not on this
   * page, and the config save-before-chat the old inline playground did is
   * gone: a Session always runs a real config (the draft, or a version pinned
   * on the session page), so there is nothing here that needs saving first.
   */
  /** Opens the session page. Embedded in the flow editor it opens in a new tab: leaving would drop the editor. */
  const openSessionPage = (sessionId: string, query = '') => {
    const href = `/dashboard/agents/${agentId}/sessions/${sessionId}${query}`;
    if (ownedByFlow) window.open(href, '_blank', 'noopener');
    else router.push(href);
  };
  const handleSessionStarted = (sessionId: string, pinnedVersion: string) => {
    openSessionPage(sessionId, pinnedVersion ? `?version=${encodeURIComponent(pinnedVersion)}` : '');
  };

  const handlePublish = async () => {
    setPublishing(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changelog: publishChangelog || undefined }),
      });

      if (res.ok) {
        const data = await res.json();
        notifications.show({
          title: t('publish.success'),
          message: t('publish.successDesc', { version: data.version.version }),
          color: 'teal',
        });
        setPublishModalOpen(false);
        setPublishChangelog('');
        // Reload agent to update publishedVersion, and refresh versions list
        await loadAgent();
        if (activeTab === 'deploy') {
          await loadVersions();
        }
      } else {
        const err = await res.json();
        throw new Error(err.error || 'Publish failed');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      notifications.show({
        title: t('publish.failed'),
        message: errMsg,
        color: 'red',
      });
    } finally {
      setPublishing(false);
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([
        loadAgent(),
        loadList('/api/models?category=llm', (d) => d.models, setModels, 'models'),
        loadList('/api/prompts', (d) => d.prompts, setPrompts, 'prompts'),
        loadList('/api/rag/modules?status=active', (d) => d.modules, setRagModules, 'RAG modules'),
        // Unfiltered on purpose: a guardrail disabled AFTER it was bound must
        // still render as a (badged) row in the binding list, which keeps
        // disabled ones out of its picker instead.
        loadList('/api/guardrails', (d) => d.guardrails, setGuardrails, 'guardrails'),
        // Project scope, not tenant scope: the tenant list is provider-admin only, and an
        // empty map would hide the reasoning dropdown next to every model.
        loadList('/api/providers', (d) => d.providers, setProviders, 'providers'),
        // Native agents only: a connected agent is an HTTP endpoint, and the
        // runtime refuses to flatten one into a sub-agent, so offering it here
        // would only produce a binding that silently drops at run time.
        loadList(
          '/api/agents',
          (d) => withoutOwnedAgents((d.agents ?? []) as Agent[])
            .filter((entry) => entry.config?.kind !== 'external' && entry.config?.kind !== 'flow')
            .map((entry) => ({ key: entry.key, name: entry.name, publishedVersion: entry.publishedVersion ?? null })),
          setProjectAgents,
          'project agents',
        ),
        // The project's skill library and this agent's own skills.
        loadList(`/api/skills?agentId=${encodeURIComponent(agentId)}`, (d) => d.skills, setSkillLibrary, 'skill library'),
        loadList('/api/memory/stores', (d) => d.stores, setMemoryStores, 'memory stores'),
      ]);
      setLoading(false);
    })();
  }, [loadAgent]);

  useEffect(() => {
    // Export needs the version list too: it offers "export v3" as a source, and
    // a version the operator cannot pick is a version they will assume is gone.
    // Versions and Export both offer "which snapshot?" pickers, and they now
    // live behind the same tab — one load covers both.
    if (activeTab === 'deploy' && agent) {
      loadVersions();
    }
  }, [activeTab, agent, loadVersions]);

  useEffect(() => {
    if ((activeTab === 'sessions' || activeTab === 'overview') && agent) {
      void loadSessions();
    }
  }, [activeTab, agent, loadSessions]);

  // A session whose turn runs (a background run, or one answering a caller right now) changes without anyone touching the page.
  const hasOngoingSession = sessions.some(isSessionOngoing);
  useEffect(() => {
    if (activeTab !== 'sessions' || !hasOngoingSession) return;
    const timer = setInterval(() => { void loadSessions(true); }, 5_000);
    return () => clearInterval(timer);
  }, [activeTab, hasOngoingSession, loadSessions]);

  // `?session=` opens that session's inspector (the Sessions lists link here), on arrival and whenever the link changes.
  // The value ends up in API paths, so anything but a plain id is ignored.
  const rawLinkedSession = searchParams.get(SESSION_QUERY_PARAM);
  const linkedSessionId = !ownedByFlow && rawLinkedSession && /^[A-Za-z0-9_-]{1,128}$/.test(rawLinkedSession) ? rawLinkedSession : null;
  useEffect(() => {
    if (!linkedSessionId) return;
    setActiveTab('sessions');
    setViewedSessionId(linkedSessionId);
  }, [linkedSessionId]);

  const closeSession = useCallback(() => {
    setViewedSessionId(null);
    if (!linkedSessionId) return;
    // Leave the link behind, or reloading the page would open the session again.
    const next = new URLSearchParams(searchParams.toString());
    next.delete(SESSION_QUERY_PARAM);
    next.set('tab', 'sessions');
    router.replace(`/dashboard/agents/${encodeURIComponent(agentId)}?${next.toString()}`, { scroll: false });
  }, [linkedSessionId, searchParams, router, agentId]);

  useEffect(() => {
    if (activeTab === 'sessions' && agent && agent.config?.kind !== 'external') void loadReminderSummary();
  }, [activeTab, agent, loadReminderSummary]);

  /**
   * Configure is one long page, so "go to the Prompt section" is a scroll,
   * not a pane switch. Waits a frame because the section only exists once
   * the tab panel has rendered.
   */
  useEffect(() => {
    // Configure and Deploy are both single pages now, so either one's
    // sub-target is a section anchor to scroll to.
    const section = activeTab === 'configure' ? configureTab : activeTab === 'deploy' ? deployTab : null;
    if (!section || !agent) return;
    // The first section is where the tab opens anyway: scrolling to it only hid the header and tabs (and, on Ship,
    // the summary above Versions).
    if ((activeTab === 'configure' && section === 'basic') || (activeTab === 'deploy' && section === 'versions')) return;
    // A link to a section the agent does not use opens it, instead of landing on its one-line "Not set".
    if (activeTab === 'configure') {
      setExpandedUnset((current) => (current.has(section) ? current : new Set([...current, section])));
    }
    const frame = requestAnimationFrame(() => {
      document.getElementById(`config-${section}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, configureTab, deployTab, agent]);

  // Records of the bound tools, loaded once per set of bound sources (a refresh failing leaves "no hints", which asks).
  const boundSourceKeys = toolBindings
    .filter((binding) => binding.source === 'tool' || binding.source === 'mcp')
    .map((binding) => `${binding.source}:${binding.sourceKey}`)
    .sort()
    .join('|');
  useEffect(() => {
    if (!boundSourceKeys) {
      setToolRecords({ tools: [], mcp: [] });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [toolsRes, mcpRes] = await Promise.all([
          fetch('/api/tools', { cache: 'no-store' }),
          // The hub's servers and this agent's own ones.
          fetch(`/api/mcp?agentId=${encodeURIComponent(agentId)}`, { cache: 'no-store' }),
        ]);
        const toolsData = toolsRes.ok ? await toolsRes.json() : {};
        const mcpData = mcpRes.ok ? await mcpRes.json() : {};
        if (!cancelled) setToolRecords({ tools: toolsData.tools ?? [], mcp: mcpData.servers ?? [] });
      } catch {
        // Keep what is shown: the table then reads those tools as "no hints".
      }
    })();
    return () => { cancelled = true; };
  }, [boundSourceKeys, agentId, ownedMcpVersion]);
  const toolKinds = useMemo(
    () => boundToolKinds(toolBindings, toolRecords.tools, toolRecords.mcp),
    [toolBindings, toolRecords],
  );

  const publishedVersionNumber = agent?.publishedVersion ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!publishedVersionNumber) {
      setPublishedConfig(null);
      return;
    }
    fetch(`/api/agents/${agentId}/versions?version=${publishedVersionNumber}`, { cache: 'no-store' })
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data: { version?: AgentVersion } | null) => {
        if (cancelled) return;
        setPublishedConfig((data?.version?.snapshot?.config as Record<string, unknown> | undefined) ?? null);
        setPublishedConfigKey(`${agentId}@${publishedVersionNumber}`);
      })
      .catch(() => {
        if (cancelled) return;
        setPublishedConfig(null);
        setPublishedConfigKey(`${agentId}@${publishedVersionNumber}`);
      });
    return () => { cancelled = true; };
  }, [agentId, publishedVersionNumber]);

  // Loaded when Overview or Ship is shown, again after a load, save or publish changed what the agent uses.
  const agentRecordId = agent?._id ? String(agent._id) : null;
  const agentKind = agent?.config?.kind;
  const needsUsage = activeTab === 'overview' || activeTab === 'deploy';
  const usageRefreshKey = `${agent?.publishedVersion ?? 0}:${agent?.metadata?.a2a?.enabled === true}`;
  useEffect(() => {
    if (!agentRecordId || !needsUsage || ownedByFlow) return undefined;
    const controller = new AbortController();
    setAgentUsageFailed(false);
    fetchResourceUsage('agent', agentRecordId, controller.signal)
      .then((usage) => setAgentUsage(usage))
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setAgentUsageFailed(true);
      });
    if (agentKind !== 'external') {
      fetch(`/api/agents/${agentId}/triggers`, { cache: 'no-store', signal: controller.signal })
        .then(async (res) => (res.ok ? (await res.json()) as { data?: unknown[] } : null))
        .then((data) => setTriggerCount(data ? (data.data ?? []).length : null))
        .catch(() => { if (!controller.signal.aborted) setTriggerCount(null); });
    }
    return () => controller.abort();
  }, [agentRecordId, agentKind, agentId, needsUsage, ownedByFlow, savedPayload, usageRefreshKey]);

  const changedSections = useMemo(
    () => changedConfigSections(agent?.config as Record<string, unknown> | undefined, publishedConfig),
    [agent?.config, publishedConfig],
  );

  const sectionVisible = (id: string) => !onlyChanged || changedSections.has(id);

  const buildConfigPayload = (bindings: ToolBinding[] = toolBindings): Record<string, unknown> => {
    const values = configForm.values;
    const nextConfig: Record<string, unknown> = {
      modelKey: values.modelKey,
      // Never the main model (the picker hides it, and a model switched to main drops out of the list).
      additionalModels: additionalModels.filter((entry) => entry.modelKey !== values.modelKey).length > 0
        ? additionalModels.filter((entry) => entry.modelKey !== values.modelKey)
        : undefined,
      // Reasoning of the main model: set means the agent decides; unset leaves it to the Model Hub default.
      reasoningEffort: mainReasoning.reasoningEffort,
      reasoningBudgetTokens: mainReasoning.reasoningEffort && mainReasoning.reasoningEffort !== 'none'
        ? mainReasoning.reasoningBudgetTokens
        : undefined,
      showReasoning: showReasoning ? undefined : false,
      // No temperature. The form used to send 0.7 and 4096 on every save, so
      // every agent was silently capped at 4096 output tokens and pinned to a
      // temperature — settings nobody chose and, once the fields were removed,
      // nobody could see. Leaving them out lets the model record's own
      // settings govern; the next save clears any value an older save wrote.
      // topP went the same way. maxTokens is back ONLY as an explicit field
      // (Advanced > Max output tokens per call): blank stays absent, so the
      // model's own default governs; a value is somebody's choice.
      maxTokens,
      // Legacy single key is migrated into bindings on save.
      knowledgeEngineKey: undefined,
      knowledgeBindings: values.knowledgeBindings.filter((b) => b.key).length > 0
        ? values.knowledgeBindings.filter((b) => b.key)
        : undefined,
      knowledgeToolMode: values.knowledgeBindings.filter((b) => b.key).length > 1
        ? values.knowledgeToolMode
        : undefined,
      toolBindings: bindings.length > 0 ? bindings : undefined,
    };

    // The list is authoritative, always. Only it is sent: the API derives the
    // deprecated slots from it, so an older console binary on the same tenant
    // database keeps enforcing and the two can never disagree.
    nextConfig.guardrails = guardrailBindings;

    // `undefined` rather than `{}` / `[]` for the untouched case: an empty
    // object here would be indistinguishable from "operator cleared every knob"
    // and would start showing up in every manifest and diff for no reason.
    nextConfig.runtime = Object.keys(runtimeConfig).length > 0 ? runtimeConfig : undefined;
    nextConfig.structuredOutput = structuredOutput?.enabled || structuredOutput?.schema ? structuredOutput : undefined;
    nextConfig.variables = variablesConfig && variablesConfig.length > 0 ? variablesConfig : undefined;
    nextConfig.subagents = subagents.length > 0 ? subagents : undefined;
    nextConfig.subagentPolicy = subagentPolicyToStore(subagents, subagentPolicy);
    nextConfig.skills = skills.length > 0 ? skills : undefined;
    nextConfig.skillPolicy = skills.length > 0 ? skillPolicy : undefined;
    nextConfig.memory = memoryConfig?.enabled || memoryConfig?.memoryStoreKey || memoryConfig?.mounts?.length ? memoryConfig : undefined;
    // Kept even when disabled, so turning the sandbox off does not throw away
    // the template, limits and secrets someone set up. Secrets come back from
    // the server masked; sending the mask back keeps the stored value.
    nextConfig.sandbox = sandboxConfig && Object.keys(sandboxConfig).length > 0 ? sandboxConfig : undefined;
    // The callback secret comes back masked; sending the mask back keeps the stored value.
    nextConfig.callback = callbackConfig && Object.keys(callbackConfig).length > 0 ? callbackConfig : undefined;
    nextConfig.budget = budgetConfig ?? undefined;
    // No editor writes this from here anymore (see the Prompt tab) — pass
    // through whatever is already stored so a save from THIS page can never
    // silently wipe a value an import or the API set, since `config` replaces
    // the stored object wholesale rather than merging.
    nextConfig.promptVariables = agent?.config?.promptVariables;
    // Absent stays absent: an agent that never opened Approvals & questions
    // (every agent from before it existed) must keep never pausing.
    nextConfig.humanInTheLoop = hitlConfig && Object.keys(hitlConfig).length > 0 ? hitlConfig : undefined;
    // Absent = reminders off.
    nextConfig.reminders = remindersConfig && Object.keys(remindersConfig).length > 0 ? remindersConfig : undefined;
    nextConfig.clientTools = normalizeClientTools(clientToolsConfig);
    nextConfig.clientToolSurfaces = clientToolSurfaces && Object.keys(clientToolSurfaces).length > 0 ? clientToolSurfaces : undefined;
    // Absent = files off.
    nextConfig.attachments = attachmentsConfig && Object.keys(attachmentsConfig).length > 0 ? attachmentsConfig : undefined;
    // Absent = off (the model's own protection, if any, still applies). `config` replaces the stored object
    // wholesale, so this must always be sent or a save from here would drop a policy set through the API.
    nextConfig.piiProtection = piiProtectionPayload(piiPolicyKey) ?? undefined;

    if (values.promptMode === 'custom') {
      nextConfig.systemPrompt = values.systemPrompt;
      nextConfig.promptKey = undefined;
    } else {
      nextConfig.promptKey = values.promptKey;
      nextConfig.systemPrompt = undefined;
    }

    return nextConfig;
  };

  /** The sentence for a Files problem that blocks a save (the server words the rest). */
  const filesErrorMessage = (code: ReturnType<typeof filesSaveErrors>[number]['code']): string =>
    code === 'bucket_required' ? t('attachments.bucketRequired')
      : code === 'invalid_chars' ? t('attachments.folderInvalidChars')
        : code === 'dot_dot' ? t('attachments.folderDotDot')
          : code === 'ocr_model' ? t('attachments.ocrModelInvalid')
            : code === 'ocr_languages' ? t('attachments.ocrLanguagesInvalid')
              : code === 'ocr_pages' ? t('attachments.ocrPagesInvalid')
                : t('attachments.folderTooLong', { max: MAX_FOLDER_LENGTH });

  /** An edit in Files. Once the problem that refused the last save is fixed, its message goes away with it. */
  const handleFilesChange = (next: AttachmentsSettings | undefined) => {
    setAttachmentsConfig(next);
    if (!filesSaveRefused || filesSaveErrors(next).length > 0) return;
    setFilesSaveRefused(false);
    setConfigIssues((current) => (current && current.errors.length > 0 && current.errors.every((issue) => issue.field.startsWith('attachments.'))
      ? null
      : current));
  };

  const saveAgentConfig = async (
    options: { notify?: boolean; bindings?: ToolBinding[] } = {},
  ): Promise<boolean> => {
    const notify = options.notify ?? true;

    // Files on without a bucket (or a folder the server would refuse) is not
    // sent at all: the field says what to fix instead of a round trip doing it.
    const filesErrors = filesSaveErrors(attachmentsConfig);
    if (filesErrors.length > 0) {
      setFilesSaveRefused(true);
      setConfigIssues({
        errors: filesErrors.map((error) => ({ field: error.field, message: filesErrorMessage(error.code) })),
        warnings: [],
      });
      if (notify) {
        notifications.show({
          title: t('notifications.error'),
          message: filesErrorMessage(filesErrors[0].code),
          color: 'red',
        });
        document.getElementById('config-files')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return false;
    }

    try {
      const payload = buildConfigPayload(options.bindings);
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: payload }),
      });

      if (!res.ok) {
        // Used to `return false` in silence, so a rejected save looked
        // exactly like a button that did nothing — and the operator kept
        // the config they thought they had stored. Say what the server said.
        const body = await res.json().catch(() => ({} as {
          error?: string;
          validation?: { errors: Array<{ field: string; message: string }>; warnings: Array<{ field: string; message: string }> };
        }));
        if (body?.validation) setConfigIssues(body.validation);
        if (notify) {
          notifications.show({
            title: t('notifications.error'),
            message: body?.validation?.errors?.length
              ? `The config has ${body.validation.errors.length} problem${body.validation.errors.length === 1 ? '' : 's'} — see the list above Save.`
              : body?.error || `${t('notifications.saveFailed')} (HTTP ${res.status})`,
            color: 'red',
          });
        }
        return false;
      }

      const data = await res.json();
      setAgent(data.agent);
      setSavedPayload(payload);
      setFilesSaveRefused(false);
      setConfigIssues(Array.isArray(data.warnings) && data.warnings.length > 0
        ? { errors: [], warnings: data.warnings }
        : null);
      if (notify) {
        notifications.show({
          title: t('notifications.saved'),
          message: t('notifications.savedDesc'),
          color: 'teal',
        });
      }
      return true;
    } catch {
      if (notify) {
        notifications.show({
          title: t('notifications.error'),
          message: t('notifications.saveFailed'),
          color: 'red',
        });
      }
      return false;
    }
  };

  const updateA2a = async (patch: Partial<Pick<A2aMetadata, 'enabled' | 'accessMode'>>) => {
    if (!agent) return;
    setA2aSaving(true);
    const current = agent.metadata?.a2a;
    const next: A2aMetadata = {
      enabled: current?.enabled === true,
      accessMode: current?.accessMode === 'public' ? 'public' : 'token',
      ...patch,
    };
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: { ...(agent.metadata ?? {}), a2a: next },
        }),
      });
      if (!res.ok) throw new Error('update failed');
      const data = await res.json();
      setAgent(data.agent);
      if (patch.enabled !== undefined) {
        notifications.show({
          title: patch.enabled ? t('a2a.enabled') : t('a2a.disabled'),
          message: '',
          color: 'teal',
        });
      }
    } catch {
      notifications.show({
        title: t('notifications.error'),
        message: t('a2a.updateFailed'),
        color: 'red',
      });
    } finally {
      setA2aSaving(false);
    }
  };

  /** Flows tab: save the agent's tool bindings and say so (by throwing) when the server refused them. */
  const handleFlowBindingsChange = async (bindings: ToolBinding[]) => {
    const previous = toolBindings;
    setToolBindings(bindings);
    const saved = await saveAgentConfig({ notify: false, bindings });
    if (!saved) {
      setToolBindings(previous);
      throw new Error(flowTexts.exposeFailed);
    }
  };

  const handleToolBindingsChange = async (bindings: ToolBinding[]) => {
    setToolBindings(bindings);
    const saved = await saveAgentConfig({ notify: false, bindings });
    if (!saved) {
      notifications.show({
        title: t('notifications.error'),
        message: 'Failed to save selected tools.',
        color: 'red',
      });
    }
  };

  // ── Unsaved changes ─────────────────────────────────────────
  // The baseline is what Save would send for the config just loaded — built by the same function, so a value the
  // form normalises on load (legacy knowledge key, old reasoning fields) never reads as an edit. Taken after the
  // loaded state has rendered (and after any panel's first adjustment), from the latest render's builder.
  const buildPayloadRef = useRef(buildConfigPayload);
  buildPayloadRef.current = buildConfigPayload;
  useEffect(() => {
    if (hydration === 0) return undefined;
    const timer = window.setTimeout(() => setSavedPayload(buildPayloadRef.current()), 0);
    return () => window.clearTimeout(timer);
  }, [hydration]);
  const unsavedSections = savedPayload ? changedConfigSections(buildConfigPayload(), savedPayload) : new Set<string>();
  const { confirm } = useConfirm();
  const discardUnsaved = async () => {
    const ok = await confirm({
      title: t('build.discardTitle'),
      message: t('build.discardMessage'),
      confirmLabel: t('build.discard'),
      tone: 'danger',
    });
    if (!ok) return;
    setConfigIssues(null);
    await loadAgent();
  };

  // ── Config Save ──────────────────────────────────────────────

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      await saveAgentConfig();
    } finally {
      setSavingConfig(false);
    }
  };

  if (loading) {
    return <LoadingState label="Loading agent..." minHeight={400} />;
  }

  if (!agent) {
    return <EmptyState title={t('notFound')} description="The selected agent could not be loaded." minHeight={400} />;
  }

  const isConnected = agent.config?.kind === 'external';
  // A FlowBase agent: a flow answers every turn, so the model, prompt and tool sections do not apply.
  const isFlow = agent.config?.kind === 'flow';
  const showFlowsTab = flowsPermission.read && !isConnected && !ownedByFlow;
  // An owned agent has Sessions (to test it) and Build only.
  const visibleTab = ownedByFlow
    ? (activeTab === 'sessions' ? 'sessions' : 'configure')
    : activeTab === 'flows' && !showFlowsTab ? 'overview' : activeTab;
  const connection = agent.config?.connection;

  // ── A2A publish state ────────────────────────────────────────
  const a2aConfig = agent.metadata?.a2a;
  const a2aEnabled = a2aConfig?.enabled === true;
  const a2aAccessMode: 'token' | 'public' = a2aConfig?.accessMode === 'public' ? 'public' : 'token';
  const a2aIsPublic = a2aAccessMode === 'public' && Boolean(a2aConfig?.endpointSlug);
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com';
  const a2aEndpointUrl = a2aIsPublic
    ? `${origin}/api/public/a2a/${agent.tenantId}/${a2aConfig?.endpointSlug}`
    : `${origin}/api/client/v1/a2a/${agent.key}`;
  const a2aCardUrl = `${a2aEndpointUrl}/.well-known/agent-card.json`;

  // The variables a call has to supply are those of the version it runs: the published snapshot's, not the draft's.
  const variablesLoading = Boolean(publishedVersionNumber) && publishedConfigKey !== `${agentId}@${publishedVersionNumber}`;
  const callVariables = variablesOfRunVersion({
    publishedVersion: publishedVersionNumber,
    publishedConfig,
    draftVariables: agent.config?.variables,
  });

  // The main model as picked in the form: its own PII protection is shown next to the agent's.
  const mainModel = models.find((m) => m.key === configForm.values.modelKey);

  /**
   * The General section's fields, all open.
   *
   * These used to be four collapsibles ("Knowledge Engine", "Guardrails",
   * "Tools", "Advanced Settings") inside their own card, each hiding one or
   * two inputs. That is a lot of clicking to answer "what is this agent wired
   * to", and the answer is short enough to just show — so the accordions are
   * gone and each group is a labelled block instead.
   */
  const renderBasicSettings = () => (
    isConnected ? (
      <Stack gap="sm">
        <div>
          <Text size="xs" c="dimmed">{t('connectModal.protocol')}</Text>
          <Text size="sm" fw={500}>{connection?.protocol ?? '—'}</Text>
        </div>
        <div>
          <Text size="xs" c="dimmed">{t('connectModal.url')}</Text>
          <Text size="sm" className="ds-mono" style={{ wordBreak: 'break-all' }}>
            {connection?.url ?? '—'}
          </Text>
        </div>
        {connection?.model ? (
          <div>
            <Text size="xs" c="dimmed">{t('connectModal.model')}</Text>
            <Text size="sm" className="ds-mono">{connection.model}</Text>
          </div>
        ) : null}
        <div>
          <Text size="xs" c="dimmed">{t('connectModal.authSection')}</Text>
          <Text size="sm">
            {connection?.authType === 'console_identity'
              ? tIdentity('optionLabel')
              : connection?.hasApiKey
                ? t('connectModal.apiKey')
                : connection?.credentialProviderKey
                  ? `${t('connectModal.credentialProvider')}: ${connection.credentialProviderKey}`
                  : '—'}
          </Text>
        </div>
        {connection?.responsePath ? (
          <div>
            <Text size="xs" c="dimmed">{t('connectModal.responsePath')}</Text>
            <Text size="sm" className="ds-mono">{connection.responsePath}</Text>
          </div>
        ) : null}
        <Text size="xs" c="dimmed" fs="italic" mt="xs">
          {t('connectModal.subtitle')}
        </Text>
        <Button
          variant="light"
          size="xs"
          leftSection={<IconPencil size={14} />}
          onClick={() => setEditConnectionOpen(true)}
          w="fit-content"
        >
          {t('connectModal.editButton')}
        </Button>
      </Stack>
    ) : isFlow ? (
      <FlowAgentCard
        agentId={String(agent._id)}
        config={agent.config}
        canWrite={flowsPermission.write}
        onSaved={() => void loadAgent()}
      />
    ) : (
      <Stack gap="xl">
        <Group align="flex-end" gap="sm" wrap="wrap">
          <Select
            label={t('config.model')}
            placeholder={t('config.modelPlaceholder')}
            data={models.map((m) => ({
              value: m.key,
              label: `${m.name} (${m.modelId})`,
            }))}
            searchable
            style={{ flex: 1, minWidth: 220 }}
            {...configForm.getInputProps('modelKey')}
            onChange={(next) => {
              // Another model may speak another reasoning dialect: its pick starts at "Model default".
              if (next !== configForm.values.modelKey) setMainReasoning({});
              configForm.setFieldValue('modelKey', next ?? '');
            }}
          />
          <AgentReasoningPicker
            model={models.find((m) => m.key === configForm.values.modelKey)}
            driverByProviderKey={driverByProviderKey}
            value={mainReasoning}
            onChange={setMainReasoning}
            testId="agent-main-reasoning"
          />
        </Group>

        <AgentAdditionalModels
          value={additionalModels}
          onChange={setAdditionalModels}
          models={models}
          mainModelKey={configForm.values.modelKey}
          driverByProviderKey={driverByProviderKey}
          labels={{
            title: t('config.additionalModels'),
            description: t('config.additionalModelsDescription'),
            placeholder: t('config.additionalModelsPlaceholder'),
            modelColumn: t('config.additionalModelColumn'),
            reasoningColumn: t('config.reasoningEffort'),
          }}
        />

        <Switch
          label={t('config.showReasoning')}
          description={t('config.showReasoningDescription')}
          checked={showReasoning}
          onChange={(event) => setShowReasoning(event.currentTarget.checked)}
          data-testid="agent-show-reasoning"
        />

        {/* Prompt configuration (mode / template / managed prompt) lives in
            its own "Prompt" section — see AgentPromptPanel. Editing the prompt
            is common and deep enough (switching modes, editing the managed
            Prompt record's template inline) to earn its own block instead of
            sharing this one with the model picker. */}

        <ConfigBlock id="knowledge" icon={<IconDatabase size={15} />} title={t('config.knowledgeEngine')}>
          <KnowledgeBindingsEditor
            modules={ragModules}
            bindings={configForm.values.knowledgeBindings}
            mode={configForm.values.knowledgeToolMode}
            onBindingsChange={(next) => configForm.setFieldValue('knowledgeBindings', next)}
            onModeChange={(mode) => configForm.setFieldValue('knowledgeToolMode', mode)}
            onModuleCreated={(created) =>
              setRagModules((current) =>
                current.some((m) => m.key === created.key)
                  ? current
                  : [
                      ...current,
                      {
                        _id: String(created._id ?? created.key),
                        key: created.key,
                        name: created.name,
                        status: String(created.status ?? 'active'),
                      },
                    ],
              )
            }
          />
        </ConfigBlock>

        <ConfigBlock id="guardrails" icon={<IconShield size={15} />} title={t('config.guardrails')}>
          {/*
            One guardrail per row, each naming the hooks it covers on THIS
            agent. The tool hooks are the new capability here: an agent's own
            action tools are the surface a tool policy could never reach
            through the old direction slots.
          */}
          <GuardrailBindingList
            options={guardrails}
            value={guardrailBindings}
            onChange={setGuardrailBindings}
            surface="agent"
          />
        </ConfigBlock>

        <ConfigBlock id="pii" icon={<IconShieldLock size={15} />} title={tPii('title')}>
          <Stack gap="xs">
            <Text size="xs" c="dimmed">{tPii('agent.description')}</Text>
            <PiiProtectionField
              surface="agent"
              value={piiPolicyKey}
              onChange={setPiiPolicyKey}
              modelPolicyKey={piiPolicyKeyOf(mainModel?.piiProtection)}
              modelName={mainModel?.name}
            />
          </Stack>
        </ConfigBlock>

        <ConfigBlock id="tools" icon={<IconTool size={15} />} title={t('config.tools')}>
          <AgentToolsList
            agentId={agentId}
            bindings={toolBindings}
            onBindingsChange={handleToolBindingsChange}
            onServersChanged={() => setOwnedMcpVersion((version) => version + 1)}
            readOnly={readOnly}
          />
        </ConfigBlock>

      </Stack>
    )
  );

  /**
   * One Build section, or nothing when "only changed" hides it. A connected
   * agent has only General. Sections are always open: the config is edited as
   * a whole and saved by one button, so folding them only hid what the agent is.
   */
  const remindersViewAvailable = showRemindersView({
    draft: remindersConfig,
    published: publishedConfig?.reminders as IAgentRemindersConfig | undefined,
    hasAny: hasReminders,
  });

  const sectionShown = (id: string) =>
    (id === 'basic' || !(isConnected || isFlow)) && !(ownedByFlow && OWNED_HIDDEN_SECTIONS.has(id)) && sectionVisible(id);
  // The divider above a section is skipped for the first one SHOWN — with "only changed" on, that is not always General.
  const firstShownSection = BUILD_SECTION_ORDER.find(sectionShown);
  // A section the agent does not use is one line ("Not set · Set up") — unless someone opened it, it differs from the
  // published version (the reviewer has to see what was removed) or it has unsaved edits. Judged on the saved draft,
  // so clearing a field while editing does not fold the section away under the cursor.
  const foldedSections = unsetConfigSections(savedPayload ?? (agent.config as Record<string, unknown> | undefined));
  for (const id of [...foldedSections]) {
    if (expandedUnset.has(id) || changedSections.has(id) || unsavedSections.has(id)) foldedSections.delete(id);
  }
  const openSection = (id: string) => setExpandedUnset((current) => new Set([...current, id]));
  const jumpToSection = (id: string) =>
    document.getElementById(`config-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const buildSection = (id: string, description: string, body: ReactNode, meta?: ReactNode) =>
    sectionShown(id) ? (
      <ConfigSection
        id={id}
        title={configSectionTitle(id, t)}
        description={description}
        meta={meta}
        changed={changedSections.has(id)}
        first={id === firstShownSection}
        unset={foldedSections.has(id)}
        onSetUp={readOnly ? undefined : () => openSection(id)}
      >
        {body}
      </ConfigSection>
    ) : null;

  // The index beside a native agent's Build page: every section shown, in page order, grouped.
  const buildIndexGroups: BuildIndexGroup[] = BUILD_SECTION_GROUPS.map((group) => ({
    id: group.id,
    title: t(`build.groups.${group.id}`),
    items: group.sections.filter(sectionShown).map((id) => ({
      id,
      title: configSectionTitle(id, t),
      state: changedSections.has(id) ? 'changed' as const : foldedSections.has(id) ? 'unset' as const : null,
      parts: id === 'basic' && !isFlow
        ? [
          { id: 'knowledge', title: t('config.knowledgeEngine') },
          { id: 'guardrails', title: t('config.guardrails') },
          { id: 'pii', title: tPii('title') },
          { id: 'tools', title: t('config.tools') },
        ]
        : undefined,
    })),
  }));
  const showBuildIndex = !(isConnected || isFlow) && buildIndexGroups.reduce((sum, group) => sum + group.items.length, 0) > 2;
  const unsavedTitles = BUILD_SECTION_ORDER.filter((id) => unsavedSections.has(id)).map((id) => configSectionTitle(id, t));
  const changedTitles = BUILD_SECTION_ORDER.filter((id) => changedSections.has(id)).map((id) => configSectionTitle(id, t));
  const versionPageCount = Math.max(1, Math.ceil(versions.length / VERSIONS_PAGE_SIZE));
  // Clamped: the list can shrink under the page asked for (a reload with fewer versions).
  const shownVersionsPage = Math.min(versionsPage, versionPageCount);
  const publishedVersionRecord = agent.publishedVersion
    ? versions.find((version) => version.version === agent.publishedVersion) ?? null
    : null;

  const buildSectionElements: Record<string, ReactNode> = {
    basic: buildSection(
      'basic',
      isFlow ? flowTexts.flowBuildDescription : 'What this agent is, which model answers, and the tools it can call.',
      renderBasicSettings(),
    ),
    prompt: buildSection(
      'prompt',
      'Inline text, or a prompt from the Prompts module — editable right here.',
      <AgentPromptPanel
        mode={configForm.values.promptMode}
        onModeChange={(mode) => configForm.setFieldValue('promptMode', mode)}
        systemPrompt={configForm.values.systemPrompt}
        onSystemPromptChange={(value) => configForm.setFieldValue('systemPrompt', value)}
        promptKey={configForm.values.promptKey}
        onPromptKeyChange={(key) => configForm.setFieldValue('promptKey', key)}
        prompts={prompts}
        onPromptsChanged={setPrompts}
        onSaveAgentConfig={handleSaveConfig}
      />,
    ),
    subagents: buildSection(
      'subagents',
      'Roles this agent can hand work to, and the guards around that.',
      <AgentSubagentsPanel
        subagents={subagents}
        policy={subagentPolicy}
        agents={projectAgents}
        models={models.map((model) => ({ key: model.key, name: model.name }))}
        currentAgentKey={agent.key}
        onChange={(nextSubagents, nextPolicy) => {
          setSubagents(nextSubagents);
          setSubagentPolicy(nextPolicy);
        }}
      />,
      subagents.length > 0 ? (
        <Badge size="xs" variant="light" w="fit-content">{subagents.length} sub-agents</Badge>
      ) : null,
    ),
    skills: buildSection(
      'skills',
      "Capabilities this agent can discover and open on demand, from the project's skill library.",
      <AgentSkillsPanel
        skills={skills}
        policy={skillPolicy}
        library={skillLibrary}
        agentId={agentId}
        onLibraryAdd={(skill) => setSkillLibrary((prev) => [...prev.filter((s) => s.key !== skill.key), skill])}
        onLibraryRemove={(key) => setSkillLibrary((prev) => prev.filter((s) => s.key !== key))}
        onChange={(nextSkills, nextPolicy) => {
          setSkills(nextSkills);
          setSkillPolicy(nextPolicy);
        }}
      />,
      skills.length > 0 ? (
        <Badge size="xs" variant="light" w="fit-content">{skills.length} attached</Badge>
      ) : null,
    ),
    memory: buildSection(
      'memory',
      'What this agent remembers across runs, backed by a store from the Memory module.',
      <AgentMemoryPanel
        value={memoryConfig}
        onChange={setMemoryConfig}
        stores={memoryStores}
        onStoreCreated={(store) =>
          setMemoryStores((current) =>
            current.some((s) => s.key === store.key) ? current : [...current, store],
          )
        }
      />,
      memoryConfig?.enabled ? (
        <Badge size="xs" color="teal" variant="light" w="fit-content">on</Badge>
      ) : null,
    ),
    sandbox: buildSection(
      'sandbox',
      'An isolated machine the agent can run commands and code in — template, lifetime, limits and secrets.',
      <AgentSandboxPanel value={sandboxConfig} onChange={setSandboxConfig} agentId={agentId} />,
      sandboxConfig?.enabled ? (
        <Badge size="xs" color="grape" variant="light" w="fit-content">
          {SANDBOX_MODE_BADGES[resolveSandboxMode(sandboxConfig.mode)]}
        </Badge>
      ) : null,
    ),
    callback: buildSection(
      'callback',
      t('runSettings.sectionDescription'),
      <AgentRunSettingsPanel
        callback={callbackConfig}
        onCallbackChange={setCallbackConfig}
        budget={budgetConfig}
        onBudgetChange={setBudgetConfig}
      />,
      callbackConfig?.url ? (
        <Badge size="xs" color="indigo" variant="light" w="fit-content">{t('runSettings.badgeCallback')}</Badge>
      ) : null,
    ),
    files: buildSection(
      'files',
      t('attachments.sectionDescription'),
      <AgentFilesPanel
        value={attachmentsConfig}
        onChange={handleFilesChange}
        agentKey={agent.key}
        showErrors={filesSaveRefused}
      />,
      filesEnabled(attachmentsConfig) ? (
        <Badge size="xs" color="teal" variant="light" w="fit-content">
          {t('attachments.badgeOn', {
            files: attachmentsConfig?.maxFiles ?? SESSION_FILES_DEFAULTS.maxFiles,
            days: attachmentsConfig?.retentionDays ?? SESSION_FILES_DEFAULTS.retentionDays,
          })}
        </Badge>
      ) : (
        <Badge size="xs" color="gray" variant="light" w="fit-content">{t('attachments.badgeOff')}</Badge>
      ),
    ),
    clienttools: buildSection(
      'clienttools',
      t('clientTools.sectionDescription'),
      <Stack gap="lg">
        <AgentClientToolsPanel value={clientToolsConfig} onChange={setClientToolsConfig} />
        <ClientToolsSurfaces value={clientToolSurfaces} onChange={setClientToolSurfaces} />
      </Stack>,
      clientToolsConfig && clientToolsConfig.length > 0 ? (
        <Badge size="xs" color="grape" variant="light" w="fit-content">
          {t('clientTools.badgeCount', { count: clientToolsConfig.length })}
        </Badge>
      ) : null,
    ),
    hitl: buildSection(
      'hitl',
      t('hitl.sectionDescription'),
      <AgentHumanInTheLoopPanel
        value={hitlConfig}
        onChange={setHitlConfig}
        agentId={agentId}
        clientTools={clientToolsConfig}
        toolKinds={toolKinds}
        toolConfig={{
          toolBindings,
          knowledgeBindings: configForm.values.knowledgeBindings.filter((b) => b.key),
          knowledgeToolMode: configForm.values.knowledgeToolMode,
          subagents,
          skills,
          memory: memoryConfig,
          sandbox: sandboxConfig,
        }}
      />,
      hitlConfig?.toolApproval?.enabled !== false || hitlConfig?.askUser?.enabled ? (
        <Badge size="xs" color="orange" variant="light" w="fit-content">
          {[hitlConfig?.toolApproval?.enabled !== false ? t('hitl.badgeApprovals') : null, hitlConfig?.askUser?.enabled ? t('hitl.badgeQuestions') : null]
            .filter(Boolean).join(' + ')}
        </Badge>
      ) : null,
    ),
    advanced: buildSection(
      'advanced',
      'How the agent loop behaves: planning, budgets, context handling and reasoning.',
      <>
      <AgentAdvancedSettings
        value={runtimeConfig}
        onChange={setRuntimeConfig}
        toolNames={toolBindings.flatMap((binding) => binding.toolNames ?? [])}
        maxTokens={maxTokens}
        onMaxTokensChange={(next) => setMaxTokens(next !== undefined && next > 0 ? Math.floor(next) : undefined)}
        maxTokensLabels={{
          label: t('config.maxTokensPerCall'),
          description: t('config.maxTokensPerCallDescription'),
          placeholder: t('config.maxTokensPerCallPlaceholder'),
        }}
      />
      <AgentRemindersSettings
        value={remindersConfig}
        onChange={setRemindersConfig}
        onGoToSection={(section) => document.getElementById(`config-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      />
      </>,
    ),
    variables: buildSection(
      'variables',
      t('variables.sectionDescription'),
      <AgentVariablesEditor value={variablesConfig} onChange={setVariablesConfig} />,
      variablesConfig?.length ? (
        <Badge size="xs" color="cyan" variant="light" w="fit-content">{t('variables.badge', { count: variablesConfig.length })}</Badge>
      ) : null,
    ),
    output: buildSection(
      'output',
      'Make the agent answer with JSON that matches a schema instead of free text.',
      <AgentStructuredOutputEditor value={structuredOutput} onChange={setStructuredOutput} />,
    ),
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow={ownedByFlow ? flowTexts.ownedEyebrow : isConnected ? 'Build · Connected Agent' : isFlow ? flowTexts.flowEyebrow : 'Build · Agent'}
        title={agent.name}
        subtitle={ownedByFlow ? agent.description || undefined : agent.description || agent.key}
        actions={
          <Group gap="sm">
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setStartSessionOpen(true)}
            >
              Start session
            </Button>
            {ownedByFlow ? null : isConnected ? (
              <Badge size="sm" variant="light" color="violet" leftSection={<IconPlugConnected size={12} />}>
                {connection?.protocol ?? t('connectedBadge')}
              </Badge>
            ) : (
              <>
                {agent.publishedVersion ? (
                  <Badge size="sm" variant="light" color="teal" leftSection={<IconRocket size={12} />}>
                    {t('publish.publishedVersion', { version: agent.publishedVersion })}
                  </Badge>
                ) : (
                  <Badge size="sm" variant="light" color="gray">
                    {t('publish.neverPublished')}
                  </Badge>
                )}
                {/* What publishing would change, in the header of every tab — not only as a count on Build. */}
                {agent.publishedVersion && changedSections.size > 0 ? (
                  <Tooltip label={t('header.draftTooltip', { sections: changedTitles.join(', ') })} withArrow multiline maw={320}>
                    <Badge size="sm" variant="outline" color="orange" data-testid="agent-draft-badge">
                      {changedSections.size === 1 ? t('header.draftOne') : t('header.draftMany', { count: changedSections.size })}
                    </Badge>
                  </Tooltip>
                ) : null}
                <Button
                  size="xs"
                  leftSection={<IconRocket size={14} />}
                  onClick={() => setPublishModalOpen(true)}
                >
                  {t('publish.button')}
                </Button>
              </>
            )}
            {/* Less frequent actions, one click away instead of three more buttons in the header. */}
            {!isConnected ? (
              <Menu position="bottom-end" withinPortal shadow="md">
                <Menu.Target>
                  <ActionIcon variant="default" size="md" aria-label={t('header.more')} data-testid="agent-header-more">
                    <IconDots size={16} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {!isFlow && !ownedByFlow && (agent.latestVersion ?? 0) > 0 ? (
                    <Menu.Item leftSection={<IconArrowsLeftRight size={14} />} onClick={() => setCompareOpen(true)}>
                      {t('header.compare')}
                    </Menu.Item>
                  ) : null}
                  <Menu.Item leftSection={<IconUpload size={14} />} onClick={() => setUpdateFromFileOpen(true)}>
                    {t('header.updateFromFile')}
                  </Menu.Item>
                  {ownedByFlow ? null : (
                    <Menu.Item
                      leftSection={<IconFileExport size={14} />}
                      onClick={() => {
                        setActiveTab('deploy');
                        setDeployTab('export');
                        // Already on Export: the state does not change, so scroll here as well.
                        requestAnimationFrame(() => requestAnimationFrame(() => jumpToSection('export')));
                      }}
                    >
                      {t('header.export')}
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            ) : null}
          </Group>
        }
      />

      {!isConnected ? (
        <ImportAgentShell
          opened={updateFromFileOpen}
          target={{ key: agent.key, name: agent.name }}
          onClose={() => setUpdateFromFileOpen(false)}
          onImported={() => { setUpdateFromFileOpen(false); void loadAgent(); }}
        />
      ) : null}

      <Tabs value={visibleTab} onChange={setActiveTab}>
        <Tabs.List mb="md">
          {ownedByFlow ? null : (
            <Tabs.Tab value="overview" leftSection={<IconLayoutDashboard size={14} />}>
              Overview
            </Tabs.Tab>
          )}
          <Tabs.Tab value="sessions" leftSection={<IconMessageCircle size={14} />}>
            Sessions
            {sessions.length > 0 ? <Badge size="xs" variant="light" ml={6}>{sessions.length}</Badge> : null}
            {sessions.some((item) => item.runtimeStatus === 'requires_action') ? (
              <Badge size="xs" variant="filled" color="orange" ml={4} title={t('hitl.waitingTooltip')}>
                {sessions.filter((item) => item.runtimeStatus === 'requires_action').length}
              </Badge>
            ) : null}
          </Tabs.Tab>
          <Tabs.Tab value="configure" leftSection={<IconSettings size={14} />}>
            Build
            {changedSections.size > 0 ? (
              <Tooltip label={`${changedSections.size} section${changedSections.size === 1 ? '' : 's'} changed since v${agent.publishedVersion}`} withArrow>
                <Badge size="xs" variant="light" color="orange" ml={6}>{changedSections.size}</Badge>
              </Tooltip>
            ) : null}
          </Tabs.Tab>
          {showFlowsTab ? (
            <Tabs.Tab value="flows" leftSection={isFlow ? <IconTopologyStar3 size={14} /> : <IconRoute size={14} />}>
              {flowTexts.flowsTab}
            </Tabs.Tab>
          ) : null}
          {ownedByFlow ? null : (
            <Tabs.Tab value="deploy" leftSection={<IconRocket size={14} />}>
              Ship
            </Tabs.Tab>
          )}
          {!isConnected && !ownedByFlow ? (
            <Tabs.Tab value="feedback" leftSection={<IconThumbUp size={14} />}>
              {t('tabs.feedback')}
            </Tabs.Tab>
          ) : null}
          {ownedByFlow ? null : (
            <Tabs.Tab value="usage" leftSection={<IconCode size={14} />}>
              {t('tabs.usage')}
            </Tabs.Tab>
          )}
        </Tabs.List>

        {/* ── Overview ────────────────────────────────────────── */}
        {ownedByFlow ? null : (
        <Tabs.Panel value="overview">
          <div className={classes.overviewLayout}>
          <AgentOverviewPanel
            agent={agent}
            variables={callVariables}
            variablesLoading={variablesLoading}
            isConnected={isConnected}
            sessionCount={sessions.length}
            onStartSession={() => setStartSessionOpen(true)}
            // Overview links by the OLD flat names on purpose — it should not
            // have to know how the tabs are grouped, so the alias table that
            // already exists for deep links resolves the rail for it too.
            onGoToTab={(tab) => {
              const alias = TAB_ALIASES[tab];
              if (!alias) return;
              setActiveTab(alias.top);
              if (!alias.sub) return;
              if (alias.top === 'configure') setConfigureTab(alias.sub);
              if (alias.top === 'deploy') setDeployTab(alias.sub);
              // Same target again (the state does not change): scroll here as well.
              requestAnimationFrame(() => requestAnimationFrame(() => jumpToSection(alias.sub as string)));
            }}
            unpublishedSections={changedTitles}
            brokenReferences={(agentUsage?.uses ?? []).filter((edge) => edge.status !== 'ok')}
          />
          <AgentOverviewAside
            usage={agentUsage}
            usageFailed={agentUsageFailed}
            isConnected={isConnected}
            publishedVersion={agent.publishedVersion ?? null}
            a2aEnabled={a2aEnabled}
            triggerCount={triggerCount}
            onManage={() => setActiveTab('deploy')}
          />
          </div>
        </Tabs.Panel>
        )}

        {/* ── Sessions ────────────────────────────────────────── */}
        <Tabs.Panel value="sessions">
          <SectionCard
            title="Sessions"
            description="Every conversation with this agent — console tests, API, A2A and trigger runs. Click one to inspect it; sessions started here can be continued."
          >
            {remindersViewAvailable ? (
              <SegmentedControl
                mb="md"
                size="sm"
                w="fit-content"
                value={sessionsView}
                onChange={(value) => setSessionsView(value as 'sessions' | 'reminders')}
                data={[
                  { value: 'sessions', label: `Sessions · ${sessions.length}` },
                  { value: 'reminders', label: t('reminders.viewLabel', { count: activeReminderCount }) },
                ]}
              />
            ) : null}
            {sessionsTrigger ? (
              <Group gap={6} mb="sm">
                <Badge
                  variant="light"
                  rightSection={(
                    <ActionIcon size="xs" variant="transparent" color="gray" aria-label={t('triggers.sessionsFilterClear')} onClick={() => setSessionsTrigger(null)}>
                      <IconX size={10} />
                    </ActionIcon>
                  )}
                >
                  {t('triggers.runsFilter', { name: sessionsTrigger.name })}
                </Badge>
              </Group>
            ) : null}
            {remindersViewAvailable && sessionsView === 'reminders' ? (
              <AgentRemindersTable
                agentId={agentId}
                onOpenSession={(id) => setViewedSessionId(id)}
                onActiveCountChange={setActiveReminderCount}
              />
            ) : (
              <SessionList
                agentId={agentId}
                sessions={sessions}
                ownOnly={sessionsOwnOnly}
                loading={sessionsLoading}
                onOpen={(id) => setViewedSessionId(id)}
                onContinue={(id) => openSessionPage(id)}
                onStart={() => setStartSessionOpen(true)}
                onRefresh={() => void loadSessions()}
                onRunStopped={() => void loadSessions(true)}
                refreshing={sessionsLoading}
                tracesHref={tracesHref ?? `/dashboard/tracing/sessions?agent=${encodeURIComponent(agent.name)}`}
              />
            )}
            <SessionDetailDrawer
              agentId={agentId}
              session={viewedSessionId
                ? sessions.find((s) => s._id === viewedSessionId) ?? { _id: viewedSessionId }
                : null}
              onClose={closeSession}
              onContinue={(id) => openSessionPage(id)}
              onResolved={() => void loadSessions()}
              onSessionChanged={() => void loadSessions(true)}
            />
          </SectionCard>
        </Tabs.Panel>

        {/*
          Configure — everything that changes what the agent IS, as one page.

          It used to be a vertical rail, which hid six of seven sections
          behind a click. Wrong trade for a form edited as a whole and saved
          by one button: you could not see what the agent was without touring
          it. Deep links still work — `?tab=prompt` scrolls to that section
          instead of selecting a rail item.
        */}
        <Tabs.Panel value="configure">
          <Group justify="space-between" mb="sm">
            <Text size="sm" c="dimmed">
              {isConnected || isFlow ? 1 : BUILD_SECTION_ORDER.filter((id) => !(ownedByFlow && OWNED_HIDDEN_SECTIONS.has(id))).length} sections
              {ownedByFlow
                ? ''
                : agent.publishedVersion
                  ? ` · ${changedSections.size} changed since v${agent.publishedVersion}`
                  : ' · never published'}
            </Text>
            {agent.publishedVersion && !ownedByFlow ? (
              <Button
                size="compact-sm"
                variant={onlyChanged ? 'light' : 'subtle'}
                color={onlyChanged ? 'orange' : 'gray'}
                disabled={changedSections.size === 0 && !onlyChanged}
                onClick={() => setOnlyChanged((value) => !value)}
              >
                {onlyChanged ? 'Show all sections' : 'Show only changed'}
              </Button>
            ) : null}
          </Group>
          <div className={showBuildIndex ? classes.buildLayout : undefined}>
            {showBuildIndex ? (
              <div className={classes.buildIndexColumn}>
                <BuildSectionIndex groups={buildIndexGroups} onJump={jumpToSection} />
              </div>
            ) : null}
            <Paper withBorder radius="md" p="xl" style={{ minWidth: 0 }}>
              {BUILD_SECTION_ORDER.map((id) => <Fragment key={id}>{buildSectionElements[id]}</Fragment>)}
            </Paper>
          </div>

          {/*
            One save for the whole page. Every section above edits the same
            draft config and the PATCH replaces it wholesale, so six separate
            "Save" buttons only ever meant "save everything, from here".
          */}
          {configIssues && (configIssues.errors.length > 0 || configIssues.warnings.length > 0) ? (
            <Alert
              mt="md"
              variant="light"
              color={configIssues.errors.length > 0 ? 'red' : 'yellow'}
              icon={<IconAlertTriangle size={16} />}
              title={configIssues.errors.length > 0
                ? `Not saved — ${configIssues.errors.length} problem${configIssues.errors.length === 1 ? '' : 's'} to fix`
                : 'Saved, with warnings'}
              withCloseButton
              onClose={() => setConfigIssues(null)}
            >
              <Stack gap={4}>
                {[...configIssues.errors.map((issue) => ({ ...issue, level: 'error' as const })),
                  ...configIssues.warnings.map((issue) => ({ ...issue, level: 'warning' as const }))]
                  .map((issue) => (
                    <Group key={`${issue.level}-${issue.field}-${issue.message}`} gap={6} wrap="nowrap" align="flex-start">
                      <Badge size="xs" variant="light" color={issue.level === 'error' ? 'red' : 'yellow'}>
                        {issue.level}
                      </Badge>
                      <Text size="xs" ff="monospace" c="dimmed">{issue.field}</Text>
                      <Text size="xs">{issue.message}</Text>
                    </Group>
                  ))}
              </Stack>
            </Alert>
          ) : null}
          {/* A FlowBase agent saves from its own card: the form here describes a model loop. */}
          {isFlow || readOnly ? null : (
            <Group justify="space-between" wrap="nowrap" gap="md" className={classes.configSaveBar} data-testid="build-save-bar">
              <Text
                size="sm"
                c={unsavedSections.size > 0 ? undefined : 'dimmed'}
                fw={unsavedSections.size > 0 ? 500 : undefined}
                role="status"
                aria-live="polite"
                lineClamp={2}
                data-testid="build-unsaved"
                data-count={unsavedSections.size}
              >
                {savedPayload === null
                  ? null
                  : unsavedSections.size === 0
                    ? t('build.saved')
                    : (
                      <>
                        <span className={classes.unsavedDot} aria-hidden="true">●</span>{' '}
                        {unsavedSections.size === 1 ? t('build.unsavedOne') : t('build.unsavedMany', { count: unsavedSections.size })}
                        <Text span size="sm" c="dimmed" fw={400}> · {t('build.unsavedIn', { sections: unsavedTitles.join(', ') })}</Text>
                      </>
                    )}
              </Text>
              <Group gap="xs" wrap="nowrap">
                {unsavedSections.size > 0 ? (
                  <Button variant="default" onClick={() => void discardUnsaved()} disabled={savingConfig} data-testid="build-discard">
                    {t('build.discard')}
                  </Button>
                ) : null}
                <Button onClick={handleSaveConfig} loading={savingConfig}>{t('config.save')}</Button>
              </Group>
            </Group>
          )}
        </Tabs.Panel>

        {/* ── Flows ───────────────────────────────────────────── */}
        {showFlowsTab ? (
          <Tabs.Panel value="flows">
            <AgentFlowsPanel
              agentId={String(agent._id)}
              agentKey={agent.key}
              config={agent.config}
              access={flowsPermission}
              onToolBindingsChange={handleFlowBindingsChange}
              onAgentChanged={() => void loadAgent()}
            />
          </Tabs.Panel>
        ) : null}

        {/*
          Deploy — the lifecycle of a config that is already written:
          freeze it (Versions), expose it (Publish), start it on its own
          (Triggers), or take it out of the console entirely (Export).
        */}
        {ownedByFlow ? null : (
        <Tabs.Panel value="deploy">
          {/*
            One page, like Configure — the four things you do with a config
            that is already written sit one under the other, so "is this
            published, exposed, scheduled?" is answered by scrolling, not by
            clicking through a rail. `?tab=versions` etc. scroll here.
          */}
          {/* What is live and what publishing would change, before the sections that act on it. */}
          {!isConnected ? (
            <Paper withBorder radius="md" p="md" mb="md" data-testid="ship-summary">
              <Group justify="space-between" wrap="wrap" gap="md">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Group gap={8}>
                    <Text fw={600}>
                      {agent.publishedVersion ? t('ship.published', { version: agent.publishedVersion }) : t('ship.neverPublished')}
                    </Text>
                    {publishedVersionRecord ? (
                      <Text size="sm" c="dimmed">
                        {new Date(publishedVersionRecord.createdAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}
                      </Text>
                    ) : null}
                  </Group>
                  <Text size="sm" c={agent.publishedVersion && changedSections.size > 0 ? 'orange.8' : 'dimmed'}>
                    {!agent.publishedVersion
                      ? t('ship.firstPublishHint')
                      : changedSections.size === 0
                        ? t('ship.draftSame')
                        : changedSections.size === 1
                          ? t('ship.draftChangedOne', { sections: changedTitles.join(', ') })
                          : t('ship.draftChangedMany', { count: changedSections.size, sections: changedTitles.join(', ') })}
                  </Text>
                </Stack>
                <Group gap="xs" wrap="wrap">
                  {splitAgentUsedBy(agentUsage?.usedBy ?? []).surfaces.map((edge, index) => (
                    <span key={`${edge.other.type}:${edge.other.id ?? index}`} className="ds-badge">
                      {edge.other.name ?? edge.other.key}
                    </span>
                  ))}
                  {triggerCount ? (
                    <span className="ds-badge">
                      {triggerCount === 1 ? t('overview.triggersOne') : t('overview.triggersMany', { count: triggerCount })}
                    </span>
                  ) : null}
                  <span className="ds-badge">{a2aEnabled ? t('overview.a2aOn') : t('overview.a2aOff')}</span>
                  {!isFlow && (agent.latestVersion ?? 0) > 0 ? (
                    <Button size="xs" variant="default" leftSection={<IconArrowsLeftRight size={14} />} onClick={() => setCompareOpen(true)}>
                      {t('header.compare')}
                    </Button>
                  ) : null}
                  <Button size="xs" leftSection={<IconRocket size={14} />} onClick={() => setPublishModalOpen(true)}>
                    {t('publish.button')}
                  </Button>
                </Group>
              </Group>
            </Paper>
          ) : null}
          <Paper withBorder radius="md" p="xl">
            {!isConnected ? (
            <ConfigSection first id="versions" title={t('versions.title')} description={t('versions.description')}>
              <Stack gap="md">
                <Group justify="flex-end" align="center">
                  <Group gap="xs">
                    {compareVersionA || compareVersionB ? (
                      <Text size="xs" c="dimmed" data-testid="versions-compare-selection">
                        {t('versions.selected', {
                          versions: [compareVersionA, compareVersionB].filter(Boolean).map((v) => `v${v}`).join(' ↔ '),
                        })}
                      </Text>
                    ) : null}
                    <Badge size="sm" variant="light">{versionsTotal} total</Badge>
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconArrowsExchange size={14} />}
                      disabled={!compareVersionA || !compareVersionB || compareVersionA === compareVersionB}
                      onClick={() => setCompareModalOpen(true)}
                    >
                      {t('versions.compare')}
                    </Button>
                  </Group>
                </Group>

                {versionsLoading ? (
                  <LoadingState label="Loading versions..." minHeight={200} />
                ) : versions.length === 0 ? (
                  <EmptyState
                    title={t('versions.noVersions')}
                    description={t('versions.noVersionsDesc')}
                    icon={<IconGitBranch size={24} />}
                    minHeight={220}
                  />
                ) : (
                  <DataGrid<AgentVersion>
                    records={versions.slice((shownVersionsPage - 1) * VERSIONS_PAGE_SIZE, shownVersionsPage * VERSIONS_PAGE_SIZE)}
                    rowKey={(v) => String(v.version)}
                    footerLeft={
                      versions.length > VERSIONS_PAGE_SIZE
                        ? t('versions.showing', {
                          from: (shownVersionsPage - 1) * VERSIONS_PAGE_SIZE + 1,
                          to: Math.min(shownVersionsPage * VERSIONS_PAGE_SIZE, versions.length),
                          total: versions.length,
                        })
                        : undefined
                    }
                    pagination={
                      versions.length > VERSIONS_PAGE_SIZE
                        ? {
                          page: shownVersionsPage,
                          onPageChange: setVersionsPage,
                          pageSize: VERSIONS_PAGE_SIZE,
                          total: versions.length,
                          hasMore: shownVersionsPage < versionPageCount,
                        }
                        : undefined
                    }
                    columns={[
                      {
                        key: 'select',
                        label: <VisuallyHidden>Select version</VisuallyHidden>,
                        width: 40,
                        render: (v) => {
                          const isSelected = compareVersionA === String(v.version) || compareVersionB === String(v.version);
                          return (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {
                                const vStr = String(v.version);
                                if (isSelected) {
                                  if (compareVersionA === vStr) setCompareVersionA(null);
                                  if (compareVersionB === vStr) setCompareVersionB(null);
                                } else {
                                  if (!compareVersionA) setCompareVersionA(vStr);
                                  else if (!compareVersionB) setCompareVersionB(vStr);
                                  else {
                                    setCompareVersionA(compareVersionB);
                                    setCompareVersionB(vStr);
                                  }
                                }
                              }}
                            />
                          );
                        },
                      },
                      {
                        key: 'version',
                        label: t('versions.version'),
                        render: (v) => (
                          <Group gap="xs">
                            <Badge size="sm" variant="filled" color="blue">v{v.version}</Badge>
                            {agent.publishedVersion === v.version && (
                              <Badge size="xs" variant="light" color="teal">{t('versions.current')}</Badge>
                            )}
                          </Group>
                        ),
                      },
                      {
                        key: 'changelog',
                        label: t('versions.changelog'),
                        render: (v) => (
                          <Text size="sm" lineClamp={1}>
                            {v.changelog || <Text span c="dimmed" fs="italic" size="sm">{t('versions.noChangelog')}</Text>}
                          </Text>
                        ),
                      },
                      {
                        key: 'publishedAt',
                        label: t('versions.publishedAt'),
                        render: (v) => (
                          <Text size="sm">
                            {v.createdAt ? new Date(v.createdAt).toLocaleString() : '—'}
                          </Text>
                        ),
                      },
                      {
                        key: 'actions',
                        label: '',
                        align: 'right',
                        render: (v) => (
                          <Tooltip label={t('versions.snapshot')}>
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              onClick={() => {
                                setCompareVersionA(String(v.version));
                                setCompareVersionB(null);
                                setCompareModalOpen(true);
                              }}
                            >
                              <IconCode size={14} />
                            </ActionIcon>
                          </Tooltip>
                        ),
                      },
                    ]}
                  />
                )}
              </Stack>
            </ConfigSection>
            ) : null}

            <ConfigSection first={isConnected} id="publish" title={t('a2a.title')} description={t('a2a.description')}>
              <Stack gap="md">

                <Switch
                  label={t('a2a.toggle')}
                  checked={a2aEnabled}
                  disabled={a2aSaving}
                  onChange={(event) => updateA2a({ enabled: event.currentTarget.checked })}
                />

                {a2aEnabled && (
                  <>
                    <Divider />

                    <div>
                      <Text size="sm" fw={600} mb={6}>{t('a2a.accessMode')}</Text>
                      <SegmentedControl
                        value={a2aAccessMode}
                        disabled={a2aSaving}
                        onChange={(value) =>
                          updateA2a({ accessMode: value === 'public' ? 'public' : 'token' })
                        }
                        data={[
                          { value: 'token', label: t('a2a.accessToken') },
                          { value: 'public', label: t('a2a.accessPublic') },
                        ]}
                      />
                      <Text size="xs" c="dimmed" mt={6}>
                        {a2aAccessMode === 'public'
                          ? t('a2a.accessPublicDesc')
                          : t('a2a.accessTokenDesc')}
                      </Text>
                    </div>

                    {a2aIsPublic && (
                      <Alert
                        color="yellow"
                        variant="light"
                        icon={<IconAlertTriangle size={16} />}
                      >
                        {t('a2a.publicWarning')}
                      </Alert>
                    )}

                    <Text size="sm" c="dimmed">{t('a2a.cardLabel')}</Text>
                    <CopyableCode value={a2aCardUrl} />

                    <Text size="sm" c="dimmed">{t('a2a.endpointLabel')}</Text>
                    <CopyableCode value={a2aEndpointUrl} />

                    {/* The example carries the variables of the version a call runs: it waits until they are known. */}
                    {!variablesLoading && (
                      <>
                        <Text size="sm" c="dimmed">{t('a2a.exampleLabel')}</Text>
                        <Code block>
                          {a2aSendCurl({ endpointUrl: a2aEndpointUrl, isPublic: a2aIsPublic, variables: sampleVariables(callVariables) })}
                        </Code>
                      </>
                    )}
                  </>
                )}
              </Stack>
            </ConfigSection>

            {!isConnected ? (
              <ConfigSection
                id="triggers"
                title={t('triggers.sectionTitle')}
                description={t('triggers.sectionDescription')}
              >
                <AgentTriggersPanel
                  agentId={agentId}
                  agentName={agent.name}
                  declaredVariables={agent.config?.variables}
                  versions={versions.map((version) => version.version)}
                  onShowRuns={(trigger) => {
                    setSessionsTrigger(trigger);
                    setSessionsView('sessions');
                    setActiveTab('sessions');
                  }}
                />
              </ConfigSection>
            ) : null}

            {!isConnected ? (
              <EnterpriseAgentShipSections agentKey={agent.key} projectId={agent.projectId ? String(agent.projectId) : ''} agentName={agent.name} />
            ) : null}

            <ConfigSection
              id="export"
              title="Export"
              description="Take the agent out of the console — a manifest to re-import elsewhere, or a runnable agent-sdk project."
            >
              <AgentExportPanel
                agentId={agentId}
                agentKey={agent.key}
                versions={versions.map((version) => ({ version: version.version }))}
                publishedVersion={agent.publishedVersion ?? null}
                onImported={() => void loadAgent()}
              />
            </ConfigSection>
          </Paper>
        </Tabs.Panel>
        )}

        {/*
          Usage — how to call this agent from outside the console. Its own
          tab because it is what someone integrating the agent opens first,
          and it had been buried as the second item of Observe's rail.
        */}
        {/* ── Feedback ────────────────────────────────────────── */}
        <Tabs.Panel value="feedback">
          {activeTab === 'feedback' && !ownedByFlow ? <AgentFeedbackPanel agentId={agentId} /> : null}
        </Tabs.Panel>

        {/* ── Usage ───────────────────────────────────────────── */}
        <Tabs.Panel value="usage">
          {activeTab === 'usage' && !ownedByFlow ? (
            <AgentUsagePanel
              agentName={agent.name}
              agentKey={agent.key}
              publishedVersion={agent.publishedVersion}
              variables={callVariables}
              variablesLoading={variablesLoading}
              origin={origin}
              a2aEnabled={a2aEnabled}
              a2aEndpointUrl={a2aEndpointUrl}
              a2aIsPublic={a2aIsPublic}
            />
          ) : null}
        </Tabs.Panel>
      </Tabs>

      {/* ── Publish Modal ──────────────────────────────────────── */}
      <Modal
        opened={publishModalOpen && !ownedByFlow}
        onClose={() => setPublishModalOpen(false)}
        title={t('publish.modalTitle')}
        size="md"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {t('publish.modalDescription')}
          </Text>
          <Textarea
            label={t('publish.changelog')}
            placeholder={t('publish.changelogPlaceholder')}
            minRows={3}
            maxRows={6}
            autosize
            value={publishChangelog}
            onChange={(e) => setPublishChangelog(e.target.value)}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setPublishModalOpen(false)}>
              {t('publish.cancel')}
            </Button>
            <Button
              leftSection={<IconRocket size={14} />}
              onClick={handlePublish}
              loading={publishing}
            >
              {t('publish.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* ── Compare Modal ──────────────────────────────────────── */}
      <Modal
        opened={compareModalOpen}
        onClose={() => setCompareModalOpen(false)}
        title={t('versions.compareTitle')}
        size="xl"
      >
        <VersionCompareView
          versions={versions}
          versionA={compareVersionA ? parseInt(compareVersionA, 10) : null}
          versionB={compareVersionB ? parseInt(compareVersionB, 10) : null}
          t={t}
        />
      </Modal>

      <CompareVersionsDrawer
        opened={compareOpen && !ownedByFlow}
        onClose={() => setCompareOpen(false)}
        agentId={agentId}
        publishedVersion={agent.publishedVersion ?? null}
        versions={Array.from({ length: agent.latestVersion ?? 0 }, (_, index) => (agent.latestVersion ?? 0) - index)}
        changedSections={[...changedSections].map((id) => configSectionTitle(id, t))}
      />
      <StartSessionModal
        opened={startSessionOpen}
        onClose={() => setStartSessionOpen(false)}
        agentId={agentId}
        agentName={agent.name}
        versions={versions}
        publishedVersion={agent.publishedVersion ?? null}
        isConnected={isConnected}
        onStarted={handleSessionStarted}
      />

      {isConnected ? (
        <ConnectAgentModal
          opened={editConnectionOpen}
          onClose={() => setEditConnectionOpen(false)}
          providers={providers.map((p) => ({ key: p.key, label: p.label || p.name || p.key }))}
          editAgent={agent}
          onCreated={() => {
            setEditConnectionOpen(false);
            void loadAgent();
          }}
        />
      ) : null}
    </PageContainer>
  );
}

// ── Version Compare Component ───────────────────────────────────────

function VersionCompareView({
  versions,
  versionA,
  versionB,
  t,
}: {
  versions: AgentVersion[];
  versionA: number | null;
  versionB: number | null;
  t: (key: string) => string;
}) {
  const a = versions.find((v) => v.version === versionA);
  const b = versions.find((v) => v.version === versionB);

  if (!a && !b) {
    return (
      <EmptyState title={t('versions.selectVersions')} minHeight={200} />
    );
  }

  // Single version view (snapshot)
  if (a && !b) {
    return (
      <Stack gap="md">
        <Group gap="xs">
          <Badge size="sm" variant="filled" color="blue">v{a.version}</Badge>
          {a.changelog && <Text size="sm" c="dimmed">{a.changelog}</Text>}
        </Group>
        <Code block className={classes.snapshotCode}>
          {JSON.stringify(a.snapshot, null, 2)}
        </Code>
      </Stack>
    );
  }

  // Comparison view
  if (a && b) {
    const diffs = computeJsonDiff(a.snapshot, b.snapshot);

    if (diffs.length === 0) {
      return (
        <EmptyState title={t('versions.noDifferences')} minHeight={200} />
      );
    }

    return (
      <Stack gap="md">
        <Group gap="md">
          <Badge size="sm" variant="filled" color="blue">v{a.version}</Badge>
          <Text size="sm" c="dimmed">vs</Text>
          <Badge size="sm" variant="filled" color="blue">v{b.version}</Badge>
        </Group>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('versions.field')}</Table.Th>
              <Table.Th>v{a.version}</Table.Th>
              <Table.Th>v{b.version}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {diffs.map((diff) => (
              <Table.Tr key={diff.path}>
                <Table.Td>
                  <Text size="sm" fw={500}>{diff.path}</Text>
                </Table.Td>
                <Table.Td>
                  <Code className={classes.diffCode}>
                    {diff.oldValue !== undefined ? JSON.stringify(diff.oldValue, null, 2) : '—'}
                  </Code>
                </Table.Td>
                <Table.Td>
                  <Code className={classes.diffCode}>
                    {diff.newValue !== undefined ? JSON.stringify(diff.newValue, null, 2) : '—'}
                  </Code>
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="xs"
                    variant="light"
                    color={diff.type === 'added' ? 'green' : diff.type === 'removed' ? 'red' : 'yellow'}
                  >
                    {t(`versions.${diff.type}`)}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    );
  }

  return null;
}

// ── JSON diff utility ───────────────────────────────────────────────

interface DiffEntry {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: unknown;
  newValue?: unknown;
}

function computeJsonDiff(
  objA: Record<string, unknown>,
  objB: Record<string, unknown>,
  prefix = '',
): DiffEntry[] {
  const diffs: DiffEntry[] = [];
  const allKeys = new Set([...Object.keys(objA), ...Object.keys(objB)]);

  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const valA = (objA as Record<string, unknown>)[key];
    const valB = (objB as Record<string, unknown>)[key];

    if (!(key in objA)) {
      diffs.push({ path, type: 'added', newValue: valB });
    } else if (!(key in objB)) {
      diffs.push({ path, type: 'removed', oldValue: valA });
    } else if (
      typeof valA === 'object' && valA !== null &&
      typeof valB === 'object' && valB !== null &&
      !Array.isArray(valA) && !Array.isArray(valB)
    ) {
      diffs.push(...computeJsonDiff(
        valA as Record<string, unknown>,
        valB as Record<string, unknown>,
        path,
      ));
    } else if (JSON.stringify(valA) !== JSON.stringify(valB)) {
      diffs.push({ path, type: 'changed', oldValue: valA, newValue: valB });
    }
  }

  return diffs;
}
