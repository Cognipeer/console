import type { LooseProviderContract } from '../types';
import { DummyVectorProviderContract } from './dummyVector.contract';
import { AwsS3VectorsProviderContract } from './awsS3Vectors.contract';
import { SqliteVectorProviderContract } from './sqliteVector.contract';
import { LocalFileProviderContract } from './localFile.contract';
import { AwsS3FileProviderContract } from './awsS3Files.contract';
import { MODEL_PROVIDER_CONTRACTS } from './modelContracts';
import { ChromaVectorProviderContract } from './chromaVector.contract';
import { ChromaCloudVectorProviderContract } from './chromaCloudVector.contract';
import { ChromaLocalVectorProviderContract } from './chromaLocalVector.contract';
import { ElasticsearchVectorProviderContract } from './elasticsearchVector.contract';
import { ElasticsearchCloudVectorProviderContract } from './elasticsearchCloudVector.contract';
import { ElasticsearchSelfHostedVectorProviderContract } from './elasticsearchSelfHostedVector.contract';
import { MilvusVectorProviderContract } from './milvusVector.contract';
import { MilvusCloudVectorProviderContract } from './milvusCloudVector.contract';
import { MilvusLocalVectorProviderContract } from './milvusLocalVector.contract';
import { MongoDbVectorProviderContract } from './mongodbVector.contract';
import { OramaVectorProviderContract } from './oramaVector.contract';
import { PostgresVectorProviderContract } from './postgresVector.contract';
import { SystemDefaultVectorProviderContract } from './systemDefaultVector.contract';

export const CORE_PROVIDER_CONTRACTS = [
  DummyVectorProviderContract,
  AwsS3VectorsProviderContract,
  SqliteVectorProviderContract,
  LocalFileProviderContract,
  AwsS3FileProviderContract,
  ChromaVectorProviderContract,
  ChromaCloudVectorProviderContract,
  ChromaLocalVectorProviderContract,
  ElasticsearchVectorProviderContract,
  ElasticsearchCloudVectorProviderContract,
  ElasticsearchSelfHostedVectorProviderContract,
  MilvusVectorProviderContract,
  MilvusCloudVectorProviderContract,
  MilvusLocalVectorProviderContract,
  MongoDbVectorProviderContract,
  OramaVectorProviderContract,
  PostgresVectorProviderContract,
  SystemDefaultVectorProviderContract,
  ...MODEL_PROVIDER_CONTRACTS,
] as unknown as LooseProviderContract[];
