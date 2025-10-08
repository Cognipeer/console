'use client';

import { useEffect } from 'react';
import { Button, Group, Modal, Stack, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';

interface EditVectorIndexModalProps {
  opened: boolean;
  onClose: () => void;
  initialName: string;
  initialDescription?: string;
  onSubmit: (values: { name: string; description?: string }) => Promise<void>;
}

export default function EditVectorIndexModal({
  opened,
  onClose,
  initialName,
  initialDescription,
  onSubmit,
}: EditVectorIndexModalProps) {
  const form = useForm({
    initialValues: {
      name: initialName,
      description: initialDescription ?? '',
    },
    validate: {
      name: (value) => (!value ? 'Name is required' : null),
    },
  });

  const { setValues } = form;

  useEffect(() => {
    if (opened) {
      setValues({
        name: initialName,
        description: initialDescription ?? '',
      });
    }
  }, [opened, initialName, initialDescription, setValues]);

  return (
    <Modal opened={opened} onClose={onClose} title="Edit Index" size="sm">
      <form
        onSubmit={form.onSubmit(async (values) => {
          await onSubmit({
            name: values.name,
            description: values.description || undefined,
          });
          onClose();
        })}
      >
        <Stack gap="md">
          <TextInput label="Name" required {...form.getInputProps('name')} />
          <Textarea
            label="Description"
            placeholder="Optional description"
            autosize
            minRows={2}
            {...form.getInputProps('description')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Save changes</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
