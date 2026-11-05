/**
 * Built-in model lists for drivers whose API has no "list models" route (rerank vendors, single-model decision APIs,
 * Textract's two operations), and the fallback lists shown when a live listing of Cohere, Mistral OCR, Azure Document
 * Intelligence or Vertex fails. Short on purpose: the ids the vendors document as current, each with a readable name.
 * A model that is missing here is still one "Enter a model manually" away.
 */
import type { ModelCategory } from '@/lib/database';

export interface StaticCatalogEntry {
  id: string;
  name: string;
  category: ModelCategory;
  description?: string;
}

const rerank = (id: string, name: string): StaticCatalogEntry => ({ id, name, category: 'rerank' });
const ocr = (id: string, name: string, description?: string): StaticCatalogEntry => ({
  id,
  name,
  category: 'ocr',
  ...(description ? { description } : {}),
});

const STATIC_CATALOGS: Readonly<Record<string, readonly StaticCatalogEntry[]>> = {
  'jina-ai': [
    rerank('jina-reranker-v2-base-multilingual', 'Jina Reranker v2 Base Multilingual'),
    rerank('jina-reranker-m0', 'Jina Reranker m0'),
    rerank('jina-reranker-v1-base-en', 'Jina Reranker v1 Base English'),
    rerank('jina-reranker-v1-turbo-en', 'Jina Reranker v1 Turbo English'),
    rerank('jina-reranker-v1-tiny-en', 'Jina Reranker v1 Tiny English'),
    rerank('jina-colbert-v2', 'Jina ColBERT v2'),
  ],
  'voyage-ai': [
    rerank('rerank-2.5', 'Voyage Rerank 2.5'),
    rerank('rerank-2.5-lite', 'Voyage Rerank 2.5 Lite'),
    rerank('rerank-2', 'Voyage Rerank 2'),
    rerank('rerank-2-lite', 'Voyage Rerank 2 Lite'),
    rerank('rerank-1', 'Voyage Rerank 1'),
    rerank('rerank-lite-1', 'Voyage Rerank Lite 1'),
  ],
  cohere: [
    rerank('rerank-v3.5', 'Cohere Rerank 3.5'),
    rerank('rerank-english-v3.0', 'Cohere Rerank English 3.0'),
    rerank('rerank-multilingual-v3.0', 'Cohere Rerank Multilingual 3.0'),
  ],
  'alibaba-modelstudio': [
    { id: 'decision-model-preview', name: 'Decision Model (preview)', category: 'decision' },
  ],
  typesafe: [
    { id: 'jev-latest', name: 'JEV (latest)', category: 'decision' },
  ],
  'aws-textract': [
    ocr('detect-document-text', 'Detect Document Text', 'Plain text extraction.'),
    ocr('analyze-document', 'Analyze Document', 'Text with layout, tables and forms.'),
  ],
  'azure-document-intelligence': [
    ocr('prebuilt-read', 'Read', 'Printed and handwritten text.'),
    ocr('prebuilt-layout', 'Layout', 'Text, tables, selection marks and document structure.'),
    ocr('prebuilt-invoice', 'Invoice', 'Fields of invoices.'),
    ocr('prebuilt-receipt', 'Receipt', 'Fields of sales receipts.'),
    ocr('prebuilt-idDocument', 'ID document', 'Fields of passports and identity cards.'),
  ],
  'mistral-ocr': [
    ocr('mistral-ocr-latest', 'Mistral OCR (latest)'),
  ],
  vertex: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', category: 'llm' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', category: 'llm' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', category: 'llm' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', category: 'llm' },
    { id: 'text-embedding-005', name: 'Text Embedding 005', category: 'embedding' },
    { id: 'text-multilingual-embedding-002', name: 'Text Multilingual Embedding 002', category: 'embedding' },
    { id: 'gemini-embedding-001', name: 'Gemini Embedding 001', category: 'embedding' },
  ],
};

/** The built-in list of a driver, or `undefined` when it has none. */
export function staticCatalogFor(driver: string): readonly StaticCatalogEntry[] | undefined {
  return Object.prototype.hasOwnProperty.call(STATIC_CATALOGS, driver) ? STATIC_CATALOGS[driver] : undefined;
}
