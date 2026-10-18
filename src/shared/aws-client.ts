/**
 * AWS SDK client configuration shared by the operational CLIs.
 *
 * Emulator mode (default): any non-empty endpoint + throwaway "test" credentials,
 * with path-style S3 addressing. Real AWS mode: standard credential chain,
 * no forced endpoint (so `AWS_ENDPOINT_URL`/profile/role env vars keep working).
 */

export interface AwsClientOptions {
  endpoint?: string;
  region?: string;
}

export interface BaseClientConfig {
  endpoint?: string;
  region: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function baseClientOptions(opts: AwsClientOptions = {}): BaseClientConfig {
  const region = opts.region ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) {
    return {
      region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    };
  }
  return {
    region,
    endpoint: opts.endpoint ?? "http://localhost:4566",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  };
}

export function s3ClientOptions(opts: AwsClientOptions = {}) {
  return { ...baseClientOptions(opts), forcePathStyle: true } as const;
}
