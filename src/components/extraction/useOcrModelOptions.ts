'use client';

import { useEffect, useState } from 'react';
import { modelChoices, NO_OCR_MODELS, type OcrModelOptions } from './ocrForm';

interface ModelsAnswer {
  models?: Array<{ key?: unknown; name?: unknown; isMultimodal?: unknown }>;
}

async function load(category: 'ocr' | 'llm'): Promise<ModelsAnswer> {
  const res = await fetch(`/api/models?category=${category}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ModelsAnswer;
}

/**
 * The models of the project that can read documents: OCR models, and vision LLMs (a chat model that takes images).
 * Fetched when `enabled` turns on, so a form that has OCR off asks for nothing. The two lists are loaded together;
 * if either fails the other is still offered and `failed` says the picture is incomplete.
 */
export function useOcrModelOptions(enabled = true): OcrModelOptions {
  const [options, setOptions] = useState<OcrModelOptions>(NO_OCR_MODELS);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setOptions((current) => ({ ...current, loading: true }));
    Promise.allSettled([load('ocr'), load('llm')]).then(([ocr, llm]) => {
      if (cancelled) return;
      setOptions({
        ocr: ocr.status === 'fulfilled' ? modelChoices(ocr.value.models, false) : [],
        vision: llm.status === 'fulfilled' ? modelChoices(llm.value.models, true) : [],
        loading: false,
        failed: ocr.status === 'rejected' || llm.status === 'rejected',
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return options;
}
