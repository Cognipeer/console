'use client';

/**
 * Bulk import of PROGRAMMATIC users from a CSV.
 *
 * The dialog next to this one invites a teammate: someone who will sign in,
 * needs an email and gets a password. This one is for the other population —
 * the hundreds of developers who will never open the console and only need an
 * identity so their gateway usage has a name on it. Those are the same user
 * records with `canLogin: false`, which is why this creates users rather than
 * a directory of its own: groups, RBAC, projects and every report keep working
 * with no special case for "the imported ones".
 */
import { useState } from 'react';
import { Alert, Button, Group, Modal, Select, Text, Textarea } from '@mantine/core';
import { IconUpload } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';

interface ImportSummary {
  createdCount: number;
  skippedExisting: string[];
  invalid: string[];
  invalidCount: number;
}

export default function ImportUsersModal({
  opened,
  onClose,
  onSuccess,
}: {
  opened: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [csv, setCsv] = useState('');
  const [role, setRole] = useState('user');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const close = () => {
    setCsv('');
    setSummary(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/users/bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Import failed (${res.status})`);
      setSummary(data as ImportSummary);
      onSuccess();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Import failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title="Import users from a CSV" size="lg" centered>
      {summary ? (
        <>
          <Alert color="teal" title={`${summary.createdCount} users created`} mb="sm">
            They are programmatic accounts: no password, no login, and nothing was emailed.
            Add them to a group or point a gateway at them next.
          </Alert>
          {summary.skippedExisting.length > 0 ? (
            <Text size="sm" c="dimmed" mb="xs">
              {summary.skippedExisting.length} already had an account and were left alone.
            </Text>
          ) : null}
          {summary.invalidCount > 0 ? (
            <Alert color="orange" title={`${summary.invalidCount} rows could not be read`}>
              <Text size="xs" style={{ fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap' }}>
                {summary.invalid.join('\n')}
              </Text>
            </Alert>
          ) : null}
          <Group justify="flex-end" mt="md">
            <Button onClick={close}>Done</Button>
          </Group>
        </>
      ) : (
        <>
          <Text size="sm" c="dimmed" mb="sm">
            One person per line. A header is optional, and comma, semicolon or tab all work.
            Anything that cannot be read is reported back rather than dropped silently.
          </Text>
          <Textarea
            value={csv}
            onChange={(e) => setCsv(e.currentTarget.value)}
            placeholder={'email,name\nayse@firma.com,"Yılmaz, Ayşe"\nmehmet@firma.com,Mehmet Demir'}
            autosize
            minRows={9}
            maxRows={18}
            styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12.5 } }}
            data-autofocus
          />
          <Group mt="md" align="flex-end" justify="space-between">
            <Select
              label="Role"
              description="Applied to everyone in this file."
              w={220}
              data={[
                { value: 'user', label: 'User' },
                { value: 'project_admin', label: 'Project admin' },
                { value: 'admin', label: 'Admin' },
              ]}
              value={role}
              onChange={(v) => setRole(v ?? 'user')}
              allowDeselect={false}
            />
            <Group gap="sm">
              <Button variant="light" component="label" leftSection={<IconUpload size={14} />}>
                Choose file
                <input
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  hidden
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    if (file) void file.text().then(setCsv);
                  }}
                />
              </Button>
              <Button variant="subtle" onClick={close}>Cancel</Button>
              <Button color="teal" loading={busy} disabled={!csv.trim() || busy} onClick={() => void submit()}>
                Import
              </Button>
            </Group>
          </Group>
        </>
      )}
    </Modal>
  );
}
