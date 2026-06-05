'use client';

import { useEffect, useState } from 'react';
import {
  JsonInput,
  PasswordInput,
  Select,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconApi,
  IconPlugConnected,
  IconPlus,
  IconTool,
} from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { ToolView } from '@/lib/services/tools';

interface CreateToolModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (tool: ToolView) => void;
}

interface FormValues {
  name: string;
  description: string;
  type: 'openapi' | 'mcp';
  // OpenAPI fields
  openApiSpec: string;
  upstreamBaseUrl: string;
  // MCP fields
  mcpEndpoint: string;
  mcpTransport: 'sse' | 'streamable-http';
  // Auth (shared)
  authType: 'none' | 'token' | 'header' | 'basic';
  authToken: string;
  authHeaderName: string;
  authHeaderValue: string;
  authUsername: string;
  authPassword: string;
}

const TYPE_OPTIONS = [
  {
    value: 'openapi' as const,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <IconApi size={14} /> OpenAPI
      </span>
    ),
  },
  {
    value: 'mcp' as const,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <IconPlugConnected size={14} /> MCP server
      </span>
    ),
  },
];

const AUTH_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'token', label: 'Bearer token' },
  { value: 'header', label: 'Custom header' },
  { value: 'basic', label: 'Basic auth' },
];

export default function CreateToolModal({
  opened,
  onClose,
  onCreated,
}: CreateToolModalProps) {
  const [loading, setLoading] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      type: 'openapi',
      openApiSpec: '',
      upstreamBaseUrl: '',
      mcpEndpoint: '',
      mcpTransport: 'streamable-http',
      authType: 'none',
      authToken: '',
      authHeaderName: '',
      authHeaderValue: '',
      authUsername: '',
      authPassword: '',
    },
    validate: (values) => {
      const errors: Partial<Record<keyof FormValues, string>> = {};
      if (!values.name.trim()) errors.name = 'Name is required';
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
      if (values.type === 'openapi') {
        if (!values.openApiSpec.trim()) errors.openApiSpec = 'OpenAPI specification is required';
        else {
          try {
            JSON.parse(values.openApiSpec);
          } catch {
            errors.openApiSpec = 'Invalid JSON format';
          }
        }
      } else {
        if (!values.mcpEndpoint.trim()) errors.mcpEndpoint = 'MCP endpoint URL is required';
        else {
          try {
            new URL(values.mcpEndpoint);
          } catch {
            errors.mcpEndpoint = 'Invalid URL format';
          }
        }
      }
      return errors;
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const { values: formValues, setFieldValue } = form;

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setLoading(true);
    try {
      const values = form.getValues();
      const upstreamAuth: Record<string, string> = { type: values.authType };

      if (values.authType === 'token') {
        upstreamAuth.token = values.authToken;
      } else if (values.authType === 'header') {
        upstreamAuth.headerName = values.authHeaderName;
        upstreamAuth.headerValue = values.authHeaderValue;
      } else if (values.authType === 'basic') {
        upstreamAuth.username = values.authUsername;
        upstreamAuth.password = values.authPassword;
      }

      const body: Record<string, unknown> = {
        name: values.name,
        description: values.description || undefined,
        type: values.type,
        upstreamAuth,
      };

      if (values.type === 'openapi') {
        body.openApiSpec = values.openApiSpec;
        body.upstreamBaseUrl = values.upstreamBaseUrl || undefined;
      } else {
        body.mcpEndpoint = values.mcpEndpoint;
        body.mcpTransport = values.mcpTransport;
      }

      const res = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create tool');
      }

      const data = await res.json();
      notifications.show({
        title: 'Tool Created',
        message: `"${values.name}" is ready with ${data.tool.actions?.length ?? 0} action(s)`,
        color: 'teal',
      });
      onCreated(data.tool);
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to create tool',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  const validName = Boolean(formValues.name.trim());
  const validAuth = (() => {
    switch (formValues.authType) {
      case 'token':
        return Boolean(formValues.authToken.trim());
      case 'header':
        return Boolean(formValues.authHeaderName.trim() && formValues.authHeaderValue.trim());
      case 'basic':
        return Boolean(formValues.authUsername.trim() && formValues.authPassword.trim());
      default:
        return true;
    }
  })();

  const validSource = (() => {
    if (formValues.type === 'openapi') {
      if (!formValues.openApiSpec.trim()) return false;
      try {
        JSON.parse(formValues.openApiSpec);
        return true;
      } catch {
        return false;
      }
    }
    if (!formValues.mcpEndpoint.trim()) return false;
    try {
      new URL(formValues.mcpEndpoint);
      return true;
    } catch {
      return false;
    }
  })();

  const checklist = [
    { id: 1, label: 'Tool name provided', done: validName },
    { id: 2, label: 'Source type chosen', done: Boolean(formValues.type) },
    { id: 3, label: 'Authentication configured', done: validAuth },
    {
      id: 4,
      label:
        formValues.type === 'openapi'
          ? 'OpenAPI spec is valid JSON'
          : 'MCP endpoint URL is valid',
      done: validSource,
    },
  ];

  const canSubmit = validName && validAuth && validSource;

  const summary = (
    <>
      <SummaryGroup title="Tool">
        <SummaryKV
          label="Name"
          value={formValues.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Type"
          value={formValues.type === 'openapi' ? 'OpenAPI' : 'MCP server'}
        />
        <SummaryKV
          label="Auth"
          value={
            AUTH_OPTIONS.find((o) => o.value === formValues.authType)?.label ?? '—'
          }
        />
      </SummaryGroup>

      {formValues.type === 'openapi' ? (
        <SummaryGroup title="OpenAPI">
          <SummaryKV
            label="Base URL"
            value={
              formValues.upstreamBaseUrl || (
                <span className="ds-faint">From spec</span>
              )
            }
            mono
          />
          <SummaryKV
            label="Spec"
            value={
              formValues.openApiSpec
                ? `${formValues.openApiSpec.length} chars`
                : <span className="ds-faint">—</span>
            }
            mono
          />
        </SummaryGroup>
      ) : (
        <SummaryGroup title="MCP">
          <SummaryKV
            label="Endpoint"
            value={formValues.mcpEndpoint || <span className="ds-faint">—</span>}
            mono
          />
          <SummaryKV label="Transport" value={formValues.mcpTransport} mono />
        </SummaryGroup>
      )}

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconTool size={16} />}
      title="New tool"
      subtitle="Register an upstream API or MCP server as a callable tool."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create tool',
        icon: <IconPlus size={13} />,
        loading,
        disabled: !canSubmit,
        onClick: handleSubmit,
      }}
    >
      <FormSection
        number={1}
        title="Identity"
        description="Name and describe the tool for use across projects."
        done={validName}
      >
        <FormRow cols={1}>
          <FormField label="Name" required>
            <TextInput
              placeholder="My API tool"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="Brief description of what this tool does"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={2}
        title="Source"
        description="Where the tool's actions are discovered from."
      >
        <FormField label="Source type" required>
          <ChipPicker<'openapi' | 'mcp'>
            options={TYPE_OPTIONS}
            value={formValues.type}
            onChange={(v) => setFieldValue('type', v as 'openapi' | 'mcp')}
          />
        </FormField>
        <div className="ds-muted" style={{ fontSize: 12, marginTop: 6 }}>
          {formValues.type === 'openapi'
            ? 'Import an OpenAPI spec to automatically generate tool actions from API endpoints.'
            : 'Connect to an MCP server to discover and import available tools.'}
        </div>
      </FormSection>

      <FormSection
        number={3}
        title="Authentication"
        description="Credentials used when calling the upstream service."
        done={validAuth}
      >
        <FormRow cols={1}>
          <FormField label="Authentication">
            <Select data={AUTH_OPTIONS} {...form.getInputProps('authType')} />
          </FormField>
        </FormRow>

        {formValues.authType === 'token' && (
          <FormRow cols={1}>
            <FormField label="Bearer token" required>
              <PasswordInput
                placeholder="sk-..."
                {...form.getInputProps('authToken')}
              />
            </FormField>
          </FormRow>
        )}

        {formValues.authType === 'header' && (
          <FormRow cols={2}>
            <FormField label="Header name" required>
              <TextInput
                placeholder="X-API-Key"
                {...form.getInputProps('authHeaderName')}
              />
            </FormField>
            <FormField label="Header value" required>
              <PasswordInput
                placeholder="secret-value"
                {...form.getInputProps('authHeaderValue')}
              />
            </FormField>
          </FormRow>
        )}

        {formValues.authType === 'basic' && (
          <FormRow cols={2}>
            <FormField label="Username" required>
              <TextInput {...form.getInputProps('authUsername')} />
            </FormField>
            <FormField label="Password" required>
              <PasswordInput {...form.getInputProps('authPassword')} />
            </FormField>
          </FormRow>
        )}
      </FormSection>

      {formValues.type === 'openapi' ? (
        <FormSection
          number={4}
          title="OpenAPI specification"
          description="Paste the spec JSON and optionally override the base URL."
          done={validSource}
        >
          <FormRow cols={1}>
            <FormField
              label="Upstream base URL"
              optional
              hint="Override the base URL from the OpenAPI spec servers array."
            >
              <TextInput
                placeholder="https://api.example.com"
                {...form.getInputProps('upstreamBaseUrl')}
              />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="OpenAPI specification" required>
              <JsonInput
                placeholder='{"openapi": "3.0.0", ...}'
                minRows={10}
                maxRows={20}
                autosize
                formatOnBlur
                {...form.getInputProps('openApiSpec')}
              />
            </FormField>
          </FormRow>
        </FormSection>
      ) : (
        <FormSection
          number={4}
          title="MCP endpoint"
          description="Endpoint and transport for the MCP server."
          done={validSource}
        >
          <FormRow cols={1}>
            <FormField
              label="MCP endpoint URL"
              required
              hint="The URL of the MCP server to discover and call tools."
            >
              <TextInput
                placeholder="https://mcp-server.example.com/mcp"
                {...form.getInputProps('mcpEndpoint')}
              />
            </FormField>
          </FormRow>
          <FormRow cols={1}>
            <FormField label="Transport">
              <Select
                data={[
                  { value: 'streamable-http', label: 'Streamable HTTP (recommended)' },
                  { value: 'sse', label: 'SSE' },
                ]}
                {...form.getInputProps('mcpTransport')}
              />
            </FormField>
          </FormRow>
        </FormSection>
      )}
    </FormShell>
  );
}
