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

export interface CreateVectorIndexRequest
  extends Omit<CreateVectorIndexInput, 'metric'> {
  providerKey: string;
  key?: string;
  metric?: CreateVectorIndexInput['metric'];
  metadata?: Record<string, unknown>;
  createdBy: string;
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
