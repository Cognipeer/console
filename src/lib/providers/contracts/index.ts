import type { LooseProviderContract } from '../types';
import { DummyVectorProviderContract } from './dummyVector.contract';
import { AwsS3VectorsProviderContract } from './awsS3Vectors.contract';
import { LocalFileProviderContract } from './localFile.contract';
import { AwsS3FileProviderContract } from './awsS3Files.contract';
import { MODEL_PROVIDER_CONTRACTS } from './modelContracts';

export const CORE_PROVIDER_CONTRACTS = [
  DummyVectorProviderContract,
  AwsS3VectorsProviderContract,
  LocalFileProviderContract,
  AwsS3FileProviderContract,
  ...MODEL_PROVIDER_CONTRACTS,
] as unknown as LooseProviderContract[];
