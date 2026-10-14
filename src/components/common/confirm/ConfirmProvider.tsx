'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Alert, Button, Group, Loader, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

export type ConfirmTone = 'danger' | 'warning' | 'neutral';

export interface ConfirmOptions {
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** Default 'neutral'. 'danger' puts the initial focus on Cancel. */
  tone?: ConfirmTone;
  /** Type-to-confirm: the confirm button stays disabled until this exact text is entered. */
  requireTypedText?: string;
  /** Extra content under the message (lists, usage panels...). */
  details?: ReactNode;
  /**
   * Loads more of the dialog (details, requireTypedText, tone, message...) AFTER
   * it opened: the dialog shows `prepareLabel` with a spinner and keeps confirm
   * disabled until this settles. A rejection leaves the dialog as it was, plus
   * whatever `onPrepareError` returns. Used by useDeleteResource.
   */
  prepare?: () => Promise<Partial<ConfirmOptions>>;
  prepareLabel?: ReactNode;
  onPrepareError?: (error: unknown) => Partial<ConfirmOptions>;
}

export interface ConfirmActionOptions extends ConfirmOptions {
  /**
   * Runs when the user confirms. The dialog stays open (loading) until it
   * settles; a THROWN error is shown inline and the dialog stays open so the
   * user can retry or cancel. Resolves normally = success.
   */
  action: () => Promise<void>;
}

export interface ConfirmApi {
  /** Resolves true when confirmed, false when cancelled / dismissed. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Like confirm, but runs `action` inside the dialog. Resolves true on success, false on cancel. */
  confirmAction(options: ConfirmActionOptions): Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmApi | null>(null);

/** Dialog z-index: above the full-screen FormShell overlay (250) and Mantine modals (200), below popovers (300+) it never opens itself. */
const CONFIRM_Z_INDEX = 400;

interface Request {
  options: ConfirmOptions;
  action?: () => Promise<void>;
  resolve: (value: boolean) => void;
  /** The in-flight / settled prepare() call, shared by every mount of the dialog (React StrictMode mounts effects twice). */
  prepared?: Promise<Partial<ConfirmOptions>>;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Request[]>([]);

  const enqueue = useCallback(
    (options: ConfirmOptions, action?: () => Promise<void>) =>
      new Promise<boolean>((resolve) => {
        setQueue((q) => [...q, { options, action, resolve }]);
      }),
    [],
  );

  const api = useMemo<ConfirmApi>(
    () => ({
      confirm: (options) => enqueue(options),
      confirmAction: ({ action, ...options }) => enqueue(options, action),
    }),
    [enqueue],
  );

  const current = queue[0] ?? null;
  const settle = useCallback((request: Request, result: boolean) => {
    request.resolve(result);
    setQueue((q) => q.filter((r) => r !== request));
  }, []);

  // A provider that unmounts with dialogs pending must not leave callers awaiting forever.
  const queueRef = useRef<Request[]>([]);
  queueRef.current = queue;
  useEffect(() => () => queueRef.current.forEach((r) => r.resolve(false)), []);

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      {current ? <ConfirmDialog key={queueKey(current)} request={current} onSettle={settle} /> : null}
    </ConfirmContext.Provider>
  );
}

// A stable identity per request so React remounts the dialog (resetting its state) for the next one in the queue.
const requestKeys = new WeakMap<Request, number>();
let requestCounter = 0;
function queueKey(request: Request): number {
  let key = requestKeys.get(request);
  if (key === undefined) {
    key = ++requestCounter;
    requestKeys.set(request, key);
  }
  return key;
}

/**
 * In-app replacement for window.confirm. Must be used inside <ConfirmProvider>
 * (mounted once in the root layout, so every dashboard page, enterprise ones
 * included, has it).
 */
export function useConfirm(): ConfirmApi {
  const api = useContext(ConfirmContext);
  if (!api) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return api;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function ConfirmDialog({ request, onSettle }: { request: Request; onSettle: (request: Request, result: boolean) => void }) {
  const t = useTranslations('common.confirm');
  const [extra, setExtra] = useState<Partial<ConfirmOptions>>({});
  const [preparing, setPreparing] = useState(Boolean(request.options.prepare));
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(true);

  const options: ConfirmOptions = { ...request.options, ...extra };
  const tone: ConfirmTone = options.tone ?? 'neutral';
  const { prepare, onPrepareError } = request.options;

  useEffect(() => {
    if (!prepare) return;
    let cancelled = false;
    request.prepared ??= prepare();
    request.prepared
      .then((more) => {
        if (!cancelled) setExtra(more);
      })
      .catch((err: unknown) => {
        if (!cancelled && onPrepareError) setExtra(onPrepareError(err));
      })
      .finally(() => {
        if (!cancelled) setPreparing(false);
      });
    return () => {
      cancelled = true;
    };
    // The request object is stable for the dialog's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The typed-text field only exists once prepare() settled, after the dialog's
  // initial focus (Cancel) was placed: move the focus to it then.
  const typeInputRef = useRef<HTMLInputElement>(null);
  const needsTypedText = Boolean(options.requireTypedText);
  useEffect(() => {
    if (preparing || !needsTypedText) return;
    const handle = window.setTimeout(() => typeInputRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [preparing, needsTypedText]);

  const typedOk = !options.requireTypedText || typed.trim() === options.requireTypedText.trim();
  const canConfirm = !preparing && !running && typedOk;

  const close = (result: boolean) => {
    setOpened(false);
    onSettle(request, result);
  };

  const cancel = () => {
    if (running) return;
    close(false);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canConfirm) return;
    if (!request.action) {
      close(true);
      return;
    }
    setRunning(true);
    setError(null);
    try {
      await request.action();
      close(true);
    } catch (err) {
      setError(errorMessage(err, t('actionFailed')));
      setRunning(false);
    }
  };

  const danger = tone === 'danger';
  const accent = danger ? 'var(--ds-err, #c93b3b)' : tone === 'warning' ? 'var(--ds-warn, #b7791f)' : 'var(--ds-accent, #0a9978)';
  const confirmColor = danger ? 'red' : tone === 'warning' ? 'orange' : undefined;
  const Icon = tone === 'neutral' ? IconInfoCircle : IconAlertTriangle;

  return (
    <Modal
      opened={opened}
      onClose={cancel}
      zIndex={CONFIRM_Z_INDEX}
      size="md"
      centered
      closeOnEscape={!running}
      closeOnClickOutside={false}
      withCloseButton={!running}
      trapFocus
      returnFocus
      title={
        <Group gap={8} wrap="nowrap" align="center">
          <Icon size={20} aria-hidden style={{ color: accent, flexShrink: 0 }} />
          <span style={{ fontWeight: 600 }}>{options.title}</span>
        </Group>
      }
      closeButtonProps={{ 'aria-label': String(t('close')) }}
    >
      <form onSubmit={submit}>
        <Stack gap="sm">
          <Text component="div" size="sm">{options.message}</Text>

          {preparing ? (
            <Group gap={8} role="status" aria-live="polite">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">{request.options.prepareLabel ?? t('working')}</Text>
            </Group>
          ) : null}

          {!preparing && options.details ? <div>{options.details}</div> : null}

          {!preparing && options.requireTypedText ? (
            <TextInput
              ref={typeInputRef}
              data-autofocus
              label={t('typeToConfirm', { text: options.requireTypedText })}
              placeholder={options.requireTypedText}
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              disabled={running}
              autoComplete="off"
              spellCheck={false}
            />
          ) : null}

          {error ? (
            <Alert color="red" variant="light" role="alert" icon={<IconAlertTriangle size={16} />}>
              {error}
            </Alert>
          ) : null}

          <Group justify="flex-end" gap="xs" mt="xs">
            <Button
              type="button"
              variant="default"
              onClick={cancel}
              disabled={running}
              data-autofocus={danger && !options.requireTypedText ? true : undefined}
            >
              {options.cancelLabel ?? t('cancel')}
            </Button>
            <Button
              type="submit"
              color={confirmColor}
              loading={running}
              disabled={!canConfirm}
              data-autofocus={!danger && !options.requireTypedText ? true : undefined}
            >
              {options.confirmLabel ?? t('confirm')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
