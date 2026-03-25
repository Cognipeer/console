'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Group, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';

interface UpsertVectorItemModalProps {
  opened: boolean;
  onClose: () => void;
  expectedDimension?: number;
  onSubmit: (payload: { id: string; values: number[]; metadata?: Record<string, unknown> }) => Promise<void>;
}

interface FormValues {
  id: string;
  vector: string;
  metadata: string;
}

export default function UpsertVectorItemModal({
  opened,
  onClose,
  expectedDimension,
  onSubmit,
}: UpsertVectorItemModalProps) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const form = useForm<FormValues>({
    initialValues: {
      id: '',
      vector: '',
      metadata: '',
    },
    validate: {
      id: (value) => (!value ? 'Item ID is required' : null),
      vector: (value) => (!value ? 'Vector values are required' : null),
    },
  });
  const { reset } = form;
  const wasOpenedRef = useRef(false);

  useEffect(() => {
    if (!opened) {
      if (wasOpenedRef.current) {
        reset();
        setErrorMessage(null);
        wasOpenedRef.current = false;
      }
      return;
    }

    wasOpenedRef.current = true;
  }, [opened, reset]);

  const handleSubmit = form.onSubmit(async (values) => {
    setErrorMessage(null);
    try {
      const parsedValues = values.vector
        .split(',')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0)
        .map((segment) => Number(segment));

      if (parsedValues.length === 0 || parsedValues.some((number) => Number.isNaN(number))) {
        throw new Error('Vector must contain numeric values separated by commas.');
      }

      if (expectedDimension && parsedValues.length !== expectedDimension) {
        throw new Error(`Vector must contain exactly ${expectedDimension} values.`);
      }

      let metadata: Record<string, unknown> | undefined;
      if (values.metadata) {
        metadata = JSON.parse(values.metadata) as Record<string, unknown>;
      }

      await onSubmit({
        id: values.id,
        values: parsedValues,
        metadata,
      });
      onClose();
    } catch (error) {
      console.error(error);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to parse input');
    }
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Add vector item" size="md">
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          <TextInput label="Item ID" placeholder="Document or chunk identifier" required {...form.getInputProps('id')} />
          <Textarea
            label="Vector values"
            placeholder="1.23, 4.56, ..."
            description={expectedDimension ? `Provide ${expectedDimension} values separated by commas.` : 'Provide comma-separated numeric values.'}
            minRows={3}
            autosize
            required
            {...form.getInputProps('vector')}
          />
          <Textarea
            label="Metadata (JSON)"
            placeholder='{ "title": "Document name" }'
            minRows={2}
            autosize
            {...form.getInputProps('metadata')}
          />
          {errorMessage && (
            <Text size="sm" c="red.6">
              {errorMessage}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Upsert item</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
