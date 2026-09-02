'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  PasswordInput,
  Select,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconInfoCircle, IconPlug } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
import SpecImportField, { type SpecFormat } from '@/components/common/SpecImportField';
import type { McpServerView } from '@/lib/services/mcp';

interface CreateMcpModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (server: McpServerView) => void;
}

type AuthType = 'none' | 'token' | 'header' | 'basic';
type SourceType = 'openapi' | 'remote' | 'stdio' | 'internal' | 'composite';
type StdioRuntime = 'npx' | 'uvx';
type ExecutionMode = 'subprocess' | 'sandbox';
type AccessMode = 'token' | 'public';
/**
 * Keeps the MCP vocabulary ('off' rather than 'disabled') — this is the wire
 * shape of `IMcpGuardrailConfig.mode`, not `GuardrailMode`.
 */
type GuardrailBindingMode = 'off' | 'monitor' | 'enforce';

interface InternalProviderConfigField {
  key: string;
  label: string;
  type: 'model' | 'text' | 'number';
  required?: boolean;
  modelCategory?: string;
  hint?: string;
}

interface InternalProviderInfo {
  id: string;
  label: string;
  description: string;
  configFields: InternalProviderConfigField[];
}

interface McpCapabilities {
  stdioSubprocess: { enabled: boolean; npx: boolean; uvx: boolean };
  // `available` folds both the enterprise build seam AND the tenant's
  // ENTERPRISE license. `seamAvailable`/`licenseEnterprise` explain WHY
  // it is off: no license (upgradeable) vs. community build (edition).
  stdioSandbox: { available: boolean; enterpriseBuild: boolean; seamAvailable?: boolean; licenseEnterprise?: boolean };
  /**
   * Guardrail enforcement on tool calls. Community — there is no license fold
   * here, only "is the hook wired at all". OPTIONAL because this UI can be
   * served by an API binary that predates the rename.
   */
  guardrail?: { available: boolean };
  /**
   * @deprecated Pre-rename spelling of `guardrail`, read only as a fallback.
   * On that older binary the hook really was enterprise-gated, so a `false`
   * here is an accurate "not enforcing" for that deployment.
   */
  aegis?: { hookAvailable: boolean };
  mcpHub?: { available: boolean; enterpriseBuild: boolean; licenseEnterprise?: boolean };
  internalProviders?: InternalProviderInfo[];
}

/**
 * A guardrail the operator can bind to this server's tool calls.
 * `toolBound` is what the hint column reports: a guardrail only touches an MCP
 * call through its `tool.pre` / `tool.post` bindings, and a legacy record lifts
 * onto `input.pre`/`output.pre` only — so most existing guardrails will bind
 * nothing here until someone adds a tool hook to them.
 */
interface GuardrailOption {
  key: string;
  name: string;
  enabled: boolean;
  toolBound: boolean;
}

interface InternalInstanceOption {
  key: string;
  label: string;
  description?: string;
}

interface McpHubOption {
  id: string;
  key: string;
  name: string;
  serverKeys: string[];
}

/** Candidate member for a composite server — pulled from the existing server list. */
interface McpMemberOption {
  id: string;
  key: string;
  name: string;
  sourceType: SourceType;
  status: string;
  toolCount: number;
}

const NEW_HUB_VALUE = '__new__';
const NO_HUB_VALUE = '__none__';
// An ABSENT guardrailKey means "use the tenant's default tool guardrail"
// (IMcpGuardrailConfig), which is a real choice an operator makes — so it needs
// its own option value rather than the empty string, which Mantine's Select
// treats as "nothing selected".
const DEFAULT_GUARDRAIL_VALUE = '__default__';
// Providers other than Knowledge Base aren't scoped to a per-instance
// resource yet (one MCP server covers the whole project) — this must match
// the instance key each such provider's `listInstances()` returns.
const SINGLE_INSTANCE_KEY = 'project';

interface FormValues {
  name: string;
  key: string;
  description: string;
  sourceType: SourceType;
  // openapi
  upstreamBaseUrl: string;
  openApiSpec: string;
  specFormat: SpecFormat;
  // remote
  remoteUrl: string;
  remoteTransport: 'streamable-http' | 'sse';
  // stdio
  stdioRuntime: StdioRuntime;
  stdioPackage: string;
  stdioArgs: string;
  stdioEnv: string;
  executionMode: ExecutionMode;
  sandboxCpu: string;
  sandboxMemory: string;
  // internal
  internalProvider: string;
  internalInstanceKey: string;
  hubChoice: string;
  newHubName: string;
  // composite
  compositeMembers: string[];
  // auth
  authType: AuthType;
  authToken: string;
  authHeaderName: string;
  authHeaderValue: string;
  authUsername: string;
  authPassword: string;
  // exposure
  protocolHttp: boolean;
  protocolSse: boolean;
  accessMode: AccessMode;
  endpointSlug: string;
  // guardrail
  guardrailMode: GuardrailBindingMode;
  /** Guardrail key, or DEFAULT_GUARDRAIL_VALUE for the default tool guardrail. */
  guardrailKey: string;
}

/** Parse "KEY=value" lines into an env map (ignores blanks and comments). */
function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function parseArgs(text: string): string[] {
  return text
    .split(/\s+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

export default function CreateMcpModal({
  opened,
  onClose,
  onCreated,
}: CreateMcpModalProps) {
  const [loading, setLoading] = useState(false);
  const [capabilities, setCapabilities] = useState<McpCapabilities | null>(null);
  const [guardrails, setGuardrails] = useState<GuardrailOption[]>([]);
  const [ragModules, setRagModules] = useState<InternalInstanceOption[]>([]);
  const [hubs, setHubs] = useState<McpHubOption[]>([]);
  const [memberOptions, setMemberOptions] = useState<McpMemberOption[]>([]);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      key: '',
      description: '',
      sourceType: 'openapi',
      upstreamBaseUrl: '',
      openApiSpec: '',
      specFormat: 'auto',
      remoteUrl: '',
      remoteTransport: 'streamable-http',
      stdioRuntime: 'npx',
      stdioPackage: '',
      stdioArgs: '',
      stdioEnv: '',
      executionMode: 'subprocess',
      sandboxCpu: '1',
      sandboxMemory: '512',
      internalProvider: 'knowledge-base',
      internalInstanceKey: '',
      hubChoice: NO_HUB_VALUE,
      newHubName: '',
      compositeMembers: [],
      authType: 'none',
      authToken: '',
      authHeaderName: '',
      authHeaderValue: '',
      authUsername: '',
      authPassword: '',
      protocolHttp: true,
      protocolSse: true,
      accessMode: 'token',
      endpointSlug: '',
      guardrailMode: 'off',
      guardrailKey: DEFAULT_GUARDRAIL_VALUE,
    },
    validate: (values) => {
      const errors: Partial<Record<keyof FormValues, string>> = {};
      if (!values.name.trim()) errors.name = 'Name is required';
      if (values.sourceType === 'openapi' && !values.openApiSpec.trim()) {
        errors.openApiSpec = 'A specification is required';
      }
      if (values.sourceType === 'remote' && !values.remoteUrl.trim()) {
        errors.remoteUrl = 'MCP server URL is required';
      }
      if (values.sourceType === 'stdio' && !values.stdioPackage.trim()) {
        errors.stdioPackage = 'Package name is required';
      }
      if (values.sourceType === 'internal') {
        if (values.internalProvider === 'knowledge-base') {
          if (!values.internalInstanceKey.trim()) {
            errors.internalInstanceKey = 'Choose which Knowledge Base to publish';
          }
        }
        if (values.hubChoice === NEW_HUB_VALUE && !values.newHubName.trim()) {
          errors.newHubName = 'Name the new hub';
        }
      }
      if (values.sourceType === 'composite' && values.compositeMembers.length === 0) {
        errors.compositeMembers = 'Select at least one member server';
      }
      if (values.sourceType !== 'stdio' && values.sourceType !== 'internal' && values.sourceType !== 'composite') {
        if (values.authType === 'token' && !values.authToken.trim()) {
          errors.authToken = 'Token is required';
        }
        if (values.authType === 'header') {
          if (!values.authHeaderName.trim()) errors.authHeaderName = 'Header name is required';
          if (!values.authHeaderValue.trim()) errors.authHeaderValue = 'Header value is required';
        }
        if (values.authType === 'basic') {
          if (!values.authUsername.trim()) errors.authUsername = 'Username is required';
          if (!values.authPassword.trim()) errors.authPassword = 'Password is required';
        }
      }
      return errors;
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
      return;
    }
    // Runtime capabilities decide which source/execution options are offered.
    fetch('/api/mcp/capabilities')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setCapabilities(data))
      .catch(() => setCapabilities(null));
    // Guardrails available to bind to this server's tool calls. Every guardrail
    // is listed, not just the tool-bound ones — binding one that has no tool
    // hook yet is a legitimate half-finished setup, so it is flagged in the
    // option label rather than hidden.
    fetch('/api/guardrails')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const list = Array.isArray(data?.guardrails) ? data.guardrails : [];
        setGuardrails(list.map((g: {
          key?: string;
          name?: string;
          enabled?: boolean;
          hooks?: { bindings?: Record<string, { enabled?: boolean } | undefined> };
        }) => ({
          key: String(g.key ?? ''),
          name: String(g.name ?? g.key ?? ''),
          enabled: g.enabled !== false,
          toolBound: Boolean(
            g.hooks?.bindings?.['tool.pre']?.enabled
            || g.hooks?.bindings?.['tool.post']?.enabled,
          ),
        })).filter((g: GuardrailOption) => g.key));
      })
      .catch(() => setGuardrails([]));
    // Knowledge Base modules — instances for the "internal" (Knowledge Base) source.
    fetch('/api/rag/modules?status=active')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const list = Array.isArray(data?.modules) ? data.modules : [];
        setRagModules(list.map((m: { key: string; name: string; description?: string }) => ({
          key: m.key,
          label: m.name,
          description: m.description,
        })));
      })
      .catch(() => setRagModules([]));
    // MCP hubs — enterprise only; degrade silently when unavailable.
    fetch('/api/mcp/hubs')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const list = Array.isArray(data?.hubs) ? data.hubs : [];
        setHubs(list.map((h: { id: string; key: string; name: string; serverKeys?: string[] }) => ({
          id: h.id,
          key: h.key,
          name: h.name,
          serverKeys: h.serverKeys ?? [],
        })));
      })
      .catch(() => setHubs([]));
    // Candidate members for a composite server — any other active MCP server
    // on this project. Composite-sourced servers are excluded (no nesting).
    fetch('/api/mcp?status=active')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const list = Array.isArray(data?.servers) ? data.servers : [];
        setMemberOptions(
          list
            .filter((s: { sourceType?: string }) => s.sourceType !== 'composite')
            .map((s: { id: string; key: string; name: string; sourceType?: string; status: string; tools?: unknown[] }) => ({
              id: s.id,
              key: s.key,
              name: s.name,
              sourceType: (s.sourceType ?? 'openapi') as SourceType,
              status: s.status,
              toolCount: s.tools?.length ?? 0,
            })),
        );
      })
      .catch(() => setMemberOptions([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  // Default the hub picker once hubs are known: one hub → preselect it,
  // none → offer creating one, several → leave unattached by default.
  useEffect(() => {
    if (!opened || form.values.sourceType !== 'internal') return;
    if (form.values.hubChoice !== NO_HUB_VALUE) return;
    if (hubs.length === 1) {
      form.setFieldValue('hubChoice', hubs[0].id);
    } else if (hubs.length === 0 && capabilities?.mcpHub?.available) {
      form.setFieldValue('hubChoice', NEW_HUB_VALUE);
      form.setFieldValue('newHubName', 'Internal Services');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, hubs, capabilities, form.values.sourceType]);

  // Providers without a per-instance picker (anything but Knowledge Base, for
  // now) always target the same single project-scoped instance.
  useEffect(() => {
    if (form.values.sourceType !== 'internal') return;
    if (form.values.internalProvider === 'knowledge-base') return;
    if (form.values.internalInstanceKey !== SINGLE_INSTANCE_KEY) {
      form.setFieldValue('internalInstanceKey', SINGLE_INSTANCE_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.sourceType, form.values.internalProvider]);

  const v = form.values;

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setLoading(true);
    try {
      const upstreamAuth: Record<string, string> = {
        type: v.sourceType === 'stdio' || v.sourceType === 'internal' || v.sourceType === 'composite'
          ? 'none'
          : v.authType,
      };
      if (v.sourceType !== 'stdio' && v.sourceType !== 'internal' && v.sourceType !== 'composite') {
        if (v.authType === 'token') {
          upstreamAuth.token = v.authToken;
        } else if (v.authType === 'header') {
          upstreamAuth.headerName = v.authHeaderName;
          upstreamAuth.headerValue = v.authHeaderValue;
        } else if (v.authType === 'basic') {
          upstreamAuth.username = v.authUsername;
          upstreamAuth.password = v.authPassword;
        }
      }

      const protocols = [
        ...(v.protocolHttp ? ['streamable-http'] : []),
        ...(v.protocolSse ? ['sse'] : []),
      ];

      const payload: Record<string, unknown> = {
        name: v.name,
        key: v.key.trim() || undefined,
        description: v.description || undefined,
        sourceType: v.sourceType,
        upstreamAuth,
        exposure: {
          protocols: protocols.length ? protocols : ['streamable-http', 'sse'],
          accessMode: v.accessMode,
        },
        endpointSlug: v.accessMode === 'public' && v.endpointSlug.trim()
          ? v.endpointSlug.trim()
          : undefined,
        // Omitted entirely when off — an absent block and `{ mode: 'off' }`
        // mean the same thing to the gateway, and a guardrail key without a
        // mode to run it in would just be dead configuration.
        guardrail: v.guardrailMode !== 'off'
          ? {
              mode: v.guardrailMode,
              guardrailKey: v.guardrailKey === DEFAULT_GUARDRAIL_VALUE
                ? undefined
                : v.guardrailKey,
            }
          : undefined,
      };

      if (v.sourceType === 'openapi') {
        payload.openApiSpec = v.openApiSpec;
        payload.specFormat = v.specFormat;
        payload.upstreamBaseUrl = v.upstreamBaseUrl || undefined;
      } else if (v.sourceType === 'remote') {
        payload.remoteConfig = {
          url: v.remoteUrl.trim(),
          transport: v.remoteTransport,
        };
      } else if (v.sourceType === 'internal') {
        payload.internalConfig = {
          provider: v.internalProvider,
          instanceKey: v.internalInstanceKey,
          config: {},
        };
      } else if (v.sourceType === 'composite') {
        payload.compositeConfig = {
          members: v.compositeMembers.map((serverId) => ({ serverId })),
        };
      } else {
        const env = parseEnvLines(v.stdioEnv);
        payload.stdioConfig = {
          runtime: v.stdioRuntime,
          packageName: v.stdioPackage.trim(),
          args: parseArgs(v.stdioArgs),
          env: Object.keys(env).length ? env : undefined,
          executionMode: v.executionMode,
          sandbox: v.executionMode === 'sandbox'
            ? {
                resources: {
                  cpuCores: Number(v.sandboxCpu) || 1,
                  memoryMb: Number(v.sandboxMemory) || 512,
                },
              }
            : undefined,
        };
      }

      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create MCP server');
      }

      const data = await res.json();

      // Optional hub attach — only reachable when sourceType is 'internal'
      // and mcpHub is licensed (see the "Add to Hub" section below).
      if (v.sourceType === 'internal' && v.hubChoice !== NO_HUB_VALUE) {
        try {
          if (v.hubChoice === NEW_HUB_VALUE) {
            await fetch('/api/mcp/hubs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: v.newHubName.trim(),
                serverKeys: [data.server.key],
              }),
            });
          } else {
            const hub = hubs.find((h) => h.id === v.hubChoice);
            if (hub) {
              await fetch(`/api/mcp/hubs/${hub.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  serverKeys: [...hub.serverKeys, data.server.key],
                }),
              });
            }
          }
        } catch {
          notifications.show({
            title: 'Hub attach failed',
            message: `"${v.name}" was created, but attaching it to the hub failed. You can attach it from the MCP Hubs page.`,
            color: 'yellow',
          });
        }
      }

      notifications.show({
        title: 'MCP Server Created',
        message: `"${v.name}" is ready to serve requests`,
        color: 'teal',
      });
      onCreated(data.server);
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to create MCP server',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const validIdentity = Boolean(v.name.trim());
  const validAuth = (() => {
    if (v.sourceType === 'stdio' || v.sourceType === 'internal' || v.sourceType === 'composite') return true;
    if (v.authType === 'token') return Boolean(v.authToken.trim());
    if (v.authType === 'header') return Boolean(v.authHeaderName.trim() && v.authHeaderValue.trim());
    if (v.authType === 'basic') return Boolean(v.authUsername.trim() && v.authPassword.trim());
    return true;
  })();
  const validSource = useMemo(() => {
    if (v.sourceType === 'openapi') return Boolean(v.openApiSpec.trim());
    if (v.sourceType === 'remote') return Boolean(v.remoteUrl.trim());
    if (v.sourceType === 'internal') return Boolean(v.internalInstanceKey.trim());
    if (v.sourceType === 'composite') return v.compositeMembers.length > 0;
    return Boolean(v.stdioPackage.trim());
  }, [
    v.sourceType, v.openApiSpec, v.remoteUrl, v.stdioPackage,
    v.internalProvider, v.internalInstanceKey, v.compositeMembers,
  ]);
  const validExposure = v.protocolHttp || v.protocolSse;
  // An internal-service member reads tenant-private data with no credential
  // of its own — exposing it publicly is allowed (that's the point of a
  // public URL), but it's worth a loud warning before the operator commits.
  const compositeHasInternalMember = v.sourceType === 'composite'
    && v.compositeMembers.some((id) => memberOptions.find((m) => m.id === id)?.sourceType === 'internal');
  const readsInternalData = v.sourceType === 'internal' || compositeHasInternalMember;

  const checklist = [
    { id: 1, label: 'Name provided', done: validIdentity },
    { id: 2, label: 'Source configured', done: validSource },
    { id: 3, label: 'Authentication configured', done: validAuth },
    { id: 4, label: 'Exposure configured', done: validExposure },
  ];

  const authLabel: Record<AuthType, string> = {
    none: 'No authentication',
    token: 'Bearer token',
    header: 'Custom header',
    basic: 'Basic auth',
  };

  const sourceLabel: Record<SourceType, string> = {
    openapi: 'OpenAPI spec',
    remote: 'Remote MCP',
    stdio: 'Package (stdio)',
    internal: 'Internal service',
    composite: 'Composite (other servers)',
  };

  const selectedRagModule = ragModules.find((m) => m.key === v.internalInstanceKey);
  // undefined while the default option is selected — that binding names no
  // guardrail at all, so there is nothing to warn about.
  const selectedGuardrail = guardrails.find((g) => g.key === v.guardrailKey);

  const sandboxAvailable = capabilities?.stdioSandbox.available ?? false;
  const subprocessEnabled = capabilities?.stdioSubprocess.enabled ?? true;
  const uvxAvailable = capabilities?.stdioSubprocess.uvx ?? true;
  // `guardrail.available` on a current API; `aegis.hookAvailable` is the
  // pre-rename key, read so this UI still tells the truth against an API binary
  // that has not been redeployed yet.
  const guardrailAvailable = capabilities?.guardrail?.available
    ?? capabilities?.aegis?.hookAvailable
    ?? false;
  // Distinguish "off because no ENTERPRISE license" (upgradeable on this SaaS
  // deployment) from "off because community build" (edition has no seam).
  const sandboxNeedsPlan = (capabilities?.stdioSandbox.seamAvailable ?? capabilities?.stdioSandbox.enterpriseBuild ?? false)
    && !(capabilities?.stdioSandbox.licenseEnterprise ?? false);
  const sandboxUnavailableReason = sandboxNeedsPlan
    ? 'Persistent sandbox execution requires an active Enterprise plan. Upgrade under Dashboard → License to enable it.'
    : 'Persistent sandbox execution is part of the Enterprise edition and is not available on this deployment.';

  const summary = (
    <>
      <SummaryGroup title="Server">
        <SummaryKV
          label="Name"
          value={v.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV label="Source" value={sourceLabel[v.sourceType]} />
        {v.sourceType === 'openapi' ? (
          <SummaryKV
            label="Base URL"
            value={v.upstreamBaseUrl || <span className="ds-faint">from spec</span>}
            mono
          />
        ) : null}
        {v.sourceType === 'remote' ? (
          <SummaryKV
            label="URL"
            value={v.remoteUrl || <span className="ds-faint">—</span>}
            mono
          />
        ) : null}
        {v.sourceType === 'stdio' ? (
          <>
            <SummaryKV
              label="Command"
              value={`${v.stdioRuntime} ${v.stdioPackage || '…'}`}
              mono
            />
            <SummaryKV
              label="Runtime"
              value={v.executionMode === 'sandbox'
                ? `Sandbox · ${v.sandboxCpu} CPU / ${v.sandboxMemory} MB`
                : 'Subprocess (stateless)'}
            />
          </>
        ) : null}
        {v.sourceType === 'internal' ? (
          <>
            <SummaryKV
              label="Service"
              value={capabilities?.internalProviders?.find((p) => p.id === v.internalProvider)?.label
                ?? v.internalProvider}
            />
            {v.internalProvider === 'knowledge-base' ? (
              <SummaryKV
                label="Knowledge Base"
                value={selectedRagModule?.label || <span className="ds-faint">—</span>}
              />
            ) : null}
            <SummaryKV
              label="Hub"
              value={
                v.hubChoice === NO_HUB_VALUE
                  ? 'Not attached'
                  : v.hubChoice === NEW_HUB_VALUE
                    ? `New: ${v.newHubName || '…'}`
                    : hubs.find((h) => h.id === v.hubChoice)?.name || '—'
              }
            />
          </>
        ) : null}
        {v.sourceType === 'composite' ? (
          <SummaryKV
            label="Members"
            value={v.compositeMembers.length
              ? v.compositeMembers
                .map((id) => memberOptions.find((m) => m.id === id)?.name ?? id)
                .join(', ')
              : <span className="ds-faint">—</span>}
          />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title="Exposure">
        <SummaryKV
          label="Protocols"
          value={[v.protocolHttp ? 'HTTP' : null, v.protocolSse ? 'SSE' : null]
            .filter(Boolean)
            .join(' + ') || '—'}
        />
        <SummaryKV
          label="Access"
          value={v.accessMode === 'public' ? 'Public URL (no auth)' : 'API token required'}
        />
        {v.accessMode === 'public' ? (
          <SummaryKV label="Custom path" value={v.endpointSlug.trim() || 'Auto-generated'} />
        ) : null}
        {v.guardrailMode !== 'off' ? (
          <SummaryKV
            label="Guardrail"
            value={`${v.guardrailMode} · ${v.guardrailKey === DEFAULT_GUARDRAIL_VALUE
              ? 'default tool guardrail'
              : v.guardrailKey}`}
          />
        ) : null}
      </SummaryGroup>

      {v.sourceType !== 'stdio' && v.sourceType !== 'internal' && v.sourceType !== 'composite' ? (
        <SummaryGroup title="Authentication">
          <SummaryKV label="Type" value={authLabel[v.authType]} />
        </SummaryGroup>
      ) : null}

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const canSubmit = validIdentity && validAuth && validSource && validExposure;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconPlug size={16} />}
      title="New MCP server"
      subtitle="Expose an API, a remote MCP server, or an npx/uvx package as MCP tools."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create server',
        icon: <IconCheck size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: handleSubmit,
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="How this MCP server is identified across the console."
        done={validIdentity}
      >
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput
              placeholder="My API Service"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="Brief description of what this MCP server does"
              minRows={2}
              autosize
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField
            label="Server key"
            optional
            hint="Used in the API path (e.g. /api/client/v1/mcp/<key>/...). Leave blank to derive it from the name — you can change it later."
          >
            <TextInput
              placeholder="my-api-service"
              {...form.getInputProps('key')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Tool source"
        description="Where the MCP tools come from."
        done={validSource}
      >
        <FormField label="Source type">
          <ChipPicker<SourceType>
            options={[
              { value: 'openapi', label: 'OpenAPI spec' },
              { value: 'remote', label: 'Remote MCP URL' },
              { value: 'stdio', label: 'npx / uvx package' },
              { value: 'internal', label: 'Internal service' },
              { value: 'composite', label: 'Composite (other servers)' },
            ]}
            value={v.sourceType}
            onChange={(val) => form.setFieldValue('sourceType', val as SourceType)}
          />
        </FormField>

        {v.sourceType === 'composite' ? (
          <FormRow cols={1}>
            <FormField
              label="Member servers"
              required
              hint="Each member keeps its own auth, its own enabled tools and its own request logs — this only decides which of their tools are republished here. Tool names are kept as-is unless two members collide, in which case the colliding ones get prefixed."
            >
              {memberOptions.length === 0 ? (
                <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
                  No other MCP servers yet — create one first, then come back to build a composite.
                </Alert>
              ) : (
                <ToggleList>
                  {memberOptions.map((m) => (
                    <ToggleRow
                      key={m.id}
                      label={m.name}
                      description={`${m.key} · ${m.sourceType} · ${m.toolCount} tool${m.toolCount === 1 ? '' : 's'}${m.status !== 'active' ? ' · disabled' : ''}`}
                      checked={v.compositeMembers.includes(m.id)}
                      onChange={(checked) => form.setFieldValue(
                        'compositeMembers',
                        checked
                          ? [...v.compositeMembers, m.id]
                          : v.compositeMembers.filter((id) => id !== m.id),
                      )}
                    />
                  ))}
                </ToggleList>
              )}
            </FormField>
          </FormRow>
        ) : null}

        {v.sourceType === 'internal' ? (
          <>
            <FormField label="Internal service" hint="More internal services will show up here over time.">
              <ChipPicker<string>
                options={(capabilities?.internalProviders ?? [{ id: 'knowledge-base', label: 'Knowledge Base', description: '' }])
                  .map((p) => ({ value: p.id, label: p.label }))}
                value={v.internalProvider}
                onChange={(val) => {
                  // ChipPicker<T> types onChange as T | Set<T> for multi-select;
                  // this usage is single-select, so val is always a plain string.
                  form.setFieldValue('internalProvider', val as string);
                  // Instance picking only applies to Knowledge Base today —
                  // reset it when switching so a stale key can't leak through.
                  form.setFieldValue('internalInstanceKey', '');
                }}
              />
            </FormField>

            {v.internalProvider === 'knowledge-base' ? (
              <FormRow cols={1}>
                <FormField label="Knowledge Base" required hint="The RAG module this tool searches.">
                  {ragModules.length === 0 ? (
                    <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
                      No Knowledge Bases yet — create one under Dashboard → Knowledge Base first.
                    </Alert>
                  ) : (
                    <Select
                      placeholder="Choose a Knowledge Base"
                      data={ragModules.map((m) => ({ value: m.key, label: m.label }))}
                      value={v.internalInstanceKey || null}
                      onChange={(val) => form.setFieldValue('internalInstanceKey', val ?? '')}
                    />
                  )}
                </FormField>
              </FormRow>
            ) : (
              <Alert color="gray" icon={<IconInfoCircle size={16} />}>
                {capabilities?.internalProviders?.find((p) => p.id === v.internalProvider)?.description
                  ?? 'No extra configuration needed — this publishes reporting tools for this project.'}
              </Alert>
            )}

            <FormField
              label="Add to hub"
              optional
              hint={capabilities?.mcpHub?.available
                ? 'Publish this tool under an MCP hub so it shows up alongside your other catalogued servers.'
                : 'MCP Hubs require an active Enterprise license. This tool is still created and callable on its own endpoint.'}
            >
              <Select
                disabled={!capabilities?.mcpHub?.available}
                data={[
                  { value: NO_HUB_VALUE, label: "Don't attach" },
                  ...hubs.map((h) => ({ value: h.id, label: h.name })),
                  { value: NEW_HUB_VALUE, label: '+ Create new hub' },
                ]}
                value={v.hubChoice}
                onChange={(val) => form.setFieldValue('hubChoice', val ?? NO_HUB_VALUE)}
              />
            </FormField>
            {v.hubChoice === NEW_HUB_VALUE ? (
              <FormRow cols={1}>
                <FormField label="New hub name" required>
                  <TextInput
                    placeholder="Knowledge Base Tools"
                    {...form.getInputProps('newHubName')}
                  />
                </FormField>
              </FormRow>
            ) : null}
          </>
        ) : null}

        {v.sourceType === 'openapi' ? (
          <>
            <FormRow cols={1}>
              <FormField
                label="Upstream base URL"
                optional
                hint="Override the server URL from the OpenAPI spec."
              >
                <TextInput
                  placeholder="https://api.example.com"
                  {...form.getInputProps('upstreamBaseUrl')}
                />
              </FormField>
            </FormRow>
            <FormField label="Specification" required>
              <SpecImportField
                value={v.openApiSpec}
                onChange={(val) => form.setFieldValue('openApiSpec', val)}
                format={v.specFormat}
                onFormatChange={(val) => form.setFieldValue('specFormat', val)}
              />
            </FormField>
          </>
        ) : null}

        {v.sourceType === 'remote' ? (
          <>
            <FormRow cols={1}>
              <FormField label="MCP server URL" required hint="Tools are discovered from this server and proxied through the gateway.">
                <TextInput
                  placeholder="https://mcp.example.com/mcp"
                  {...form.getInputProps('remoteUrl')}
                />
              </FormField>
            </FormRow>
            <FormField label="Upstream transport">
              <ChipPicker<'streamable-http' | 'sse'>
                options={[
                  { value: 'streamable-http', label: 'Streamable HTTP' },
                  { value: 'sse', label: 'SSE (legacy)' },
                ]}
                value={v.remoteTransport}
                onChange={(val) => form.setFieldValue('remoteTransport', val as 'streamable-http' | 'sse')}
              />
            </FormField>
          </>
        ) : null}

        {v.sourceType === 'stdio' ? (
          <>
            {!subprocessEnabled && !sandboxAvailable ? (
              <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
                Stdio execution is disabled on this deployment.
              </Alert>
            ) : null}
            <FormRow cols={2}>
              <FormField label="Runtime" hint={!uvxAvailable && v.stdioRuntime === 'uvx' ? 'uvx not found on the server' : undefined}>
                <ChipPicker<StdioRuntime>
                  options={[
                    { value: 'npx', label: 'npx (Node)' },
                    { value: 'uvx', label: 'uvx (Python)' },
                  ]}
                  value={v.stdioRuntime}
                  onChange={(val) => form.setFieldValue('stdioRuntime', val as StdioRuntime)}
                />
              </FormField>
              <FormField label="Package" required>
                <TextInput
                  placeholder={v.stdioRuntime === 'npx'
                    ? '@modelcontextprotocol/server-everything'
                    : 'mcp-server-fetch'}
                  {...form.getInputProps('stdioPackage')}
                />
              </FormField>
            </FormRow>
            <FormRow cols={1}>
              <FormField label="Arguments" optional hint="Space-separated arguments passed to the package.">
                <TextInput
                  placeholder="--flag value"
                  {...form.getInputProps('stdioArgs')}
                />
              </FormField>
            </FormRow>
            <FormRow cols={1}>
              <FormField label="Environment variables" optional hint="One KEY=value per line. Values are encrypted at rest.">
                <Textarea
                  placeholder={'API_KEY=sk-...\nBASE_URL=https://api.example.com'}
                  minRows={2}
                  autosize
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                  {...form.getInputProps('stdioEnv')}
                />
              </FormField>
            </FormRow>
            <FormField
              label="Execution mode"
              hint={sandboxAvailable
                ? 'Subprocess spawns per call (npm/uv cache keeps it fast). Sandbox runs the server persistently.'
                : sandboxUnavailableReason}
            >
              <ChipPicker<ExecutionMode>
                options={[
                  { value: 'subprocess', label: 'Stateless subprocess' },
                  { value: 'sandbox', label: sandboxAvailable ? 'Persistent sandbox' : 'Persistent sandbox (unavailable)' },
                ]}
                value={v.executionMode}
                onChange={(val) => {
                  if (val === 'sandbox' && !sandboxAvailable) return;
                  form.setFieldValue('executionMode', val as ExecutionMode);
                }}
              />
            </FormField>
            {v.executionMode === 'sandbox' ? (
              <FormRow cols={2}>
                <FormField label="CPU cores">
                  <Select
                    data={['0.5', '1', '2', '4']}
                    value={v.sandboxCpu}
                    onChange={(val) => form.setFieldValue('sandboxCpu', val ?? '1')}
                  />
                </FormField>
                <FormField label="Memory (MB)">
                  <Select
                    data={['256', '512', '1024', '2048', '4096']}
                    value={v.sandboxMemory}
                    onChange={(val) => form.setFieldValue('sandboxMemory', val ?? '512')}
                  />
                </FormField>
              </FormRow>
            ) : null}
          </>
        ) : null}
      </FormSection>

      {v.sourceType !== 'stdio' && v.sourceType !== 'internal' && v.sourceType !== 'composite' ? (
        <FormSection
          number={3}
          title="Upstream authentication"
          description="How the gateway authenticates against the upstream API or MCP server. Secrets are encrypted at rest."
          done={validAuth}
        >
          <FormField label="Authentication type">
            <ChipPicker<AuthType>
              options={[
                { value: 'none', label: 'None' },
                { value: 'token', label: 'Bearer token' },
                { value: 'header', label: 'Custom header' },
                { value: 'basic', label: 'Basic auth' },
              ]}
              value={v.authType}
              onChange={(val) => form.setFieldValue('authType', val as AuthType)}
            />
          </FormField>

          {v.authType === 'token' ? (
            <FormRow cols={1}>
              <FormField label="Bearer token" required>
                <PasswordInput
                  placeholder="sk-..."
                  {...form.getInputProps('authToken')}
                />
              </FormField>
            </FormRow>
          ) : null}

          {v.authType === 'header' ? (
            <FormRow cols={2}>
              <FormField label="Header name" required>
                <TextInput
                  placeholder="X-API-Key"
                  {...form.getInputProps('authHeaderName')}
                />
              </FormField>
              <FormField label="Header value" required>
                <PasswordInput
                  placeholder="your-api-key"
                  {...form.getInputProps('authHeaderValue')}
                />
              </FormField>
            </FormRow>
          ) : null}

          {v.authType === 'basic' ? (
            <FormRow cols={2}>
              <FormField label="Username" required>
                <TextInput
                  placeholder="admin"
                  {...form.getInputProps('authUsername')}
                />
              </FormField>
              <FormField label="Password" required>
                <PasswordInput
                  placeholder="••••••••"
                  {...form.getInputProps('authPassword')}
                />
              </FormField>
            </FormRow>
          ) : null}
        </FormSection>
      ) : null}

      <FormSection
        number={v.sourceType === 'stdio' || v.sourceType === 'internal' || v.sourceType === 'composite' ? 3 : 4}
        title="Endpoint exposure"
        description="Which protocols this server is reachable on, and how callers authenticate."
        done={validExposure}
      >
        <FormField label="Protocols" hint="At least one protocol must stay enabled.">
          <ChipPicker<string>
            multiple
            options={[
              { value: 'streamable-http', label: 'Streamable HTTP (JSON-RPC)' },
              { value: 'sse', label: 'SSE (legacy)' },
            ]}
            value={new Set([
              ...(v.protocolHttp ? ['streamable-http'] : []),
              ...(v.protocolSse ? ['sse'] : []),
            ])}
            onChange={(next) => {
              const set = next instanceof Set ? next : new Set([next]);
              form.setFieldValue('protocolHttp', set.has('streamable-http'));
              form.setFieldValue('protocolSse', set.has('sse'));
            }}
          />
        </FormField>
        {readsInternalData && v.accessMode === 'public' ? (
          <Alert color="orange" icon={<IconInfoCircle size={16} />}>
            {compositeHasInternalMember
              ? 'This composite includes an internal-service member, which reads tenant-private data.'
              : 'This is an internal-service server, which reads tenant-private data.'}
            {' '}A public URL means anyone who has it can read that data with no authentication —
            make sure that is really what you want before saving.
          </Alert>
        ) : null}
        <FormField
          label="Access mode"
          hint={v.accessMode === 'public'
            ? 'Anyone with the URL can call this server — treat it like a webhook URL.'
            : 'Callers must send a Cognipeer API token (PAT) in the Authorization header.'}
        >
          <ChipPicker<AccessMode>
            options={[
              { value: 'token', label: 'API token required' },
              { value: 'public', label: 'Public URL (no auth)' },
            ]}
            value={v.accessMode}
            onChange={(val) => form.setFieldValue('accessMode', val as AccessMode)}
          />
        </FormField>
        {v.accessMode === 'public' ? (
          <FormField
            label="Custom path"
            optional
            hint="Leave blank for a random unguessable path. Set your own to get a memorable, stable public URL — it must be unique and at least 8 characters (letters, numbers, hyphens)."
          >
            <TextInput
              placeholder="e.g. acme-support-tools"
              value={v.endpointSlug}
              onChange={(e) => form.setFieldValue('endpointSlug', e.currentTarget.value)}
            />
          </FormField>
        ) : null}
      </FormSection>

      <FormSection
        number={v.sourceType === 'stdio' || v.sourceType === 'internal' || v.sourceType === 'composite' ? 4 : 5}
        title="Guardrail"
        description="Guardrail enforcement on this server's tool calls, on the tool.pre and tool.post hooks."
        done
      >
        {capabilities && !guardrailAvailable ? (
          <Alert color="gray" icon={<IconInfoCircle size={16} />}>
            Tool-call enforcement is not wired on this deployment. The binding is saved and starts
            enforcing as soon as it is.
          </Alert>
        ) : null}
        <FormRow cols={2}>
          <FormField
            label="Mode"
            hint={v.guardrailMode === 'enforce'
              ? 'A blocking finding fails the tool call before it reaches the upstream.'
              : v.guardrailMode === 'monitor'
                ? 'Findings are recorded, but the call still runs — use this to see what would be blocked.'
                : 'No guardrail runs for this server’s tool calls.'}
          >
            <ChipPicker<GuardrailBindingMode>
              options={[
                { value: 'off', label: 'Off' },
                { value: 'monitor', label: 'Monitor' },
                { value: 'enforce', label: 'Enforce' },
              ]}
              value={v.guardrailMode}
              onChange={(val) => form.setFieldValue('guardrailMode', val as GuardrailBindingMode)}
            />
          </FormField>
          <FormField
            label="Guardrail"
            hint="The default tool guardrail is the tenant-wide one every unbound tool call already runs through."
          >
            <Select
              disabled={v.guardrailMode === 'off'}
              allowDeselect={false}
              data={[
                { value: DEFAULT_GUARDRAIL_VALUE, label: 'Default tool guardrail' },
                ...guardrails.map((g) => ({
                  value: g.key,
                  label: `${g.name}${g.enabled ? '' : ' · disabled'}${g.toolBound ? ' · tool hooks' : ''}`,
                })),
              ]}
              value={v.guardrailKey}
              onChange={(val) => form.setFieldValue('guardrailKey', val ?? DEFAULT_GUARDRAIL_VALUE)}
            />
          </FormField>
        </FormRow>
        {v.guardrailMode !== 'off' && selectedGuardrail && !selectedGuardrail.toolBound ? (
          <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
            “{selectedGuardrail.name}” has no tool.pre or tool.post hook enabled, so binding it here
            changes nothing yet. Add a tool hook to it under Dashboard → Guardrails, or bind the
            default tool guardrail instead.
          </Alert>
        ) : null}
      </FormSection>
    </FormShell>
  );
}
