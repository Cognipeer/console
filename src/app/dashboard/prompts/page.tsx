'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
	ActionIcon,
	Badge,
	Button,
	Center,
	Group,
	Loader,
	Paper,
	SimpleGrid,
	Stack,
	Table,
	Text,
	ThemeIcon,
	Title,
	Tooltip,
} from '@mantine/core';
import { IconChartBar, IconEdit, IconEye, IconHistory, IconPlus, IconRefresh, IconTemplate, IconVariable } from '@tabler/icons-react';
import PromptEditorModal from '@/components/prompts/PromptEditorModal';
import type { PromptView } from '@/lib/services/prompts';

interface PromptsDashboardData {
	overview: {
		totalPrompts: number;
		totalVersions: number;
		totalVariablePrompts: number;
		avgVersionsPerPrompt: number;
	};
	recentlyUpdated: Array<{ id: string; name: string; key: string; updatedAt: string }>;
	versionDistribution: Array<{ label: string; count: number }>;
}

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
	const [dashboardData, setDashboardData] = useState<PromptsDashboardData | null>(null);
	const [dashboardLoading, setDashboardLoading] = useState(true);
	const router = useRouter();

	const loadPrompts = useCallback(async () => {
		setLoading(true);
		try {
			const response = await fetch('/api/prompts', { cache: 'no-store' });
			if (!response.ok) throw new Error('Failed to load prompts');
			const data = await response.json();
			setPrompts((data.prompts ?? []) as PromptView[]);
		} catch (error) {
			console.error('Failed to load prompts', error);
			setPrompts([]);
		} finally {
			setLoading(false);
		}
	}, []);

	const loadDashboard = useCallback(async () => {
		setDashboardLoading(true);
		try {
			const res = await fetch('/api/prompts/stats', { cache: 'no-store' });
			if (res.ok) setDashboardData(await res.json() as PromptsDashboardData);
		} catch (err) {
			console.error('Failed to load prompts dashboard', err);
		} finally {
			setDashboardLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadPrompts();
		void loadDashboard();
	}, [loadPrompts, loadDashboard]);

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

	const stalePromptCount = prompts.filter((prompt) => {
		const reference = prompt.updatedAt ?? prompt.createdAt;
		if (!reference) return false;
		const ts = new Date(reference).getTime();
		if (Number.isNaN(ts)) return false;
		return Date.now() - ts > 30 * 24 * 60 * 60 * 1000;
	}).length;

	return (
		<Stack gap="lg">
			<Group justify="space-between" align="center">
				<Group gap="md">
					<ThemeIcon size={44} radius="xl" variant="light" color="teal">
						<IconTemplate size={22} />
					</ThemeIcon>
					<div>
						<Title order={2}>Prompt Studio</Title>
						<Text size="sm" c="dimmed">
							Organize prompt templates and reusable system instructions.
						</Text>
					</div>
				</Group>
				<Group gap="sm">
					<Button
						variant="light"
						leftSection={<IconRefresh size={16} />}
						onClick={() => { void loadPrompts(); void loadDashboard(); }}
						loading={loading}
					>
						Refresh
					</Button>
					<Button leftSection={<IconPlus size={16} />} onClick={openCreateModal}>
						Create prompt
					</Button>
				</Group>
			</Group>

			{/* Stats Overview */}
			<SimpleGrid cols={{ base: 2, sm: 4 }}>
				<Paper withBorder radius="lg" p="lg">
					<Group justify="space-between">
						<Stack gap={4}>
							<Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Total Prompts</Text>
							<Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
								{dashboardLoading ? <Loader size="xs" /> : (dashboardData?.overview.totalPrompts ?? prompts.length)}
							</Text>
						</Stack>
						<ThemeIcon size={48} radius="xl" variant="light" color="teal"><IconTemplate size={24} /></ThemeIcon>
					</Group>
				</Paper>
				<Paper withBorder radius="lg" p="lg">
					<Group justify="space-between">
						<Stack gap={4}>
							<Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Total Versions</Text>
							<Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
								{dashboardLoading ? <Loader size="xs" /> : (dashboardData?.overview.totalVersions ?? '—')}
							</Text>
						</Stack>
						<ThemeIcon size={48} radius="xl" variant="light" color="indigo"><IconHistory size={24} /></ThemeIcon>
					</Group>
				</Paper>
				<Paper withBorder radius="lg" p="lg">
					<Group justify="space-between">
						<Stack gap={4}>
							<Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Variable Prompts</Text>
							<Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
								{dashboardLoading ? <Loader size="xs" /> : (dashboardData?.overview.totalVariablePrompts ?? '—')}
							</Text>
						</Stack>
						<ThemeIcon size={48} radius="xl" variant="light" color="violet"><IconVariable size={24} /></ThemeIcon>
					</Group>
				</Paper>
				<Paper withBorder radius="lg" p="lg">
					<Group justify="space-between">
						<Stack gap={4}>
							<Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Stale 30d+</Text>
							<Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
								{dashboardLoading ? <Loader size="xs" /> : stalePromptCount}
							</Text>
						</Stack>
						<ThemeIcon size={48} radius="xl" variant="light" color={stalePromptCount > 0 ? 'orange' : 'teal'}><IconChartBar size={24} /></ThemeIcon>
					</Group>
				</Paper>
			</SimpleGrid>

			{/* Analytics Panel */}
			{!dashboardLoading && dashboardData && prompts.length > 0 && (
				<SimpleGrid cols={{ base: 1, sm: 2 }}>
					{/* Recently Updated */}
					<Paper withBorder radius="lg" p="lg">
						<Group gap="sm" mb="md">
							<ThemeIcon size={28} radius="md" variant="light" color="teal"><IconRefresh size={14} /></ThemeIcon>
							<Text fw={600} size="sm">Recently Updated</Text>
						</Group>
						<Stack gap="sm">
							{dashboardData.recentlyUpdated.map((p) => (
								<Group key={p.id} justify="space-between" wrap="nowrap"
									style={{ cursor: 'pointer' }}
									onClick={() => router.push(`/dashboard/prompts/${p.id}`)}
								>
									<Stack gap={2}>
										<Text size="sm" fw={500}>{p.name}</Text>
										<Badge size="xs" variant="light" color="blue">{p.key}</Badge>
									</Stack>
									<Text size="xs" c="dimmed">{formatDate(p.updatedAt)}</Text>
								</Group>
							))}
						</Stack>
					</Paper>

					{/* Version Distribution */}
					<Paper withBorder radius="lg" p="lg">
						<Group gap="sm" mb="md">
							<ThemeIcon size={28} radius="md" variant="light" color="indigo"><IconHistory size={14} /></ThemeIcon>
							<Text fw={600} size="sm">Most Versioned Prompts</Text>
						</Group>
						<Stack gap="sm">
							{(() => {
								const max = Math.max(...dashboardData.versionDistribution.map((v) => v.count), 1);
								return dashboardData.versionDistribution.map((bucket) => (
									<div key={bucket.label}>
										<Group justify="space-between" mb={4}>
											<Text size="sm" fw={500}>{bucket.label}</Text>
											<Badge size="sm" variant="light" color="indigo">{bucket.count}</Badge>
										</Group>
										<div style={{ background: 'var(--mantine-color-gray-2)', borderRadius: 999, height: 6 }}>
											<div
												style={{
													width: `${(bucket.count / max) * 100}%`,
													height: '100%',
													borderRadius: 999,
													background: 'var(--mantine-color-indigo-5)',
												}}
											/>
										</div>
									</div>
								));
							})()}
						</Stack>
					</Paper>
				</SimpleGrid>
			)}

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
