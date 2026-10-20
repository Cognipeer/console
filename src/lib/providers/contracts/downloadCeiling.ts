import { constants } from 'node:buffer';
import type { DownloadFileOptions } from '../domains/file';
import { maxStorageDownloadBytes } from './storageLimits';

/**
 * The most bytes one `downloadFile` call reads into memory: the bound the caller states (`options.maxBytes`), or the
 * server-wide ceiling (`maxStorageDownloadBytes`) when it states none. Only a positive number is a bound (zero, a
 * negative number, `NaN` and anything that is not a number are ignored), and none goes beyond what one Buffer can
 * hold, so `Infinity` means "as much as fits" and an object past that is refused instead of failing half-way.
 */
export function resolveDownloadCeiling(options?: DownloadFileOptions): number {
  const asked: unknown = options?.maxBytes;
  if (typeof asked === 'number' && asked > 0) return Math.min(asked, constants.MAX_LENGTH);
  return maxStorageDownloadBytes();
}
