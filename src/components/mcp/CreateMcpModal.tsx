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
} from '@/components/common/ui/FormShell';
import SpecImportField, { type SpecFormat } from '@/components/common/SpecImportField';
import type { McpServerView } from '@/lib/services/mcp';

interface CreateMcpModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (server: McpServerView) => void;
}

type AuthType = 'none' | 'token' | 'header' | 'basic';
type SourceType = 'openapi' | 'remote' | 'stdio';
type StdioRuntime = 'npx' | 'uvx';
type ExecutionMode = 'subprocess' | 'sandbox';
type AccessMode = 'token' | 'public';
type AegisMode = 'off' | 'monitor' | 'enforce';

interface McpCapabilities {
  stdioSubprocess: { enabled: boolean; npx: boolean; uvx: boolean };
  // `available`/`hookAvailable` fold both the enterprise build seam AND the
  // tenant's ENTERPRISE license. `seamAvailable`/`licenseEnterprise` explain WHY
  // it is off: no license (upgradeable) vs. community build (edition).
  stdioSandbox: { available: boolean; enterpriseBuild: boolean; seamAvailable?: boolean; licenseEnterprise?: boolean };
  aegis: { hookAvailable: boolean; enterpriseBuild: boolean; seamAvailable?: boolean; licenseEnterprise?: boolean };
}

interface FormValues {
  name: string;
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
  // aegis
  aegisMode: AegisMode;
  aegisShieldId: string;
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
  const [shields, setShields] = useState<Array<{ value: string; label: string }>>([]);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
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
      authType: 'none',
      authToken: '',
      authHeaderName: '',
      authHeaderValue: '',
      authUsername: '',
      authPassword: '',
      protocolHttp: true,
      protocolSse: true,
      accessMode: 'token',
      aegisMode: 'off',
      aegisShieldId: '',
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
      if (values.sourceType !== 'stdio') {
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
    // Aegis shields are enterprise; degrade silently when absent.
    fetch('/api/aegis/shields')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const list = Array.isArray(data?.shields) ? data.shields : [];
        setShields(list.map((s: { id?: string; _id?: string; name?: string; key?: string }) => ({
          value: String(s.id ?? s._id ?? s.key ?? ''),
          label: String(s.name ?? s.key ?? s.id ?? ''),
        })).filter((s: { value: string }) => s.value));
      })
      .catch(() => setShields([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const v = form.values;

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setLoading(true);
    try {
      const upstreamAuth: Record<string, string> = {
        type: v.sourceType === 'stdio' ? 'none' : v.authType,
      };
      if (v.sourceType !== 'stdio') {
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
        description: v.description || undefined,
        sourceType: v.sourceType,
        upstreamAuth,
        exposure: {
          protocols: protocols.length ? protocols : ['streamable-http', 'sse'],
          accessMode: v.accessMode,
        },
        aegis: v.aegisMode !== 'off' || v.aegisShieldId
          ? { mode: v.aegisMode, shieldId: v.aegisShieldId || undefined }
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
    if (v.sourceType === 'stdio') return true;
    if (v.authType === 'token') return Boolean(v.authToken.trim());
    if (v.authType === 'header') return Boolean(v.authHeaderName.trim() && v.authHeaderValue.trim());
    if (v.authType === 'basic') return Boolean(v.authUsername.trim() && v.authPassword.trim());
    return true;
  })();
  const validSource = useMemo(() => {
    if (v.sourceType === 'openapi') return Boolean(v.openApiSpec.trim());
    if (v.sourceType === 'remote') return Boolean(v.remoteUrl.trim());
    return Boolean(v.stdioPackage.trim());
  }, [v.sourceType, v.openApiSpec, v.remoteUrl, v.stdioPackage]);
  const validExposure = v.protocolHttp || v.protocolSse;

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
  };

  const sandboxAvailable = capabilities?.stdioSandbox.available ?? false;
  const subprocessEnabled = capabilities?.stdioSubprocess.enabled ?? true;
  const uvxAvailable = capabilities?.stdioSubprocess.uvx ?? true;
  const aegisAvailable = capabilities?.aegis.hookAvailable ?? false;
  // Distinguish "off because no ENTERPRISE license" (upgradeable on this SaaS
  // deployment) from "off because community build" (edition has no seam).
  const sandboxNeedsPlan = (capabilities?.stdioSandbox.seamAvailable ?? capabilities?.stdioSandbox.enterpriseBuild ?? false)
    && !(capabilities?.stdioSandbox.licenseEnterprise ?? false);
  const aegisNeedsPlan = (capabilities?.aegis.seamAvailable ?? capabilities?.aegis.enterpriseBuild ?? false)
    && !(capabilities?.aegis.licenseEnterprise ?? false);
  const sandboxUnavailableReason = sandboxNeedsPlan
    ? 'Persistent sandbox execution requires an active Enterprise plan. Upgrade under Dashboard → License to enable it.'
    : 'Persistent sandbox execution is part of the Enterprise edition and is not available on this deployment.';
  const aegisUnavailableReason = aegisNeedsPlan
    ? 'Aegis shield enforcement requires an active Enterprise plan. The binding is saved but stays inactive until you upgrade under Dashboard → License.'
    : 'Aegis enforcement is part of the Enterprise edition. The binding is saved and becomes active once Aegis is available.';

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
        {v.aegisMode !== 'off' ? (
          <SummaryKV label="Aegis" value={`${v.aegisMode}${v.aegisShieldId ? ' · shield' : ''}`} />
        ) : null}
      </SummaryGroup>

      {v.sourceType !== 'stdio' ? (
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
            ]}
            value={v.sourceType}
            onChange={(val) => form.setFieldValue('sourceType', val as SourceType)}
          />
        </FormField>

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

      {v.sourceType !== 'stdio' ? (
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
        number={v.sourceType === 'stdio' ? 3 : 4}
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
        <FormField
          label="Access mode"
          hint={v.accessMode === 'public'
            ? 'Anyone with the unguessable URL can call this server — treat it like a webhook URL.'
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
      </FormSection>

      <FormSection
        number={v.sourceType === 'stdio' ? 4 : 5}
        title="Aegis shield"
        description="Guardrail enforcement on tool calls (evaluated by the Aegis enforcement plane)."
        done
      >
        {capabilities && !aegisAvailable ? (
          <Alert color={aegisNeedsPlan ? 'yellow' : 'gray'} icon={<IconInfoCircle size={16} />}>
            {aegisUnavailableReason}
          </Alert>
        ) : null}
        <FormRow cols={2}>
          <FormField label="Mode">
            <ChipPicker<AegisMode>
              options={[
                { value: 'off', label: 'Off' },
                { value: 'monitor', label: 'Monitor' },
                { value: 'enforce', label: 'Enforce' },
              ]}
              value={v.aegisMode}
              onChange={(val) => form.setFieldValue('aegisMode', val as AegisMode)}
            />
          </FormField>
          <FormField label="Shield" optional>
            {shields.length > 0 ? (
              <Select
                data={shields}
                placeholder="Select a shield"
                clearable
                value={v.aegisShieldId || null}
                onChange={(val) => form.setFieldValue('aegisShieldId', val ?? '')}
              />
            ) : (
              <TextInput
                placeholder="Shield ID"
                disabled={v.aegisMode === 'off'}
                {...form.getInputProps('aegisShieldId')}
              />
            )}
          </FormField>
        </FormRow>
      </FormSection>
    </FormShell>
  );
}
