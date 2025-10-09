import type {
  IProviderRecord,
  IVectorIndexRecord,
  ProviderDomain,
} from '@/lib/database';
import type { ProviderCapabilityFlags } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import type {
  CreateVectorIndexInput,
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

export interface VectorQueryRequest extends VectorIndexLocator {
  query: VectorQueryInput;
}

export interface VectorDeleteRequest extends VectorIndexLocator {
  ids: string[];
  updatedBy?: string;
}

export type VectorQueryResponse = VectorQueryResult;

export type VectorProviderView = ProviderConfigView & {
  driverCapabilities?: ProviderCapabilityFlags;
};
