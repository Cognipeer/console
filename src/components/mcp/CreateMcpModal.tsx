'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  JsonInput,
  PasswordInput,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconPlug } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
} from '@/components/common/ui/FormShell';
import type { McpServerView } from '@/lib/services/mcp';

interface CreateMcpModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (server: McpServerView) => void;
}

type AuthType = 'none' | 'token' | 'header' | 'basic';

interface FormValues {
  name: string;
  description: string;
  upstreamBaseUrl: string;
  authType: AuthType;
  authToken: string;
  authHeaderName: string;
  authHeaderValue: string;
  authUsername: string;
  authPassword: string;
  openApiSpec: string;
}

export default function CreateMcpModal({
  opened,
  onClose,
  onCreated,
}: CreateMcpModalProps) {
  const [loading, setLoading] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      name: '',
      description: '',
      upstreamBaseUrl: '',
      authType: 'none',
      authToken: '',
      authHeaderName: '',
      authHeaderValue: '',
      authUsername: '',
      authPassword: '',
      openApiSpec: '',
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
      if (!values.openApiSpec.trim()) {
        errors.openApiSpec = 'OpenAPI specification is required';
      } else {
        try {
          JSON.parse(values.openApiSpec);
        } catch {
          errors.openApiSpec = 'Invalid JSON format';
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

      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description || undefined,
          openApiSpec: values.openApiSpec,
          upstreamBaseUrl: values.upstreamBaseUrl || undefined,
          upstreamAuth,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to create MCP server');
      }

      const data = await res.json();
      notifications.show({
        title: 'MCP Server Created',
        message: `"${values.name}" is ready to serve requests`,
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

  const validIdentity = Boolean(form.values.name.trim());
  const validAuth = (() => {
    const v = form.values;
    if (v.authType === 'token') return Boolean(v.authToken.trim());
    if (v.authType === 'header') return Boolean(v.authHeaderName.trim() && v.authHeaderValue.trim());
    if (v.authType === 'basic') return Boolean(v.authUsername.trim() && v.authPassword.trim());
    return true;
  })();
  const validSpec = useMemo(() => {
    const raw = form.values.openApiSpec.trim();
    if (!raw) return false;
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  }, [form.values.openApiSpec]);

  const checklist = [
    { id: 1, label: 'Name provided', done: validIdentity },
    { id: 2, label: 'Authentication configured', done: validAuth },
    { id: 3, label: 'OpenAPI spec valid JSON', done: validSpec },
  ];

  const authLabel: Record<AuthType, string> = {
    none: 'No authentication',
    token: 'Bearer token',
    header: 'Custom header',
    basic: 'Basic auth',
  };

  const summary = (
    <>
      <SummaryGroup title="Server">
        <SummaryKV
          label="Name"
          value={form.values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Base URL"
          value={
            form.values.upstreamBaseUrl || (
              <span className="ds-faint">from spec</span>
            )
          }
          mono
        />
      </SummaryGroup>

      <SummaryGroup title="Authentication">
        <SummaryKV label="Type" value={authLabel[form.values.authType]} />
        {form.values.authType === 'header' ? (
          <SummaryKV
            label="Header"
            value={form.values.authHeaderName || <span className="ds-faint">—</span>}
            mono
          />
        ) : null}
        {form.values.authType === 'basic' ? (
          <SummaryKV
            label="Username"
            value={form.values.authUsername || <span className="ds-faint">—</span>}
            mono
          />
        ) : null}
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const canSubmit = validIdentity && validAuth && validSpec;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconPlug size={16} />}
      title="New MCP server"
      subtitle="Expose an upstream API as MCP tools using its OpenAPI specification."
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
        title="Upstream connection"
        description="Where requests are forwarded and how they are authenticated."
        done={validAuth}
      >
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
        <FormField label="Authentication type">
          <ChipPicker<AuthType>
            options={[
              { value: 'none', label: 'None' },
              { value: 'token', label: 'Bearer token' },
              { value: 'header', label: 'Custom header' },
              { value: 'basic', label: 'Basic auth' },
            ]}
            value={form.values.authType}
            onChange={(v) => form.setFieldValue('authType', v as AuthType)}
          />
        </FormField>

        {form.values.authType === 'token' ? (
          <FormRow cols={1}>
            <FormField label="Bearer token" required>
              <PasswordInput
                placeholder="sk-..."
                {...form.getInputProps('authToken')}
              />
            </FormField>
          </FormRow>
        ) : null}

        {form.values.authType === 'header' ? (
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

        {form.values.authType === 'basic' ? (
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

      <FormSection
        number={3}
        title="OpenAPI specification"
        description="Paste the OpenAPI (Swagger) JSON. Paths and operations will be exposed as MCP tools automatically."
        done={validSpec}
      >
        <FormField label="Specification (JSON)" required>
          <JsonInput
            placeholder='{ "openapi": "3.0.0", "info": { ... }, "paths": { ... } }'
            minRows={12}
            maxRows={20}
            autosize
            validationError="Invalid JSON"
            formatOnBlur
            {...form.getInputProps('openApiSpec')}
          />
        </FormField>
      </FormSection>
    </FormShell>
  );
}
