'use client';

import { Alert } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import OcrSettingsFields from '@/components/extraction/OcrSettingsFields';
import type { OcrSettings } from '@/components/extraction/ocrForm';

interface ExtractionFieldsProps {
  value: OcrSettings | undefined;
  onChange: (next: OcrSettings | undefined) => void;
}

/**
 * The "Extraction" section of the module screens: how text is read out of files that are uploaded to the module.
 * The shared OCR fields, in English like the rest of the Knowledge Engine screens, and the one thing the person
 * needs to know before relying on them.
 */
export default function ExtractionFields({ value, onChange }: ExtractionFieldsProps) {
  return (
    <>
      <OcrSettingsFields value={value} onChange={onChange} showImages english />
      <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="sm" mt="sm">
        Applies to files uploaded from now on. Re-indexing never reads a file again; use “Re-extract” on a document to
        read its stored original with the current setting.
      </Alert>
    </>
  );
}
