'use client';

/**
 * "Check access": why can (or can't) this person read this document? Pick a console person and, optionally, a
 * document; the answer names the decision, the node and entry behind it, whether they administer the knowledge base,
 * and (for admins of the whole workspace) every key the person holds and the connector rules that matched them.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconInfoCircle, IconUserSearch } from '@tabler/icons-react';
import { AccessCard } from './AccessCard';
import { PrincipalIcon } from './PrincipalIcon';
import { RagSearchSelect, type RagSearchOption } from './RagSearchSelect';
import { administersText, decidedByText, describeMatch, entryPhrase, kindOf } from './principalDisplay';
import { ACCESS_TEXT } from './ragAccessText';
import { ragAccessApi, ragErrorMessage, type RagAccessExplanation } from './ragAccessApi';
import { useAccessLoad, useRagAudience, useRagFolderIndex } from './useRagAccessData';

/** Keys listed before "Show all". */
const KEYS_SHOWN = 8;

interface Inputs {
  person: RagSearchOption;
  document: RagSearchOption | null;
}

interface Result extends Inputs {
  id: number;
  explanation: RagAccessExplanation;
}

export interface RagCheckAccessProps {
  moduleKey: string;
  /** Bumped when permissions changed elsewhere: a result on screen is checked again. */
  refreshKey: number;
}

export function RagCheckAccess({ moduleKey, refreshKey }: RagCheckAccessProps) {
  const [person, setPerson] = useState<RagSearchOption | null>(null);
  const [picked, setPicked] = useState<RagSearchOption | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  /** The check that is current: an answer that arrives for an older one is dropped. */
  const current = useRef(0);
  const last = useRef<Inputs | null>(null);

  async function run(inputs: Inputs) {
    const id = ++current.current;
    last.current = inputs;
    setChecking(true);
    setProblem(null);
    try {
      const explanation = await ragAccessApi.explain(moduleKey, inputs.person.value, inputs.document?.value);
      if (id === current.current) setResult({ ...inputs, id, explanation });
    } catch (error) {
      if (id !== current.current) return;
      setResult(null);
      setProblem(ragErrorMessage(error));
    } finally {
      if (id === current.current) setChecking(false);
    }
  }

  // Permissions changed somewhere else: what is on screen may no longer be true.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (last.current) void run(last.current);
    // `run` only closes over this module's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return (
    <AccessCard icon={<IconUserSearch size={18} />} title="Check access" description={ACCESS_TEXT.checkIntro} color="blue">
      <Stack gap="md">
        <Group align="flex-end" gap="sm">
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <RagSearchSelect
              label="Person"
              placeholder="Search people by name or e-mail"
              value={person}
              onChange={setPerson}
              searchKey={moduleKey}
              nothingFound="No person found"
              clearable={false}
              search={async (query, signal) =>
                (await ragAccessApi.principals(moduleKey, 'user', query, 20, signal)).map((option) => ({
                  value: option.principal.replace(/^user:/, ''),
                  label: option.label,
                  description: option.detail,
                }))}
            />
          </div>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <RagSearchSelect
              label="Document (optional)"
              placeholder="Search documents by name"
              value={picked}
              onChange={setPicked}
              searchKey={moduleKey}
              nothingFound="No document found"
              search={async (query, signal) =>
                (await ragAccessApi.searchDocuments(moduleKey, query, 20, signal)).map((doc) => ({ value: doc._id, label: doc.fileName }))}
            />
          </div>
          <Button size="xs" disabled={!person} loading={checking} onClick={() => person && void run({ person, document: picked })}>
            Check
          </Button>
        </Group>

        {problem ? (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>{problem}</Alert>
        ) : null}
        {result ? <ExplanationView key={result.id} moduleKey={moduleKey} result={result} /> : null}
      </Stack>
    </AccessCard>
  );
}

/* ── The answer ──────────────────────────────────────────────────────────── */

function ResultRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group align="flex-start" gap="md" wrap="nowrap">
      <Text size="sm" c="dimmed" w={200} style={{ flexShrink: 0 }}>{label}</Text>
      <div style={{ flex: 1, minWidth: 0 }}>
        {typeof children === 'string' ? <Text size="sm">{children}</Text> : children}
      </div>
    </Group>
  );
}

function ExplanationView({ moduleKey, result }: { moduleKey: string; result: Result }) {
  const { explanation: x, person, document: pickedDocument } = result;
  const doc = x.document;
  const [showAllKeys, setShowAllKeys] = useState(false);

  const folders = useRagFolderIndex(moduleKey, doc?.effectiveNode.type === 'folder');
  const folderPath = doc?.effectiveNode.type === 'folder' ? folders.byId.get(doc.effectiveNode.id)?.path : undefined;

  const keys = x.principals ?? [];
  const shownKeys = showAllKeys ? keys : keys.slice(0, KEYS_SHOWN);
  const { audience } = useRagAudience(moduleKey, [...(doc?.grantedBy ?? []), ...shownKeys]);

  const matches = x.matches ?? [];
  const directories = useAccessLoad((signal) => ragAccessApi.identityDomains(signal), 'identity-domains', matches.length > 0);

  const headline = doc
    ? `${person.label} ${doc.readable ? 'can read' : 'cannot read'} ${pickedDocument?.label ?? 'this document'}`
    : person.label;

  const matchingEntry = (): ReactNode => {
    if (!doc) return null;
    if (doc.grantedBy.length > 0) {
      return (
        <Stack gap={2}>
          {doc.grantedBy.map((key) => <Text key={key} size="sm">{entryPhrase(key, undefined, audience[key])}</Text>)}
        </Stack>
      );
    }
    if (doc.openToEveryone) return 'None needed: the default access names nobody, so everyone who can open this knowledge engine reads it.';
    if (!x.enabled) return 'None needed: access control is off.';
    if (doc.readable) return x.manage && x.bypass ? 'None needed: they administer this knowledge engine and the admin exception is on.' : 'None needed.';
    return 'None of their keys is on the list.';
  };

  return (
    <Stack gap="sm" aria-live="polite">
      <Alert
        color={doc ? (doc.readable ? 'teal' : 'red') : 'blue'}
        variant="light"
        icon={doc ? (doc.readable ? <IconCircleCheck size={18} /> : <IconCircleX size={18} />) : <IconInfoCircle size={18} />}
        title={headline}
      >
        {doc ? null : ACCESS_TEXT.checkPickDocument}
      </Alert>

      {!x.enabled ? <Text size="xs" c="dimmed">{ACCESS_TEXT.checkAccessOff}</Text> : null}

      <Stack gap={8}>
        {doc ? <ResultRow label="Decided by">{decidedByText(doc.effectiveNode, folderPath)}</ResultRow> : null}
        {doc ? <ResultRow label="Matching entry">{matchingEntry()}</ResultRow> : null}
        <ResultRow label="Administers this knowledge engine">{administersText(x.manage, x.bypass)}</ResultRow>
        <ResultRow label="Account">{x.active ? 'Active' : 'Disabled'}</ResultRow>

        {x.principals ? (
          <ResultRow label={`Keys (${keys.length})`}>
            <Stack gap={4}>
              {shownKeys.map((key) => (
                <Group key={key} gap="xs" wrap="nowrap">
                  <PrincipalIcon kind={kindOf(key)} size={20} />
                  <Text size="sm">{entryPhrase(key, undefined, audience[key])}</Text>
                </Group>
              ))}
              {keys.length > KEYS_SHOWN ? (
                <div>
                  <Button size="xs" variant="subtle" onClick={() => setShowAllKeys((open) => !open)}>
                    {showAllKeys ? 'Show fewer keys' : `Show all ${keys.length} keys`}
                  </Button>
                </div>
              ) : null}
            </Stack>
          </ResultRow>
        ) : (
          <Text size="xs" c="dimmed">{ACCESS_TEXT.checkIdentityNeedsWorkspace}</Text>
        )}

        {x.matches ? (
          <ResultRow label="Matched by">
            {matches.length === 0 ? (
              <Text size="sm">{ACCESS_TEXT.checkNoMatches}</Text>
            ) : (
              <Stack gap={2}>
                {matches.map((match, index) => (
                  <Text key={`${match.domain}:${match.via}:${index}`} size="sm">
                    {describeMatch(match, directories.data?.find((item) => item.key === match.domain))}
                  </Text>
                ))}
              </Stack>
            )}
          </ResultRow>
        ) : null}
      </Stack>
    </Stack>
  );
}
