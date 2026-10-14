'use client';

import type { ReactNode } from 'react';
import { Button, Group, Modal, Text } from '@mantine/core';

export interface ConfirmModalProps {
    opened: boolean;
    title: ReactNode;
    /** What is about to happen, in a sentence the person can decide on. */
    message: ReactNode;
    confirmLabel: string;
    cancelLabel: string;
    /** Red by default: it is for destructive actions. */
    confirmColor?: string;
    loading?: boolean;
    onConfirm: () => void;
    onClose: () => void;
}

/**
 * The app's small confirmation dialog (a destructive action asked once), in place
 * of the browser's `window.confirm`, which looks foreign, cannot be translated
 * with the page, is blocked in embedded views and cannot be driven by a test.
 * Create and edit screens stay full-screen forms; only a yes/no question is this small.
 */
export default function ConfirmModal({
    opened,
    title,
    message,
    confirmLabel,
    cancelLabel,
    confirmColor = 'red',
    loading,
    onConfirm,
    onClose,
}: ConfirmModalProps) {
    return (
        <Modal opened={opened} onClose={onClose} title={title} size="sm" centered data-testid="confirm-modal">
            <Text size="sm">{message}</Text>
            <Group justify="flex-end" gap="xs" mt="md">
                <Button variant="default" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
                <Button color={confirmColor} loading={loading} onClick={onConfirm} data-testid="confirm-modal-confirm">{confirmLabel}</Button>
            </Group>
        </Modal>
    );
}
