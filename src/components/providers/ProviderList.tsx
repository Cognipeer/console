'use client';

import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  ScrollArea,
  Table,
  Text,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { IconDots, IconEdit, IconTrash, IconTable } from '@tabler/icons-react';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';

interface ProviderListProps {
  providers: ProviderConfigView[];
  loading?: boolean;
  onCreate: () => void;
  onEdit: (provider: ProviderConfigView) => void;
  onDelete: (provider: ProviderConfigView) => void;
  onManage?: (provider: ProviderConfigView) => void;
  manageLabel?: string;
}

function formatDate(value?: Date | string) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}

function renderStatus(status: ProviderConfigView['status']) {
  switch (status) {
    case 'active':
      return <Badge color="green">Active</Badge>;
    case 'disabled':
      return <Badge color="gray">Disabled</Badge>;
    case 'errored':
      return <Badge color="red">Errored</Badge>;
    default:
      return <Badge color="gray">Unknown</Badge>;
  }
}

export default function ProviderList({
  providers,
  loading,
  onCreate,
  onEdit,
  onDelete,
  onManage,
  manageLabel = 'Manage',
}: ProviderListProps) {
  return (
    <Box>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Providers</Text>
        <Button onClick={onCreate}>Add Provider</Button>
      </Group>
      <ScrollArea>
        <Table striped highlightOnHover withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: '20%' }}>Label</Table.Th>
              <Table.Th style={{ width: '15%' }}>Driver</Table.Th>
              <Table.Th style={{ width: '15%' }}>Status</Table.Th>
              <Table.Th style={{ width: '20%' }}>Created</Table.Th>
              <Table.Th style={{ width: '20%' }}>Updated</Table.Th>
              <Table.Th style={{ width: '10%' }}>
                <VisuallyHidden>
                  Actions
                </VisuallyHidden>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {providers.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Text c="dimmed" ta="center">
                    {loading ? 'Loading providers…' : 'No providers yet'}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {providers.map((provider) => (
              <Table.Tr key={provider._id as string}>
                <Table.Td>
                  <Text fw={500}>{provider.label}</Text>
                  <Text size="sm" c="dimmed">
                    {provider.key}
                  </Text>
                </Table.Td>
                <Table.Td>{provider.driver}</Table.Td>
                <Table.Td>{renderStatus(provider.status)}</Table.Td>
                <Table.Td>{formatDate(provider.createdAt)}</Table.Td>
                <Table.Td>{formatDate(provider.updatedAt)}</Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end">
                    {onManage && (
                      <Tooltip label={manageLabel}>
                        <ActionIcon
                          variant="subtle"
                          color="blue"
                          onClick={() => onManage(provider)}
                        >
                          <IconTable size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon variant="subtle" color="gray">
                          <IconDots size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconEdit size={14} />}
                          onClick={() => onEdit(provider)}
                        >
                          Edit
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconTrash size={14} />}
                          color="red"
                          onClick={() => onDelete(provider)}
                        >
                          Delete
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Box>
  );
}
