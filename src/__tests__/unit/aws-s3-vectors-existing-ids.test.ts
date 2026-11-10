/**
 * `existingVectorIds` of the aws-s3-vectors driver: GetVectors without data or metadata, keys chunked to the API maximum.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetVectorsCommand, S3VectorsClient } from '@aws-sdk/client-s3vectors';
import { AwsS3VectorsProviderContract } from '@/lib/providers/contracts/awsS3Vectors.contract';

const ARN = 'arn:aws:s3vectors:eu-central-1:123456789012:bucket/vb/index/idx';
const handle = { externalId: ARN, name: 'idx', dimension: 3, metric: 'cosine' as const, metadata: {} };

async function runtime() {
  return AwsS3VectorsProviderContract.createRuntime({
    tenantId: 't', providerKey: 'p',
    credentials: { accessKeyId: 'k', secretAccessKey: 's' },
    settings: { region: 'eu-central-1', vectorBucketName: 'vb' },
  } as never);
}

afterEach(() => vi.restoreAllMocks());

describe('aws-s3-vectors existingVectorIds', () => {
  it('asks GetVectors for keys only, 100 at a time, and returns the keys found', async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(S3VectorsClient.prototype, 'send').mockImplementation((async (command: unknown) => {
      expect(command).toBeInstanceOf(GetVectorsCommand);
      const input = (command as GetVectorsCommand).input as { keys: string[] };
      sent.push(input as never);
      // Every key that ends in an even digit exists.
      return { vectors: input.keys.filter((key) => /[02468]$/.test(key)).map((key) => ({ key })) };
    }) as never);

    const ids = Array.from({ length: 250 }, (_, i) => `k${i}`);
    const found = await (await runtime()).existingVectorIds!(handle, ids);

    expect(sent).toHaveLength(3);
    expect(sent.map((input) => (input.keys as string[]).length)).toEqual([100, 100, 50]);
    for (const input of sent) {
      expect(input).toMatchObject({ indexArn: ARN, returnData: false, returnMetadata: false });
    }
    expect(found).toEqual(ids.filter((id) => /[02468]$/.test(id)));
  });

  it('answers nothing for no ids without calling the API', async () => {
    const send = vi.spyOn(S3VectorsClient.prototype, 'send');
    expect(await (await runtime()).existingVectorIds!(handle, [])).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
