/**
 * Turns the bytes of a document into Markdown for the Document Store. The work (the container check, the PowerPoint
 * working-file handling and the conversion itself) lives in the shared extraction engine
 * (`services/extraction/engine`); these are the names the Document Store and its tests have always imported.
 */

import {
  convertGuarded,
  DocumentConversionRefused,
  removePowerPointWorkingFiles,
  type DocumentConversionOptions,
} from '../extraction/engine';
import type { ConvertedDocument } from '../extraction/types';

export { DocumentConversionRefused, removePowerPointWorkingFiles };
export type { ConvertedDocument, DocumentConversionOptions };

/**
 * Converts one document. Throws `DocumentConversionRefused` for a container that is over the ceilings; any other
 * failure is the converter's own.
 */
export function convertDocumentToMarkdown(
  buffer: Buffer,
  fileName: string,
  options: DocumentConversionOptions = {},
): Promise<ConvertedDocument> {
  return convertGuarded(buffer, fileName, options);
}
