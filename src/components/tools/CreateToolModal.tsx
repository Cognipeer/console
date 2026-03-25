'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  Group,
  JsonInput,
  Modal,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Stepper,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
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

export default function CreateToolModal({
  opened,
  onClose,
  onCreated,
}: CreateToolModalProps) {
  const [step, setStep] = useState(0);
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
      if (step === 0) {
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
        return errors;
      }
      if (step === 1) {
        const errors: Partial<Record<keyof FormValues, string>> = {};
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
      }
      return {};
    },
  });

  useEffect(() => {
    if (!opened) {
      form.reset();
      setStep(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const handleNext = () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    setStep(1);
  };

  const handleBack = () => {
    setStep(0);
  };

  const handleSubmit = async () => {
    const validation = form.validate();
    if (validation.hasErrors) return;

    setLoading(true);
    try {
      const values = form.values;
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

  const toolType = form.values.type;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="New Tool"
      centered
      size="lg"
    >
      <Stepper active={step} size="sm" mb="lg">
        <Stepper.Step label="Details" description="Name & authentication" />
        <Stepper.Step
          label={toolType === 'openapi' ? 'Specification' : 'Endpoint'}
          description={toolType === 'openapi' ? 'OpenAPI spec' : 'MCP server'}
        />
      </Stepper>

      {step === 0 && (
        <Stack gap="md">
          <TextInput
            label="Name"
            placeholder="My API Tool"
            required
            {...form.getInputProps('name')}
          />

          <Textarea
            label="Description"
            placeholder="Brief description of what this tool does"
            rows={2}
            {...form.getInputProps('description')}
          />

          <div>
            <Text size="sm" fw={500} mb={6}>
              Source Type
            </Text>
            <SegmentedControl
              fullWidth
              data={[
                { label: 'OpenAPI', value: 'openapi' },
                { label: 'MCP Server', value: 'mcp' },
              ]}
              value={form.values.type}
              onChange={(val) => form.setFieldValue('type', val as 'openapi' | 'mcp')}
            />
            <Text size="xs" c="dimmed" mt={4}>
              {toolType === 'openapi'
                ? 'Import an OpenAPI spec to automatically generate tool actions from API endpoints.'
                : 'Connect to an MCP server to discover and import available tools.'}
            </Text>
          </div>

          <Select
            label="Authentication"
            data={[
              { value: 'none', label: 'None' },
              { value: 'token', label: 'Bearer Token' },
              { value: 'header', label: 'Custom Header' },
              { value: 'basic', label: 'Basic Auth' },
            ]}
            {...form.getInputProps('authType')}
          />

          {form.values.authType === 'token' && (
            <PasswordInput
              label="Bearer Token"
              placeholder="sk-..."
              required
              {...form.getInputProps('authToken')}
            />
          )}

          {form.values.authType === 'header' && (
            <>
              <TextInput
                label="Header Name"
                placeholder="X-API-Key"
                required
                {...form.getInputProps('authHeaderName')}
              />
              <PasswordInput
                label="Header Value"
                placeholder="secret-value"
                required
                {...form.getInputProps('authHeaderValue')}
              />
            </>
          )}

          {form.values.authType === 'basic' && (
            <>
              <TextInput
                label="Username"
                required
                {...form.getInputProps('authUsername')}
              />
              <PasswordInput
                label="Password"
                required
                {...form.getInputProps('authPassword')}
              />
            </>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleNext}>
              Next
            </Button>
          </Group>
        </Stack>
      )}

      {step === 1 && toolType === 'openapi' && (
        <Stack gap="md">
          <TextInput
            label="Upstream Base URL"
            placeholder="https://api.example.com"
            description="Override the base URL from the OpenAPI spec servers array (optional)"
            {...form.getInputProps('upstreamBaseUrl')}
          />

          <JsonInput
            label="OpenAPI Specification"
            placeholder='{"openapi": "3.0.0", ...}'
            required
            minRows={10}
            maxRows={20}
            autosize
            formatOnBlur
            {...form.getInputProps('openApiSpec')}
          />

          <Group justify="space-between">
            <Button variant="default" onClick={handleBack}>
              Back
            </Button>
            <Button loading={loading} onClick={handleSubmit}>
              Create Tool
            </Button>
          </Group>
        </Stack>
      )}

      {step === 1 && toolType === 'mcp' && (
        <Stack gap="md">
          <TextInput
            label="MCP Endpoint URL"
            placeholder="https://mcp-server.example.com/mcp"
            required
            description="The URL of the MCP server to discover and call tools"
            {...form.getInputProps('mcpEndpoint')}
          />

          <Select
            label="Transport"
            data={[
              { value: 'streamable-http', label: 'Streamable HTTP (recommended)' },
              { value: 'sse', label: 'SSE' },
            ]}
            {...form.getInputProps('mcpTransport')}
          />

          <Group justify="space-between">
            <Button variant="default" onClick={handleBack}>
              Back
            </Button>
            <Button loading={loading} onClick={handleSubmit}>
              Create Tool
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
