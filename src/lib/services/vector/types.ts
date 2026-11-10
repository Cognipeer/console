import type { IVectorIndexRecord, ProviderDomain } from '@/lib/database';
import type { ProviderCapabilityFlags } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import type {
  CreateVectorIndexInput,
  VectorFilter,
  VectorQueryInput,
  VectorQueryResult,
  VectorUpsertItem,
} from '@/lib/providers';

export type VectorProviderDomain = Extract<ProviderDomain, 'vector'>;

export type VectorMetric = IVectorIndexRecord['metric'];

export type VectorIndexRecord = IVectorIndexRecord;

/**
 * An index as the API returns it. On a platform provider `externalId` is absent (the provider's own identifier of the
 * index stays with the server), and `storedBytes` and `storedVectors` carry the metered size.
 */
export type VectorIndexView = Omit<IVectorIndexRecord, 'externalId'> & { externalId?: string };

export interface CreateVectorIndexRequest
  extends Omit<CreateVectorIndexInput, 'metric' | 'dimension'> {
  providerKey: string;
  key?: string;
  /** Required when `createInProvider` is true (the default). */
  dimension?: number;
  metric?: CreateVectorIndexInput['metric'];
  metadata?: Record<string, unknown>;
  createdBy: string;
  /**
   * When false, attach an index that already exists on the provider instead
   * of calling `runtime.createIndex()`. Defaults to true. Attaching without a
   * discoverable remote match requires `dimension`, `metric` and `externalId`.
   */
  createInProvider?: boolean;
  /**
   * Provider-native identifier to attach to, for providers whose external ID
   * cannot be derived from `name` and that can't be listed to discover it
   * (e.g. read-only credentials). Ignored when `createInProvider` is true.
   */
  externalId?: string;
}

export interface UpdateVectorIndexRequest {
  name?: string;
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

interface VectorIndexLocator {
  providerKey: string;
  indexKey?: string;
  indexExternalId?: string;
}

export interface VectorUpsertRequest extends VectorIndexLocator {
  vectors: VectorUpsertItem[];
  updatedBy?: string;
}

/**
 * Query as it arrives from an API caller: `filter` is still the raw canonical
 * filter document. `queryVectorIndex` parses and capability-checks it before
 * handing the provider the parsed `VectorQueryInput`.
 */
export interface VectorQueryRequestInput extends Omit<VectorQueryInput, 'filter'> {
  filter?: VectorFilter;
}

export interface VectorQueryRequest extends VectorIndexLocator {
  query: VectorQueryRequestInput;
}

export interface VectorDeleteRequest extends VectorIndexLocator {
  ids: string[];
  updatedBy?: string;
}

export type VectorQueryResponse = VectorQueryResult;

export type VectorProviderView = ProviderConfigView & {
  driverCapabilities?: ProviderCapabilityFlags;
};
