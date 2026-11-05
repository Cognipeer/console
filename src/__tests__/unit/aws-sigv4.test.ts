/**
 * The minimal AWS Signature V4 signer of the model catalog (Bedrock control-plane GETs): the AWS test-suite vector,
 * and the same requests signed by the AWS SDK's own signer (`@smithy/signature-v4`), with a query string and
 * temporary credentials.
 */
import { describe, expect, it } from 'vitest';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { awsQuery, encodeRfc3986, signAwsGetRequest } from '@/lib/services/models/catalog/awsSigV4';

const ACCESS_KEY_ID = 'AKIDEXAMPLE';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const VECTOR_DATE = new Date('2015-08-30T12:36:00Z');

/** What the AWS SDK signs for the same GET: the headers it adds and the authorization it computes. */
async function smithySign(options: {
  url: string;
  region: string;
  service: string;
  sessionToken?: string;
  applyChecksum: boolean;
  now: Date;
}): Promise<Record<string, string>> {
  const url = new URL(options.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const signer = new SignatureV4({
    service: options.service,
    region: options.region,
    sha256: Sha256,
    applyChecksum: options.applyChecksum,
    credentials: {
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
    },
  });
  const signed = await signer.sign(
    {
      method: 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query,
      headers: { host: url.host },
    },
    { signingDate: options.now },
  );
  return signed.headers as Record<string, string>;
}

describe('signAwsGetRequest', () => {
  it('matches the AWS test-suite vector "get-vanilla"', () => {
    const headers = signAwsGetRequest({
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      now: VECTOR_DATE,
    });
    expect(headers).toEqual({
      host: 'example.amazonaws.com',
      'x-amz-date': '20150830T123600Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, '
        + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    });
  });

  it('signs exactly as the AWS SDK does: a query string, temporary credentials, the payload hash header', async () => {
    const now = new Date('2026-03-04T05:06:07Z');
    const query = awsQuery({ maxResults: '1000', typeEquals: 'SYSTEM_DEFINED', nextToken: 'eyJh+b/c=d e!*' });
    const url = `https://bedrock.us-west-2.amazonaws.com/inference-profiles?${query}`;
    for (const sessionToken of [undefined, 'FwoGZXIvYXdzEJr//////////wEaDOiXsessiontoken==']) {
      for (const signContentSha256 of [false, true]) {
        const ours = signAwsGetRequest({
          url,
          region: 'us-west-2',
          service: 'bedrock',
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          sessionToken,
          now,
          signContentSha256,
        });
        const theirs = await smithySign({ url, region: 'us-west-2', service: 'bedrock', sessionToken, applyChecksum: signContentSha256, now });
        expect(ours.authorization).toBe(theirs.authorization);
        expect(ours['x-amz-date']).toBe(theirs['x-amz-date']);
        expect(ours['x-amz-security-token']).toBe(theirs['x-amz-security-token']);
        expect(ours['x-amz-content-sha256']).toBe(theirs['x-amz-content-sha256']);
        if (sessionToken) expect(ours.authorization).toMatch(/SignedHeaders=[^,]*x-amz-security-token/);
      }
    }
  });

  it('signs a plain path with no query the way the AWS SDK does', async () => {
    const now = new Date('2026-11-05T10:00:00Z');
    const url = 'https://bedrock.eu-central-1.amazonaws.com/foundation-models';
    const ours = signAwsGetRequest({
      url,
      region: 'eu-central-1',
      service: 'bedrock',
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      now,
    });
    const theirs = await smithySign({ url, region: 'eu-central-1', service: 'bedrock', applyChecksum: false, now });
    expect(ours.authorization).toBe(theirs.authorization);
  });

  it('sorts the query and encodes it per RFC 3986 whatever order the URL has it in', () => {
    const base = { region: 'us-east-1', service: 'service', accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY, now: VECTOR_DATE };
    const a = signAwsGetRequest({ ...base, url: 'https://example.amazonaws.com/?b=2&a=1' });
    const b = signAwsGetRequest({ ...base, url: 'https://example.amazonaws.com/?a=1&b=2' });
    expect(a.authorization).toBe(b.authorization);
  });
});

describe('encodeRfc3986 / awsQuery', () => {
  it('encodes everything but unreserved characters', () => {
    expect(encodeRfc3986("a b+c/d=e!'()*~-_.")).toBe('a%20b%2Bc%2Fd%3De%21%27%28%29%2A~-_.');
  });

  it('skips parameters without a value', () => {
    expect(awsQuery({ maxResults: '10', nextToken: undefined })).toBe('maxResults=10');
  });
});
