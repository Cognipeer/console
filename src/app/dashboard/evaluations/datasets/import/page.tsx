/**
 * External eval-import wizard route — full-screen FormShell overlay that
 * imports OpenAI / gateway / Bedrock / Langfuse exports as evaluation
 * datasets (mandatory PII anonymization; evaluation-only data, never billed).
 * Entry point: Evaluations → Datasets ("Import").
 */

import DatasetImportWizard from '@/components/datasetImport/DatasetImportWizard';

export default function DatasetImportPage() {
  return <DatasetImportWizard />;
}
