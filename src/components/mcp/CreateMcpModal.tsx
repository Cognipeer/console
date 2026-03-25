'use client';

import { useEffect, useState } from 'react';
import {
  Button,
  Group,
  JsonInput,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Stepper,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import type { McpServerView } from '@/lib/services/mcp';

interface CreateMcpModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (server: McpServerView) => void;
}

interface FormValues {
  name: string;
  description: string;
  upstreamBaseUrl: string;
  authType: 'none' | 'token' | 'header' | 'basic';
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
  const [step, setStep] = useState(0);
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
        if (!values.openApiSpec.trim()) errors.openApiSpec = 'OpenAPI specification is required';
        else {
          try {
            JSON.parse(values.openApiSpec);
          } catch {
            errors.openApiSpec = 'Invalid JSON format';
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

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="New MCP Server"
      centered
      size="lg"
    >
      <Stepper
        active={step}
        size="sm"
        mb="lg"
      >
        <Stepper.Step label="Details" description="Name & authentication" />
        <Stepper.Step label="Specification" description="OpenAPI spec" />
      </Stepper>

      {step === 0 && (
        <Stack gap="md">
          <TextInput
            label="Name"
            placeholder="My API Service"
            required
            {...form.getInputProps('name')}
          />

          <Textarea
            label="Description"
            placeholder="Brief description of what this MCP server does"
            rows={2}
            {...form.getInputProps('description')}
          />

          <TextInput
            label="Upstream Base URL"
            placeholder="https://api.example.com"
            description="Override the server URL from the OpenAPI spec (optional)"
            {...form.getInputProps('upstreamBaseUrl')}
          />

          <Select
            label="Authentication Type"
            description="How to authenticate with the upstream API"
            data={[
              { value: 'none', label: 'No authentication' },
              { value: 'token', label: 'Bearer Token' },
              { value: 'header', label: 'Custom Header' },
              { value: 'basic', label: 'Basic Auth (username/password)' },
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
                placeholder="your-api-key"
                required
                {...form.getInputProps('authHeaderValue')}
              />
            </>
          )}

          {form.values.authType === 'basic' && (
            <>
              <TextInput
                label="Username"
                placeholder="admin"
                required
                {...form.getInputProps('authUsername')}
              />
              <PasswordInput
                label="Password"
                placeholder="••••••••"
                required
                {...form.getInputProps('authPassword')}
              />
            </>
          )}

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleNext}>
              Next
            </Button>
          </Group>
        </Stack>
      )}

      {step === 1 && (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Paste the OpenAPI (Swagger) specification in JSON format. All paths
            and operations will be extracted as MCP tools automatically.
          </Text>

          <JsonInput
            label="OpenAPI Specification"
            placeholder='{ "openapi": "3.0.0", "info": { ... }, "paths": { ... } }'
            required
            minRows={12}
            maxRows={20}
            autosize
            validationError="Invalid JSON"
            formatOnBlur
            {...form.getInputProps('openApiSpec')}
          />

          <Group justify="space-between" mt="md">
            <Button variant="default" onClick={handleBack}>
              Back
            </Button>
            <Button loading={loading} onClick={handleSubmit}>
              Create Server
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
