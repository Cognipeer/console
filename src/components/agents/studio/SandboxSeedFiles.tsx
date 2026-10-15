'use client';

/**
 * Sandbox → Preloaded files: files written into the sandbox when it starts
 * (a template, a data file). Each row has an editable destination path.
 * Bytes are uploaded at once (`/api/agents/:id/sandbox-seed-files`); the
 * list itself is saved with the rest of `config.sandbox`.
 */

import { useRef, useState } from 'react';
import { ActionIcon, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { IAgentSandboxSeedFile } from '@/lib/database/provider/types.domain';
import { useTranslations } from '@/lib/i18n';
import {
    SEED_MAX_FILES,
    SEED_MAX_FILE_BYTES,
    SEED_MAX_TOTAL_BYTES,
    validateSeedPath,
} from '@/lib/services/agents/agentSandboxSeedFiles';

export interface SandboxSeedFilesProps {
    agentId: string | undefined;
    value: IAgentSandboxSeedFile[] | undefined;
    onChange: (next: IAgentSandboxSeedFile[]) => void;
}

const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default function SandboxSeedFiles({ agentId, value, onChange }: SandboxSeedFilesProps) {
    const t = useTranslations('agents.sandboxSeed');
    const files = value ?? [];
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    // Uploaded in this editing session and not saved yet: removing them may delete the object.
    const fresh = useRef(new Set<string>());

    const pathError = (file: IAgentSandboxSeedFile, index: number): string | null =>
        validateSeedPath(file.path)
        ?? (files.findIndex((other) => other.path === file.path) !== index ? t('duplicatePath') : null);

    const upload = async (picked: File[]) => {
        if (!agentId || picked.length === 0) return;
        setError(null);
        setBusy(true);
        let next = [...files];
        try {
            for (const file of picked) {
                if (next.length >= SEED_MAX_FILES) { setError(t('tooMany', { max: SEED_MAX_FILES })); break; }
                if (file.size > SEED_MAX_FILE_BYTES) { setError(t('tooLarge', { name: file.name })); continue; }
                if (next.reduce((sum, f) => sum + f.size, 0) + file.size > SEED_MAX_TOTAL_BYTES) { setError(t('totalTooLarge')); break; }
                const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/sandbox-seed-files?name=${encodeURIComponent(file.name)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': file.type || 'application/octet-stream' },
                    body: file,
                });
                const body = await res.json().catch(() => ({}));
                if (!res.ok) { setError(body?.error ?? t('uploadFailed', { name: file.name })); continue; }
                const seed = body.seedFile as IAgentSandboxSeedFile;
                fresh.current.add(seed.id);
                next = [...next, seed];
            }
            onChange(next);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('uploadFailed', { name: '' }));
        } finally {
            setBusy(false);
            if (input.current) input.current.value = '';
        }
    };

    const remove = (file: IAgentSandboxSeedFile) => {
        onChange(files.filter((f) => f.id !== file.id));
        if (agentId && fresh.current.delete(file.id)) {
            const q = new URLSearchParams({ bucketKey: file.fileRef.bucketKey, objectKey: file.fileRef.objectKey });
            void fetch(`/api/agents/${encodeURIComponent(agentId)}/sandbox-seed-files?${q}`, { method: 'DELETE' }).catch(() => undefined);
        }
    };

    return (
        <Stack
            gap="sm"
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }}
            style={dragging ? { outline: '2px dashed var(--mantine-color-grape-5)', outlineOffset: 4 } : undefined}
        >
            <Text size="xs" c="dimmed">{t('description')}</Text>
            {files.map((file, index) => {
                const issue = pathError(file, index);
                return (
                    <Group key={file.id} align="flex-start" wrap="nowrap" gap="xs">
                        <TextInput
                            style={{ flex: 1 }}
                            label={index === 0 ? t('pathLabel') : undefined}
                            description={`${file.name} · ${formatSize(file.size)}`}
                            value={file.path}
                            error={issue}
                            onChange={(event) => onChange(files.map((f) => (f.id === file.id ? { ...f, path: event.currentTarget.value } : f)))}
                        />
                        <ActionIcon
                            mt={index === 0 ? 46 : 22}
                            variant="subtle"
                            color="red"
                            aria-label={t('remove')}
                            onClick={() => remove(file)}
                        >
                            <IconTrash size={16} />
                        </ActionIcon>
                    </Group>
                );
            })}
            {error ? <Text size="xs" c="red">{error}</Text> : null}
            <input ref={input} type="file" multiple hidden onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
            <Group>
                <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    loading={busy}
                    disabled={!agentId || files.length >= SEED_MAX_FILES}
                    onClick={() => input.current?.click()}
                >
                    {t('add')}
                </Button>
                <Text size="xs" c="dimmed">{t('limits')}</Text>
            </Group>
        </Stack>
    );
}
