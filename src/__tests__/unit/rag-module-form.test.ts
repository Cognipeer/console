import { describe, it, expect } from 'vitest';
import {
  buildRetrievalUpdate,
  reindexReasonFor,
  retrievalFormValues,
  type RetrievalFormValues,
} from '@/components/rag/ragModuleForm';

/**
 * The Knowledge Engine edit screen has no render harness, but everything it
 * sends is decided by these three helpers. Each case here is a save that used
 * to write a value the user never chose.
 */
describe('rag module form — retrieval update', () => {
  const storedHybrid = { enabled: true, mode: 'rrf' as const, k: 60 };

  it('reads a module with no isolateByModule as unset, not as on', () => {
    const values = retrievalFormValues({ hybrid: storedHybrid });
    expect(values.isolateByModule).toBeNull();
  });

  it('keeps an explicit false out of the null bucket', () => {
    expect(retrievalFormValues({ isolateByModule: false }).isolateByModule).toBe(false);
    expect(retrievalFormValues({ isolateByModule: true }).isolateByModule).toBe(true);
  });

  it('omits isolateByModule while it is unset, so a rename cannot turn it on', () => {
    const values = retrievalFormValues({ hybrid: storedHybrid });

    const update = buildRetrievalUpdate(values, { known: true, hybridSupported: true });

    expect(update).not.toHaveProperty('isolateByModule');
  });

  it('sends isolateByModule once the user picks one', () => {
    const values: RetrievalFormValues = {
      ...retrievalFormValues({ hybrid: storedHybrid }),
      isolateByModule: false,
    };

    expect(buildRetrievalUpdate(values, { known: true, hybridSupported: true }))
      .toMatchObject({ isolateByModule: false });

    expect(buildRetrievalUpdate({ ...values, isolateByModule: true }, { known: true, hybridSupported: true }))
      .toMatchObject({ isolateByModule: true });
  });

  it('omits hybrid until the provider capabilities are known', () => {
    // What a save looks like before the /api/vector/providers fetch resolves:
    // every provider reads as hybrid-incapable, so sending the field would
    // overwrite the stored configuration with { enabled: false }.
    const values = retrievalFormValues({ hybrid: storedHybrid, isolateByModule: true });

    const update = buildRetrievalUpdate(values, { known: false, hybridSupported: false });

    expect(update).not.toHaveProperty('hybrid');
    expect(update).toEqual({ isolateByModule: true });
  });

  it('sends the form hybrid once the provider is known to support it', () => {
    const values = retrievalFormValues({ hybrid: storedHybrid, isolateByModule: true });

    const update = buildRetrievalUpdate(values, { known: true, hybridSupported: true });

    expect(update.hybrid).toEqual({ enabled: true, mode: 'rrf', k: 60 });
  });

  it('disables hybrid for a provider that is known not to support it', () => {
    const values = retrievalFormValues({ hybrid: storedHybrid, isolateByModule: true });

    const update = buildRetrievalUpdate(values, { known: true, hybridSupported: false });

    expect(update.hybrid).toEqual({ enabled: false });
  });

  it('sends nothing at all when neither field may be decided', () => {
    const values = retrievalFormValues({ hybrid: storedHybrid });

    expect(buildRetrievalUpdate(values, { known: false, hybridSupported: false })).toEqual({});
  });
});

describe('rag module form — re-index reason', () => {
  it('names the reason the module has to be rebuilt', () => {
    expect(reindexReasonFor(true, false)).toBe('chunk-config');
    expect(reindexReasonFor(false, true)).toBe('embedding-model');
    expect(reindexReasonFor(true, true)).toBe('chunk-config');
  });

  it('is null when nothing that invalidates a vector changed', () => {
    expect(reindexReasonFor(false, false)).toBeNull();
  });
});
