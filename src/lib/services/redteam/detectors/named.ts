/**
 * Named detectors: the deterministic detectors a probe definition can list by
 * key (built-in detector specs and custom probes share them).
 */

import { NAMED_DETECTOR_KEYS } from '../types';
import type { Detector, NamedDetectorKey } from '../types';
import { createAnsiEscapeDetector } from './ansiEscapeDetector';
import { createConsumptionDetector } from './consumptionDetector';
import { createEncodingLeakDetector } from './encodingLeakDetector';
import { createInsecureOutputDetector } from './insecureOutputDetector';
import { createMarkdownExfilDetector } from './markdownExfilDetector';
import { createNonRefusalDetector } from './nonRefusalDetector';
import { createPiiDetector } from './piiDetector';
import { createTagSmugglingDetector } from './tagSmugglingDetector';

export function isNamedDetectorKey(x: unknown): x is NamedDetectorKey {
  return typeof x === 'string' && (NAMED_DETECTOR_KEYS as readonly string[]).includes(x);
}

export function createNamedDetector(key: NamedDetectorKey): Detector {
  switch (key) {
    case 'pii':
      return createPiiDetector();
    case 'encoding-leak':
      return createEncodingLeakDetector();
    case 'insecure-output':
      return createInsecureOutputDetector();
    case 'markdown-exfil':
      return createMarkdownExfilDetector();
    case 'ansi-escape':
      return createAnsiEscapeDetector();
    case 'tag-smuggling':
      return createTagSmugglingDetector();
    case 'consumption':
      return createConsumptionDetector();
    case 'non-refusal':
      return createNonRefusalDetector();
  }
}
