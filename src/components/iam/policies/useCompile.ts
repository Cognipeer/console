'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  errorMessage,
  iamApi,
  isAbortError,
  type PolicySource,
  type ValidationDetail,
} from '../api';

export type CompileStatus = 'idle' | 'checking' | 'ok' | 'invalid' | 'failed';

export interface CompileState {
  status: CompileStatus;
  /** The Cedar text the server produced (spec) or echoed (raw). Empty until the first answer. */
  cedar: string;
  errors: ValidationDetail[];
  warnings: ValidationDetail[];
  /** Transport / server failure (not a Cedar error). */
  failure: string | null;
}

const IDLE: CompileState = { status: 'idle', cedar: '', errors: [], warnings: [], failure: null };

const DEBOUNCE_MS = 450;

/**
 * Live Cedar for a draft: asks `POST /policies/compile` shortly after the
 * source stops changing. `null` (a draft that is not complete enough to compile)
 * resets to idle. A newer source cancels the previous request, so a slow answer
 * can never overwrite a fresh one.
 */
export function useCompile(source: PolicySource | null): CompileState {
  const key = source ? JSON.stringify(source) : '';
  const parsed = useMemo<PolicySource | null>(() => (key ? (JSON.parse(key) as PolicySource) : null), [key]);
  const [state, setState] = useState<CompileState>(IDLE);

  useEffect(() => {
    if (!parsed) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ ...prev, status: 'checking', failure: null }));
    const timer = setTimeout(() => {
      iamApi
        .compilePolicy(parsed, controller.signal)
        .then((res) => {
          setState({
            status: res.ok ? 'ok' : 'invalid',
            cedar: res.cedar,
            errors: res.errors,
            warnings: res.warnings,
            failure: null,
          });
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) return;
          setState((prev) => ({ ...prev, status: 'failed', failure: errorMessage(err) }));
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [parsed]);

  return state;
}
