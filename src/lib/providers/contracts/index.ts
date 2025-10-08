import type { LooseProviderContract } from '../types';
import { DummyVectorProviderContract } from './dummyVector.contract';
import { AwsS3VectorsProviderContract } from './awsS3Vectors.contract';

export const CORE_PROVIDER_CONTRACTS: LooseProviderContract[] = [
  DummyVectorProviderContract,
  AwsS3VectorsProviderContract,
];
