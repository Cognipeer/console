'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
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
  CopyButton,
  Tooltip,
  Box,
  Pagination,
  Modal,
  Table,
  VisuallyHidden,
  Switch,
  SegmentedControl,
  Alert,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { DatePickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import {
  IconMessageCircle,
  IconTimeline,
  IconCode,
  IconCopy,
  IconCheck,
  IconCalendar,
  IconRefresh,
  IconSettings,
  IconDatabase,
  IconShield,
  IconTool,
  IconRocket,
  IconGitBranch,
  IconArrowsExchange,
  IconPlugConnected,
  IconPencil,
  IconAlertTriangle,
  IconLayoutDashboard,
  IconPlus,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import EmptyState from '@/components/common/EmptyState';
import GuardrailBindingList, {
  bindingRowsFromStored,
  type GuardrailBindingOption,
  type GuardrailBindingRow,
} from '@/components/guardrails/GuardrailBindingList';
import type { HookId } from '@/lib/services/guardrail/hooks/contract';
import LoadingState from '@/components/common/LoadingState';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import SectionCard from '@/components/common/SectionCard';
import SessionTable from '@/components/tracing/SessionTable';
import { ToolSelectorModal, type ToolBinding } from './ToolSelectorModal';
import ConnectAgentModal from './ConnectAgentModal';
import AgentAdvancedSettings, { countAdvancedOverrides } from './studio/AgentAdvancedSettings';
import AgentStructuredOutputEditor from './studio/AgentStructuredOutputEditor';
import AgentSubagentsPanel from './studio/AgentSubagentsPanel';
import AgentExportPanel from './studio/AgentExportPanel';
import AgentPromptPanel from './studio/AgentPromptPanel';
import AgentOverviewPanel from './studio/AgentOverviewPanel';
import SessionList from './studio/SessionList';
import StartSessionModal from './studio/StartSessionModal';
import AgentSchedulesPanel from './studio/AgentSchedulesPanel';
import AgentSkillsPanel from './studio/AgentSkillsPanel';
import AgentMemoryPanel, { type MemoryStoreOption } from './studio/AgentMemoryPanel';
import AgentSandboxPanel from './studio/AgentSandboxPanel';
import ConfigSection, { ConfigBlock } from './studio/ConfigSection';
import type { SkillView } from '@/components/skills/types';
import type {
  IAgentMemoryConfig,
  IAgentSandboxConfig,
  IAgentRuntimeConfig,
  IAgentSkillPolicy,
  IAgentStructuredOutput,
  IAgentSubagent,
  IAgentSubagentPolicy,
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
  name: string;
  description?: string;
  config: {
    modelKey?: string;
    systemPrompt?: string;
    promptKey?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    knowledgeEngineKey?: string;
    /** Multi-guardrail binding. Authoritative when present — the two slots
     *  below are then derived from it, not read. */
    guardrails?: Array<{ key: string; hooks?: HookId[] }>;
    /** @deprecated Read only as the fallback when `guardrails` is absent. */
    inputGuardrailKey?: string;
    /** @deprecated See `inputGuardrailKey`. */
    outputGuardrailKey?: string;
    toolBindings?: ToolBinding[];
    promptVariables?: Record<string, string>;
    runtime?: IAgentRuntimeConfig;
    structuredOutput?: IAgentStructuredOutput;
    subagents?: IAgentSubagent[];
    subagentPolicy?: IAgentSubagentPolicy;
    kind?: 'native' | 'external';
    connection?: {
      protocol?: string;
      url?: string;
      model?: string;
      responsePath?: string;
      credentialProviderKey?: string;
      hasApiKey?: boolean;
      headers?: Record<string, string>;
    };
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

/** A row in the Sessions list / Overview's "recent sessions" — see AgentSessionView for the full record. */
/** Mirrors `summariseConversation` on the sessions list route. */
interface SessionSummary {
  _id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costComplete?: boolean;
  activeMs?: number;
  hasContext?: boolean;
}

interface Model {
  _id: string;
  key: string;
  name: string;
  modelId: string;
  category: string;
}

interface Prompt {
  _id: string;
  key: string;
  name: string;
  description?: string;
  template: string;
}

interface RagModule {
  _id: string;
  key: string;
  name: string;
  status: string;
}

/**
 * `GuardrailBindingOption` is the shape the binding list needs — including the
 * `hooks` config, which is what decides whether a hook checkbox is available.
 * Extended rather than redeclared so the two cannot drift.
 */
interface Guardrail extends GuardrailBindingOption {
  _id: string;
  target?: string;
}

interface TracingSessionRecord {
  sessionId: string;
  threadId?: string;
  agentName?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totalEvents?: number;
  totalTokens?: number;
}

const DEFAULT_PAGE_SIZE = 25;

/**
 * The legacy single slots, rendered as the equivalent binding list.
 *
 * The output slot seeds `output.pre` ONLY. `resolveBindings` also projects the
 * legacy key onto `output.stream.delta`, but a guardrail written before the
 * hook plane declares no streaming binding, so the stream gate evaluates
 * nothing for it today — seeding that hook would show a ticked box that does
 * nothing and the API would reject it. The checkbox unlocks itself the moment
 * the guardrail enables streaming.
 */
function seedGuardrailsFromLegacySlots(
  inputKey: string | undefined,
  outputKey: string | undefined,
): GuardrailBindingRow[] {
  // Materialised rows: a legacy slot names ONE direction, so "wherever the
  // guardrail declares" (an absent `hooks`) is not what it meant — the
  // conversion has to be the exact equivalent of the two slots.
  const rows: Array<Required<GuardrailBindingRow>> = [];
  const bind = (key: string | undefined, hook: HookId) => {
    if (!key) return;
    const existing = rows.find((row) => row.key === key);
    if (existing) {
      if (!existing.hooks.includes(hook)) existing.hooks.push(hook);
      return;
    }
    rows.push({ key, hooks: [hook] });
  };
  bind(inputKey || undefined, 'input.pre');
  bind(outputKey || undefined, 'output.pre');
  return rows;
}

/**
 * Deep-link compatibility for `?tab=`.
 *
 * The page used to have thirteen flat tabs; they are now six, and Configure
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
  settings: { top: 'configure', sub: 'basic' },
  basic: { top: 'configure', sub: 'basic' },
  prompt: { top: 'configure', sub: 'prompt' },
  subagents: { top: 'configure', sub: 'subagents' },
  skills: { top: 'configure', sub: 'skills' },
  memory: { top: 'configure', sub: 'memory' },
  sandbox: { top: 'configure', sub: 'sandbox' },
  advanced: { top: 'configure', sub: 'advanced' },
  output: { top: 'configure', sub: 'output' },
  deploy: { top: 'deploy' },
  versions: { top: 'deploy', sub: 'versions' },
  publish: { top: 'deploy', sub: 'publish' },
  schedules: { top: 'deploy', sub: 'schedules' },
  export: { top: 'deploy', sub: 'export' },
  observe: { top: 'observe' },
  traces: { top: 'observe' },
  usage: { top: 'usage' },
  api: { top: 'usage' },
};

function resolveTabFromQuery(raw: string | null): string {
  return TAB_ALIASES[raw ?? '']?.top ?? 'overview';
}

/** The sub-tab a deep link asks for, or the group's default. */
function resolveSubTabFromQuery(raw: string | null, group: string, fallback: string): string {
  const alias = TAB_ALIASES[raw ?? ''];
  return alias?.top === group && alias.sub ? alias.sub : fallback;
}

export default function AgentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const agentId = params.agentId as string;
  const t = useTranslations('agents');

  const [agent, setAgent] = useState<Agent | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [ragModules, setRagModules] = useState<RagModule[]>([]);
  const [guardrails, setGuardrails] = useState<Guardrail[]>([]);
  const [providers, setProviders] = useState<Array<{ key: string; label?: string; name?: string }>>([]);
  const [editConnectionOpen, setEditConnectionOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  // Overview is the landing tab — it's the one screen that answers "is this
  // agent healthy and what has it been doing", which is a better first thing
  // to see than a blank chat box. A deep link (Sessions' "back to agent",
  // a bookmark) can still land on any tab via `?tab=`.
  const [activeTab, setActiveTab] = useState<string | null>(() => resolveTabFromQuery(searchParams.get('tab')));
  // Configure has no rail any more, so this is no longer "which pane is
  // showing" — it is "which section a deep link asked for", and the effect
  // below scrolls to it.
  const [configureTab, setConfigureTab] = useState<string | null>(
    () => resolveSubTabFromQuery(searchParams.get('tab'), 'configure', 'basic'),
  );
  const [deployTab, setDeployTab] = useState<string | null>(
    () => resolveSubTabFromQuery(searchParams.get('tab'), 'deploy', 'versions'),
  );

  const [toolSelectorOpen, setToolSelectorOpen] = useState(false);
  const [toolBindings, setToolBindings] = useState<ToolBinding[]>([]);

  // Advanced runtime knobs, structured output and the delegation roster. These
  // live outside `configForm` for the same reason the guardrail bindings do:
  // they are nested objects and lists, and `getInputProps` has nothing to offer
  // them. Absent stays absent — an untouched agent must serialize the same
  // config it had before these sections existed.
  const [runtimeConfig, setRuntimeConfig] = useState<IAgentRuntimeConfig>({});
  const [structuredOutput, setStructuredOutput] = useState<IAgentStructuredOutput | undefined>(undefined);
  const [subagents, setSubagents] = useState<IAgentSubagent[]>([]);
  const [subagentPolicy, setSubagentPolicy] = useState<IAgentSubagentPolicy | undefined>(undefined);
  /** Other agents in the project — the `ref` sub-agent picker's options. */
  const [projectAgents, setProjectAgents] = useState<Array<{ key: string; name: string; publishedVersion?: number | null }>>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillPolicy, setSkillPolicy] = useState<IAgentSkillPolicy | undefined>(undefined);
  const [skillLibrary, setSkillLibrary] = useState<SkillView[]>([]);
  const [memoryConfig, setMemoryConfig] = useState<IAgentMemoryConfig | undefined>(undefined);
  const [sandboxConfig, setSandboxConfig] = useState<IAgentSandboxConfig | undefined>(undefined);
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
  const [compareModalOpen, setCompareModalOpen] = useState(false);

  // Sessions list (for the Sessions tab — the actual chat now lives at its
  // own route, see AgentSessionView).
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [startSessionOpen, setStartSessionOpen] = useState(false);
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
      knowledgeEngineKey: '',
      inputGuardrailKey: '',
      outputGuardrailKey: '',
    },
  });

  // Tracing state (with pagination & date filter)
  const [tracingSessions, setTracingSessions] = useState<TracingSessionRecord[]>([]);
  const [tracingTotal, setTracingTotal] = useState(0);
  const [tracingLoading, setTracingLoading] = useState(false);
  const [tracingRefreshing, setTracingRefreshing] = useState(false);
  const [tracingPage, setTracingPage] = useState(1);
  const [tracingPageSize, setTracingPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [tracingStatusFilter, setTracingStatusFilter] = useState<string | null>(null);
  const [tracingDateRange, setTracingDateRange] = useState<[Date | null, Date | null]>([null, null]);

  /** Badge on the Settings tab: how far this agent strays from the defaults. */
  const advancedOverrideCount = useMemo(() => countAdvancedOverrides(runtimeConfig), [runtimeConfig]);


  const tracingPagination = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(tracingTotal / tracingPageSize));
    return { totalPages };
  }, [tracingTotal, tracingPageSize]);

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
          knowledgeEngineKey: cfg.knowledgeEngineKey || '',
          inputGuardrailKey: cfg.inputGuardrailKey || '',
          outputGuardrailKey: cfg.outputGuardrailKey || '',
        });
        setToolBindings(cfg.toolBindings ?? []);
        setRuntimeConfig(cfg.runtime ?? {});
        setStructuredOutput(cfg.structuredOutput);
        setSubagents(cfg.subagents ?? []);
        setSubagentPolicy(cfg.subagentPolicy);
        setSkills(cfg.skills ?? []);
        setSkillPolicy(cfg.skillPolicy);
        setMemoryConfig(cfg.memory);
        setSandboxConfig(cfg.sandbox);

        // An array — even an empty one — means the operator has already moved
        // to the list, and "bound to nothing" is a real decision, so it must not
        // fall back to the legacy slots.
        if (Array.isArray(cfg.guardrails)) {
          // Shared mapping: an absent `hooks` means "wherever the guardrail
          // declares it runs" and must stay absent, or the binding is silently
          // parked the next time this config is saved for any reason, while the
          // row still renders as attached.
          setGuardrailBindings(
            bindingRowsFromStored(cfg.guardrails as Array<{ key: string; hooks?: HookId[] }>),
          );
        } else {
          const seeded = seedGuardrailsFromLegacySlots(
            cfg.inputGuardrailKey,
            cfg.outputGuardrailKey,
          );
          setGuardrailBindings(seeded);
        }
      }
    } catch (err) {
      console.error('Failed to load agent', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const loadModels = async () => {
    try {
      const res = await fetch('/api/models?category=llm', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setModels(data.models ?? []);
      }
    } catch (err) {
      console.error('Failed to load models', err);
    }
  };

  const loadPrompts = async () => {
    try {
      const res = await fetch('/api/prompts', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setPrompts(data.prompts ?? []);
      }
    } catch (err) {
      console.error('Failed to load prompts', err);
    }
  };

  const loadRagModules = async () => {
    try {
      const res = await fetch('/api/rag/modules?status=active', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setRagModules(data.modules ?? []);
      }
    } catch (err) {
      console.error('Failed to load RAG modules', err);
    }
  };

  const loadProjectAgents = async () => {
    try {
      // Native agents only: a connected agent is an HTTP endpoint, and the
      // runtime refuses to flatten one into a sub-agent, so offering it here
      // would only produce a binding that silently drops at run time.
      const res = await fetch('/api/agents', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setProjectAgents(
          (data.agents ?? [])
            .filter((entry: Agent) => entry.config?.kind !== 'external')
            .map((entry: Agent) => ({
              key: entry.key,
              name: entry.name,
              publishedVersion: entry.publishedVersion ?? null,
            })),
        );
      }
    } catch (err) {
      console.error('Failed to load project agents', err);
    }
  };

  const loadSkillLibrary = async () => {
    try {
      const res = await fetch('/api/skills', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setSkillLibrary(data.skills ?? []);
      }
    } catch (err) {
      console.error('Failed to load skill library', err);
    }
  };

  const loadMemoryStores = async () => {
    try {
      const res = await fetch('/api/memory/stores', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setMemoryStores(
          (data.stores ?? []).map((s: { key: string; name: string; status: string }) => ({
            key: s.key,
            name: s.name,
            status: s.status,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load memory stores', err);
    }
  };

  const loadGuardrails = async () => {
    try {
      // Unfiltered on purpose: a guardrail disabled AFTER it was bound must
      // still render as a (badged) row in the binding list, which keeps
      // disabled ones out of its picker instead.
      const res = await fetch('/api/guardrails', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setGuardrails(data.guardrails ?? []);
      }
    } catch (err) {
      console.error('Failed to load guardrails', err);
    }
  };

  const loadProviders = async () => {
    try {
      const res = await fetch('/api/providers?scope=tenant', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers ?? []);
      }
    } catch (err) {
      console.error('Failed to load providers', err);
    }
  };

  const loadTracingSessions = useCallback(async (isRefresh = false) => {
    if (!agent) return;
    if (isRefresh) setTracingRefreshing(true);
    else setTracingLoading(true);

    try {
      const params = new URLSearchParams();
      params.set('agent', agent.name);
      params.set('limit', tracingPageSize.toString());
      params.set('skip', ((tracingPage - 1) * tracingPageSize).toString());
      if (tracingStatusFilter) params.set('status', tracingStatusFilter);
      const [from, to] = tracingDateRange;
      if (from) params.set('from', from.toISOString());
      if (to) params.set('to', to.toISOString());

      const res = await fetch(`/api/tracing/sessions?${params.toString()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        setTracingSessions(data.sessions ?? []);
        setTracingTotal(data.total ?? 0);
      }
    } catch (err) {
      console.error('Failed to load tracing sessions', err);
    } finally {
      setTracingLoading(false);
      setTracingRefreshing(false);
    }
  }, [agent, tracingPage, tracingPageSize, tracingStatusFilter, tracingDateRange]);

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
      }
    } catch (err) {
      console.error('Failed to load versions', err);
    } finally {
      setVersionsLoading(false);
    }
  }, [agent, agentId]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/sessions`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions ?? []);
      }
    } catch (err) {
      console.error('Failed to load sessions', err);
    } finally {
      setSessionsLoading(false);
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
  const handleSessionStarted = (sessionId: string, pinnedVersion: string) => {
    const query = pinnedVersion ? `?version=${encodeURIComponent(pinnedVersion)}` : '';
    router.push(`/dashboard/agents/${agentId}/sessions/${sessionId}${query}`);
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
        loadModels(),
        loadPrompts(),
        loadRagModules(),
        loadGuardrails(),
        loadProviders(),
        loadProjectAgents(),
        loadSkillLibrary(),
        loadMemoryStores(),
      ]);
      setLoading(false);
    })();
  }, [loadAgent]);

  useEffect(() => {
    if (activeTab === 'observe' && agent) {
      loadTracingSessions();
    }
  }, [activeTab, agent, loadTracingSessions]);

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
    const frame = requestAnimationFrame(() => {
      document.getElementById(`config-${section}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, configureTab, deployTab, agent]);

  const buildConfigPayload = (bindings: ToolBinding[] = toolBindings): Record<string, unknown> => {
    const values = configForm.values;
    const nextConfig: Record<string, unknown> = {
      modelKey: values.modelKey,
      // No temperature / maxTokens. The form used to send 0.7 and 4096 on
      // every save, so every agent was silently capped at 4096 output tokens
      // and pinned to a temperature — settings nobody chose and, once the
      // fields were removed, nobody could see. Leaving them out lets the
      // model record's own settings govern; the next save clears any value
      // an older save wrote. topP went the same way.
      knowledgeEngineKey: values.knowledgeEngineKey || undefined,
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
    nextConfig.subagents = subagents.length > 0 ? subagents : undefined;
    nextConfig.subagentPolicy = subagents.length > 0 ? subagentPolicy : undefined;
    nextConfig.skills = skills.length > 0 ? skills : undefined;
    nextConfig.skillPolicy = skills.length > 0 ? skillPolicy : undefined;
    nextConfig.memory = memoryConfig?.enabled || memoryConfig?.memoryStoreKey ? memoryConfig : undefined;
    // Kept even when disabled, so turning the sandbox off does not throw away
    // the template, limits and secrets someone set up. Secrets come back from
    // the server masked; sending the mask back keeps the stored value.
    nextConfig.sandbox = sandboxConfig && Object.keys(sandboxConfig).length > 0 ? sandboxConfig : undefined;
    // No editor writes this from here anymore (see the Prompt tab) — pass
    // through whatever is already stored so a save from THIS page can never
    // silently wipe a value an import or the API set, since `config` replaces
    // the stored object wholesale rather than merging.
    nextConfig.promptVariables = agent?.config?.promptVariables;

    if (values.promptMode === 'custom') {
      nextConfig.systemPrompt = values.systemPrompt;
      nextConfig.promptKey = undefined;
    } else {
      nextConfig.promptKey = values.promptKey;
      nextConfig.systemPrompt = undefined;
    }

    return nextConfig;
  };

  const saveAgentConfig = async (
    options: { notify?: boolean; bindings?: ToolBinding[] } = {},
  ): Promise<boolean> => {
    const notify = options.notify ?? true;

    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: buildConfigPayload(options.bindings) }),
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
  const apiOrigin = origin;

  /**
   * The Basic settings pane. Extracted from the playground so settings and
   * the conversation no longer share a cramped two-column row: the playground
   * is now full width, and this renders under Settings → Basic.
   */
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
            {connection?.hasApiKey
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
    ) : (
      <Stack gap="xl">
        <Select
          label={t('config.model')}
          placeholder={t('config.modelPlaceholder')}
          data={models.map((m) => ({
            value: m.key,
            label: `${m.name} (${m.modelId})`,
          }))}
          searchable
          {...configForm.getInputProps('modelKey')}
        />

        {/* Prompt configuration (mode / template / managed prompt) lives in
            its own "Prompt" section — see AgentPromptPanel. Editing the prompt
            is common and deep enough (switching modes, editing the managed
            Prompt record's template inline) to earn its own block instead of
            sharing this one with the model picker. */}

        <ConfigBlock icon={<IconDatabase size={15} />} title={t('config.knowledgeEngine')}>
          <Select
            description={t('config.knowledgeEngineDescription')}
            placeholder={t('config.knowledgeEnginePlaceholder')}
            data={ragModules.map((r) => ({ value: r.key, label: r.name }))}
            searchable
            clearable
            leftSection={<IconDatabase size={14} />}
            {...configForm.getInputProps('knowledgeEngineKey')}
          />
        </ConfigBlock>

        <ConfigBlock icon={<IconShield size={15} />} title={t('config.guardrails')}>
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

        <ConfigBlock icon={<IconTool size={15} />} title={t('config.tools')}>
          <Stack gap="sm">
            <Text size="xs" c="dimmed">{t('config.toolsDescription')}</Text>

            {toolBindings.length > 0 ? (
              <Stack gap={4}>
                {toolBindings.map((b) => (
                  <Group key={`${b.source}::${b.sourceKey}`} gap="xs">
                    <Badge size="xs" variant="light" color="gray">{b.source.toUpperCase()}</Badge>
                    <Text size="xs" fw={500}>{b.sourceKey}</Text>
                    <Badge size="xs" variant="light" color="blue">
                      {b.toolNames.length} tool(s)
                    </Badge>
                  </Group>
                ))}
              </Stack>
            ) : (
              <Text size="xs" c="dimmed" fs="italic">{t('config.noToolsSelected')}</Text>
            )}

            <Button
              variant="light"
              size="xs"
              leftSection={<IconTool size={14} />}
              onClick={() => setToolSelectorOpen(true)}
              w="fit-content"
            >
              {toolBindings.length > 0 ? t('config.editTools') : t('config.addTools')}
            </Button>
          </Stack>

          <ToolSelectorModal
            opened={toolSelectorOpen}
            onClose={() => setToolSelectorOpen(false)}
            value={toolBindings}
            onChange={handleToolBindingsChange}
          />
        </ConfigBlock>

      </Stack>
    )
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow={isConnected ? 'Build · Connected Agent' : 'Build · Agent'}
        title={agent.name}
        subtitle={agent.description || agent.key}
        actions={
          <Group gap="sm">
            {isConnected ? (
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
                <Button
                  size="xs"
                  leftSection={<IconRocket size={14} />}
                  onClick={() => setPublishModalOpen(true)}
                >
                  {t('publish.button')}
                </Button>
              </>
            )}
          </Group>
        }
      />

      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview" leftSection={<IconLayoutDashboard size={14} />}>
            Overview
          </Tabs.Tab>
          <Tabs.Tab value="sessions" leftSection={<IconMessageCircle size={14} />}>
            Sessions
            {sessions.length > 0 ? <Badge size="xs" variant="light" ml={6}>{sessions.length}</Badge> : null}
          </Tabs.Tab>
          <Tabs.Tab value="configure" leftSection={<IconSettings size={14} />}>
            Configure
            {advancedOverrideCount > 0 ? (
              <Badge size="xs" variant="light" ml={6}>{advancedOverrideCount}</Badge>
            ) : null}
          </Tabs.Tab>
          <Tabs.Tab value="deploy" leftSection={<IconRocket size={14} />}>
            Deploy
          </Tabs.Tab>
          <Tabs.Tab value="observe" leftSection={<IconTimeline size={14} />}>
            Observe
          </Tabs.Tab>
          <Tabs.Tab value="usage" leftSection={<IconCode size={14} />}>
            {t('tabs.usage')}
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Overview ────────────────────────────────────────── */}
        <Tabs.Panel value="overview">
          <AgentOverviewPanel
            agent={agent}
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
            }}
          />
        </Tabs.Panel>

        {/* ── Sessions ────────────────────────────────────────── */}
        <Tabs.Panel value="sessions">
          <SectionCard
            title="Sessions"
            description="Each session is its own persisted conversation — history, tool calls and token usage all reload with it."
          >
            <Group justify="flex-end" mb="md">
              <Button
                size="sm"
                leftSection={<IconPlus size={14} />}
                onClick={() => setStartSessionOpen(true)}
              >
                Start new session
              </Button>
            </Group>
            <SessionList
              sessions={sessions}
              loading={sessionsLoading}
              onOpen={(id) => router.push(`/dashboard/agents/${agentId}/sessions/${id}`)}
              onStart={() => setStartSessionOpen(true)}
              searchable
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
          <Paper withBorder radius="md" p="xl">
            <ConfigSection
              first
              id="basic"
              title="General"
              description="What this agent is, which model answers, and the tools it can call."
            >
              {renderBasicSettings()}
            </ConfigSection>

            {!isConnected ? (
              <ConfigSection
                id="prompt"
                title="Prompt"
                description="Inline text, or a prompt from the Prompts module — editable right here."
              >
                <AgentPromptPanel
                  mode={configForm.values.promptMode}
                  onModeChange={(mode) => configForm.setFieldValue('promptMode', mode)}
                  systemPrompt={configForm.values.systemPrompt}
                  onSystemPromptChange={(value) => configForm.setFieldValue('systemPrompt', value)}
                  promptKey={configForm.values.promptKey}
                  onPromptKeyChange={(key) => configForm.setFieldValue('promptKey', key)}
                  prompts={prompts}
                  onPromptsChanged={(next) => setPrompts(next)}
                  onSaveAgentConfig={handleSaveConfig}
                />
              </ConfigSection>
            ) : null}

            {!isConnected ? (
              <ConfigSection
                id="subagents"
                title="Delegation"
                description="Roles this agent can hand work to, and the guards around that."
                meta={subagents.length > 0 ? (
                  <Badge size="xs" variant="light" w="fit-content">{subagents.length} sub-agents</Badge>
                ) : null}
              >
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
                />
              </ConfigSection>
            ) : null}

            {!isConnected ? (
              <ConfigSection
                id="skills"
                title="Skills"
                description="Capabilities this agent can discover and open on demand, from the project's skill library."
                meta={skills.length > 0 ? (
                  <Badge size="xs" variant="light" w="fit-content">{skills.length} attached</Badge>
                ) : null}
              >
                <AgentSkillsPanel
                  skills={skills}
                  policy={skillPolicy}
                  library={skillLibrary}
                  onChange={(nextSkills, nextPolicy) => {
                    setSkills(nextSkills);
                    setSkillPolicy(nextPolicy);
                  }}
                />
              </ConfigSection>
            ) : null}

            {!isConnected ? (
              <ConfigSection
                id="memory"
                title="Memory"
                description="What this agent remembers across runs, backed by a store from the Memory module."
                meta={memoryConfig?.enabled ? (
                  <Badge size="xs" color="teal" variant="light" w="fit-content">on</Badge>
                ) : null}
              >
                <AgentMemoryPanel value={memoryConfig} onChange={setMemoryConfig} stores={memoryStores} />
              </ConfigSection>
            ) : null}

            {!isConnected ? (
              <ConfigSection
                id="sandbox"
                title="Sandbox"
                description="An isolated machine the agent can run commands and code in — template, lifetime, limits and secrets."
                meta={sandboxConfig?.enabled ? (
                  <Badge size="xs" color="grape" variant="light" w="fit-content">
                    {sandboxConfig.mode === 'persist' ? 'persistent' : 'ephemeral'}
                  </Badge>
                ) : null}
              >
                <AgentSandboxPanel value={sandboxConfig} onChange={setSandboxConfig} />
              </ConfigSection>
            ) : null}

            {!isConnected ? (
              <ConfigSection
                id="advanced"
                title="Runtime"
                description="How the agent loop behaves: planning, budgets, context handling and reasoning."
              >
                <AgentAdvancedSettings
                  value={runtimeConfig}
                  onChange={setRuntimeConfig}
                  toolNames={toolBindings.flatMap((binding) => binding.toolNames ?? [])}
                />
              </ConfigSection>
            ) : null}

            {!isConnected ? (
              <ConfigSection
                id="output"
                title="Structured output"
                description="Make the agent answer with JSON that matches a schema instead of free text."
              >
                <AgentStructuredOutputEditor value={structuredOutput} onChange={setStructuredOutput} />
              </ConfigSection>
            ) : null}
          </Paper>

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
          <Group justify="flex-end" className={classes.configSaveBar}>
            <Button onClick={handleSaveConfig} loading={savingConfig}>{t('config.save')}</Button>
          </Group>
        </Tabs.Panel>

        {/*
          Deploy — the lifecycle of a config that is already written:
          freeze it (Versions), expose it (Publish), run it on a cadence
          (Schedules), or take it out of the console entirely (Export).
        */}
        <Tabs.Panel value="deploy">
          {/*
            One page, like Configure — the four things you do with a config
            that is already written sit one under the other, so "is this
            published, exposed, scheduled?" is answered by scrolling, not by
            clicking through a rail. `?tab=versions` etc. scroll here.
          */}
          <Paper withBorder radius="md" p="xl">
            {!isConnected ? (
            <ConfigSection first id="versions" title={t('versions.title')} description={t('versions.description')}>
              <Stack gap="md">
                <Group justify="flex-end" align="center">
                  <Group gap="xs">
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
                  <div className="ds-tbl-wrap">
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th w={40}>
                          <VisuallyHidden>Select version</VisuallyHidden>
                        </Table.Th>
                        <Table.Th>{t('versions.version')}</Table.Th>
                        <Table.Th>{t('versions.changelog')}</Table.Th>
                        <Table.Th>{t('versions.publishedAt')}</Table.Th>
                        <Table.Th />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {versions.map((v) => {
                        const isSelected = compareVersionA === String(v.version) || compareVersionB === String(v.version);
                        return (
                          <Table.Tr key={v.version}>
                            <Table.Td>
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
                            </Table.Td>
                            <Table.Td>
                              <Group gap="xs">
                                <Badge size="sm" variant="filled" color="blue">v{v.version}</Badge>
                                {agent.publishedVersion === v.version && (
                                  <Badge size="xs" variant="light" color="teal">{t('versions.current')}</Badge>
                                )}
                              </Group>
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm" lineClamp={1}>
                                {v.changelog || <Text span c="dimmed" fs="italic" size="sm">{t('versions.noChangelog')}</Text>}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="sm">
                                {v.createdAt ? new Date(v.createdAt).toLocaleString() : '—'}
                              </Text>
                            </Table.Td>
                            <Table.Td>
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
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                  </div>
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

                    <Text size="sm" c="dimmed">{t('a2a.exampleLabel')}</Text>
                    <Code block>
                      {`curl -X POST ${a2aEndpointUrl} \\${a2aIsPublic ? '' : `
  -H "Authorization: Bearer YOUR_API_KEY" \\`}
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "kind": "text", "text": "Hello!" }],
        "messageId": "msg-1"
      }
    }
  }'

# Continue the same conversation: set params.message.contextId
# to the "contextId" returned in the previous task.`}
                    </Code>
                  </>
                )}
              </Stack>
            </ConfigSection>

            {!isConnected ? (
              <ConfigSection
                id="schedules"
                title="Recurring runs"
                description="Run this agent on a cadence. Each fire uses the published version and its own conversation."
              >
                <AgentSchedulesPanel agentId={agentId} publishedVersion={agent.publishedVersion ?? null} />
              </ConfigSection>
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

        {/* ── Observe — what the agent actually did, and what it cost ── */}
        <Tabs.Panel value="observe">
          <Stack gap="md">
            {/* Filters */}
            <SectionCard p="md">
              <Group gap="md" wrap="wrap">
                <Select
                  label={t('traces.statusFilter')}
                  placeholder={t('traces.allStatuses')}
                  data={[
                    { value: 'success', label: 'Success' },
                    { value: 'error', label: 'Error' },
                    { value: 'running', label: 'Running' },
                  ]}
                  value={tracingStatusFilter}
                  onChange={(value) => {
                    setTracingStatusFilter(value);
                    setTracingPage(1);
                  }}
                  clearable
                  className={classes.filterControlSm}
                />
                <DatePickerInput
                  type="range"
                  label={t('traces.dateRange')}
                  placeholder={t('traces.selectRange')}
                  value={tracingDateRange}
                  onChange={(value) => {
                    setTracingDateRange(value as [Date | null, Date | null]);
                    setTracingPage(1);
                  }}
                  leftSection={<IconCalendar size={16} />}
                  clearable
                  className={classes.filterControlMd}
                />
                <Select
                  label={t('traces.pageSize')}
                  data={['25', '50', '100'].map((v) => ({ value: v, label: `${v} rows` }))}
                  value={tracingPageSize.toString()}
                  onChange={(v) => {
                    setTracingPageSize(v ? parseInt(v, 10) : DEFAULT_PAGE_SIZE);
                    setTracingPage(1);
                  }}
                  className={classes.filterControlXs}
                />
                <Box className={classes.filterActions}>
                  <Button
                    leftSection={<IconRefresh size={14} />}
                    variant="light"
                    size="sm"
                    onClick={() => loadTracingSessions(true)}
                    loading={tracingRefreshing}
                  >
                    {t('traces.refresh')}
                  </Button>
                </Box>
              </Group>
            </SectionCard>

            {/* Sessions table */}
            <SectionCard p="md">
              <Stack gap="md">
                <Group justify="space-between" align="center">
                  <Text fw={600}>{t('traces.sessions')}</Text>
                  <Badge size="sm" variant="light">
                    {tracingTotal} total
                  </Badge>
                </Group>

                <SessionTable
                  sessions={tracingSessions}
                  loading={tracingLoading}
                  onRowClick={(sessionId) =>
                    router.push(`/dashboard/tracing/sessions/${sessionId}`)
                  }
                  onThreadClick={(threadId) =>
                    router.push(`/dashboard/tracing/threads/${threadId}`)
                  }
                />

                {tracingPagination.totalPages > 1 && (
                  <Group justify="space-between" align="center">
                    <Text size="sm" c="dimmed">
                      Page {tracingPage} of {tracingPagination.totalPages}
                    </Text>
                    <Pagination
                      total={tracingPagination.totalPages}
                      value={tracingPage}
                      onChange={setTracingPage}
                    />
                  </Group>
                )}
              </Stack>
            </SectionCard>
          </Stack>
        </Tabs.Panel>

        {/*
          Usage — how to call this agent from outside the console. Its own
          tab because it is what someone integrating the agent opens first,
          and it had been buried as the second item of Observe's rail.
        */}
        <Tabs.Panel value="usage">
          <Stack gap="md">
            <SectionCard p="md">
              <Stack gap="md">
                <Text size="lg" fw={600}>
                  {t('usage.title')}
                </Text>
                <Text size="sm" c="dimmed">
                  {t('usage.description', { name: agent.name })}
                </Text>

                <Divider />

                {/* ── SDK Usage ─────────────────────────────── */}
                <Text size="sm" fw={600}>
                  {t('usage.sdkTitle')}
                </Text>

                <Text size="sm" c="dimmed" mb="xs">
                  {t('usage.installLabel')}
                </Text>
                <Box>
                  <Group gap="xs" align="center">
                    <Code block className={classes.codeGrow}>
                      npm install @cognipeer/console-sdk
                    </Code>
                    <CopyButton value="npm install @cognipeer/console-sdk">
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy'}>
                          <ActionIcon
                            variant="subtle"
                            onClick={copy}
                            color={copied ? 'teal' : 'gray'}
                          >
                            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                  </Group>
                </Box>

                <Text size="sm" c="dimmed" mb="xs">
                  {t('usage.chatLabel')}
                </Text>
                <Code block>
                  {`import { ConsoleClient } from '@cognipeer/console-sdk';

const client = new ConsoleClient({
  apiKey: 'YOUR_API_KEY',
  baseURL: '${typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com'}',
});

// ── Single turn ──────────────────────────────────
const response = await client.agents.responses.create({
  model: '${agent.key}',
  input: 'Hello, how can you help me?',
});
console.log(response.output[0].content[0].text);

// ── Multi-turn conversation ──────────────────────
// Pass previous_response_id to continue the conversation
const followUp = await client.agents.responses.create({
  model: '${agent.key}',
  input: 'Tell me more about that',
  previous_response_id: response.id,
});
console.log(followUp.output[0].content[0].text);

// ── Use a specific published version ─────────────
const res = await client.agents.responses.create({
  model: '${agent.key}',
  input: 'Summarize the key points',
  version: ${agent.publishedVersion || 1},
});`}
                </Code>

                <Divider />

                {/* ── REST Usage ────────────────────────────── */}
                <Text size="sm" fw={600}>
                  {t('usage.restTitle')}
                </Text>

                <Text size="sm" c="dimmed" mb="xs">
                  {t('usage.restLabel')}
                </Text>
                <Code block>
                  {`# First message
curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com'}/api/client/v1/responses \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${agent.key}",
    "input": "Hello, how can you help me?"
  }'

# Continue conversation (use the id from the previous response)
curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com'}/api/client/v1/responses \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${agent.key}",
    "input": "Tell me more about that",
    "previous_response_id": "resp_<conversation_id>"
  }'

# Use a specific published version
curl -X POST ${typeof window !== 'undefined' ? window.location.origin : 'https://your-instance.com'}/api/client/v1/responses \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${agent.key}",
    "input": "Hello!",
    "version": ${agent.publishedVersion || 1}
  }'`}
                </Code>

                <Divider />

                {/* ── Response Format ──────────────────────── */}
                <Text size="sm" fw={600}>
                  {t('usage.responseTitle')}
                </Text>
                <Code block>
                  {`{
  "id": "resp_<conversation_id>",
  "object": "response",
  "model": "${agent.name}",
  "output": [
    {
      "id": "msg_abc123",
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "Agent response text..."
        }
      ]
    }
  ],
  "status": "completed",
  "usage": {
    "input_tokens": 50,
    "output_tokens": 100,
    "total_tokens": 150
  },
  "created_at": 1719500000,
  "previous_response_id": null,
  "version": ${agent.publishedVersion || 'null'}
}`}
                </Code>

                {/*
                  Every other surface the agent is reachable on. They were
                  built one at a time and only the Responses API was ever
                  documented here, so an integrator reading this tab would
                  not know an OpenAI client could call the agent at all.
                */}
                <Divider />
                <Text size="sm" fw={600}>OpenAI-compatible (chat/completions)</Text>
                <Text size="xs" c="dimmed">
                  Any OpenAI SDK can call this agent — put its key in <code>model</code> (or <code>agent:{agent.key}</code> if a
                  model shares the name). Runs the published version. Pass back <code>conversation_id</code> to continue a thread;
                  set <code>stream: true</code> for token deltas.
                </Text>
                <Code block>
{`from openai import OpenAI

client = OpenAI(base_url="${apiOrigin}/api/client/v1", api_key="YOUR_API_TOKEN")

stream = client.chat.completions.create(
    model="${agent.key}",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`}
                </Code>
                <Code block>
{`curl -N -X POST ${apiOrigin}/api/client/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${agent.key}", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'`}
                </Code>

                <Divider />
                <Text size="sm" fw={600}>A2A (agent-to-agent)</Text>
                <Text size="xs" c="dimmed">
                  {a2aEnabled
                    ? 'Exposed. Other agents discover it from the card and talk JSON-RPC — settings under Deploy → Publish.'
                    : 'Not exposed yet — turn it on under Deploy → Publish, then other agents can discover it from the card below.'}
                </Text>
                <Code block>{`GET ${a2aCardUrl}`}</Code>

                <Divider />
                <Text size="sm" fw={600}>Assistants API</Text>
                <Text size="xs" c="dimmed">
                  For clients built on OpenAI Assistants. This agent already IS an assistant — its id is
                  {' '}<code>asst_{agent.key}</code> — so there is nothing to create; <code>POST /assistants</code> would make
                  a new, separate agent. Start a thread and run it in one call:
                </Text>
                <Code block>
{`POST ${apiOrigin}/api/client/v1/threads/runs
{
  "assistant_id": "asst_${agent.key}",
  "thread": { "messages": [{ "role": "user", "content": "Hello" }] }
}`}
                </Code>
              </Stack>
            </SectionCard>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {/* ── Publish Modal ──────────────────────────────────────── */}
      <Modal
        opened={publishModalOpen}
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

/** One-line code block with a copy button (endpoint URLs on the Publish tab). */
function CopyableCode({ value }: { value: string }) {
  return (
    <Group gap="xs" align="center">
      <Code block className={classes.codeGrow}>{value}</Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied' : 'Copy'}>
            <ActionIcon variant="subtle" onClick={copy} color={copied ? 'teal' : 'gray'}>
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
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

// ReasoningDisclosure / StepTimeline / StepPayload / StructuredOutputBlock /
// TurnFooter moved to `session/AgentSessionView.tsx` along with the rest of
// the chat UI they belonged to — see that file.
