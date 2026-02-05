'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
	ActionIcon,
	Badge,
	Button,
	Center,
	Group,
	Loader,
	Paper,
	Stack,
	Table,
	Text,
	ThemeIcon,
	Title,
	Tooltip,
} from '@mantine/core';
import { IconEdit, IconEye, IconPlus, IconRefresh, IconTemplate } from '@tabler/icons-react';
import PromptEditorModal from '@/components/prompts/PromptEditorModal';
import type { PromptView } from '@/lib/services/prompts';

function formatDate(value?: string | Date) {
	if (!value) return '—';
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	return date.toLocaleString();
}

export default function PromptsPage() {
	const [prompts, setPrompts] = useState<PromptView[]>([]);
	const [loading, setLoading] = useState(true);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editingPrompt, setEditingPrompt] = useState<PromptView | null>(null);
	const router = useRouter();

	const loadPrompts = async () => {
		setLoading(true);
		try {
			const response = await fetch('/api/prompts', { cache: 'no-store' });
			if (!response.ok) {
				throw new Error('Failed to load prompts');
			}
			const data = await response.json();
			setPrompts((data.prompts ?? []) as PromptView[]);
		} catch (error) {
			console.error('Failed to load prompts', error);
			setPrompts([]);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadPrompts();
	}, []);

	const openCreateModal = () => {
		setEditingPrompt(null);
		setEditorOpen(true);
	};

	const openEditModal = (prompt: PromptView) => {
		setEditingPrompt(prompt);
		setEditorOpen(true);
	};

	const handleSaved = (saved: PromptView) => {
		setEditorOpen(false);
		setEditingPrompt(null);
		setPrompts((current) => {
			const filtered = current.filter((item) => item.id !== saved.id);
			return [saved, ...filtered];
		});
	};

	return (
		<Stack gap="lg">
			<Group justify="space-between" align="center">
				<Group gap="md">
					<ThemeIcon size={44} radius="xl" variant="light" color="teal">
						<IconTemplate size={22} />
					</ThemeIcon>
					<div>
						<Title order={2}>Prompts</Title>
						<Text size="sm" c="dimmed">
							Organize prompt templates and reusable system instructions.
						</Text>
					</div>
				</Group>
				<Group gap="sm">
					<Button
						variant="light"
						leftSection={<IconRefresh size={16} />}
						onClick={loadPrompts}
						loading={loading}
					>
						Refresh
					</Button>
					<Button leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
						Create prompt
					</Button>
				</Group>
			</Group>

			<Paper withBorder radius="lg" style={{ overflow: 'hidden' }}>
				<Table highlightOnHover verticalSpacing="md" horizontalSpacing="md">
					<Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
						<Table.Tr>
							<Table.Th style={{ fontWeight: 600 }}>Prompt</Table.Th>
							<Table.Th style={{ fontWeight: 600 }}>Key</Table.Th>
							<Table.Th style={{ fontWeight: 600 }}>Version</Table.Th>
							<Table.Th style={{ fontWeight: 600 }}>Updated</Table.Th>
							<Table.Th style={{ width: 90, textAlign: 'center', fontWeight: 600 }}>Actions</Table.Th>
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{loading ? (
							<Table.Tr>
								<Table.Td colSpan={5}>
									<Center py="xl">
										<Loader size="md" />
									</Center>
								</Table.Td>
							</Table.Tr>
						) : prompts.length === 0 ? (
							<Table.Tr>
								<Table.Td colSpan={5}>
									<Center py="xl">
										<Stack gap={4} align="center">
											<Text fw={600}>No prompts yet</Text>
											<Text size="sm" c="dimmed">Create your first prompt to get started.</Text>
											<Button variant="light" leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
												Create prompt
											</Button>
										</Stack>
									</Center>
								</Table.Td>
							</Table.Tr>
						) : (
							prompts.map((prompt) => (
								<Table.Tr
									key={prompt.id}
									style={{ cursor: 'pointer' }}
									onClick={() => router.push(`/dashboard/prompts/${prompt.id}`)}
								>
									<Table.Td>
										<Text fw={600}>{prompt.name}</Text>
										{prompt.description ? (
											<Text size="xs" c="dimmed">{prompt.description}</Text>
										) : null}
									</Table.Td>
									<Table.Td>
										<Badge variant="light" color="blue">{prompt.key}</Badge>
									</Table.Td>
									<Table.Td>v{prompt.currentVersion ?? 1}</Table.Td>
									<Table.Td>{formatDate(prompt.updatedAt ?? prompt.createdAt)}</Table.Td>
									<Table.Td onClick={(e) => e.stopPropagation()}>
										<Group gap="xs" justify="center">
											<Tooltip label="View details">
												<ActionIcon
													variant="subtle"
													onClick={() => router.push(`/dashboard/prompts/${prompt.id}`)}
												>
													<IconEye size={16} />
												</ActionIcon>
											</Tooltip>
											<Tooltip label="Edit">
												<ActionIcon
													variant="subtle"
													onClick={(e) => {
														e.stopPropagation();
														openEditModal(prompt);
													}}
												>
													<IconEdit size={16} />
												</ActionIcon>
											</Tooltip>
										</Group>
									</Table.Td>
								</Table.Tr>
							))
						)}
					</Table.Tbody>
				</Table>
			</Paper>

			<PromptEditorModal
				opened={editorOpen}
				onClose={() => setEditorOpen(false)}
				prompt={editingPrompt}
				onSaved={handleSaved}
			/>
		</Stack>
	);
}
