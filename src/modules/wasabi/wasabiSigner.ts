import { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../../config/index.js';
import {
  isValidKey,
  validateTileKeyAgainstPrefix,
  extractSlideIdFromKey,
} from './validation.js';

// Re-export validation functions
export { isValidKey, validateTileKeyAgainstPrefix, extractSlideIdFromKey };

/**
 * S3 client configuration for creating clients
 */
export interface S3ClientConfig {
  endpoint: string;
  region: string;
  bucket: string;
}

/**
 * Cache of S3 clients by endpoint+region key
 * This avoids creating new clients for each request
 */
const s3ClientCache = new Map<string, S3Client>();

/**
 * Generates a cache key for the S3 client based on endpoint and region
 */
function getClientCacheKey(endpoint: string, region: string): string {
  return `${endpoint}|${region}`;
}

/**
 * Gets or creates an S3 client for the given endpoint and region
 */
function getS3ClientForConfig(endpoint: string, region: string): S3Client {
  const cacheKey = getClientCacheKey(endpoint, region);

  let client = s3ClientCache.get(cacheKey);
  if (!client) {
    client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
    s3ClientCache.set(cacheKey, client);
  }

  return client;
}

/**
 * Generates a presigned URL for a given S3 key
 *
 * @param key - The S3 object key
 * @param expiresSeconds - URL expiration time in seconds
 * @param bucket - The S3 bucket name (defaults to global config)
 * @param clientConfig - Optional S3 client config (endpoint/region). If not provided, uses global config.
 */
export async function getSignedUrlForKey(
  key: string,
  expiresSeconds: number = config.SIGNED_URL_TTL_SECONDS,
  bucket: string = config.S3_BUCKET,
  clientConfig?: { endpoint: string; region: string }
): Promise<string> {
  if (!isValidKey(key)) {
    throw new Error(`Invalid key: ${key}`);
  }

  // Use provided config or fall back to global config
  const endpoint = clientConfig?.endpoint ?? config.S3_ENDPOINT;
  const region = clientConfig?.region ?? config.S3_REGION;

  const client = getS3ClientForConfig(endpoint, region);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const url = await getSignedUrl(client, command, {
    expiresIn: expiresSeconds,
  });

  return url;
}

/**
 * Gets a signed URL for a preview asset (thumb, manifest, or tile)
 *
 * @param key - The S3 object key
 * @param allowedPrefix - Prefix the key must start with
 * @param expiresSeconds - URL expiration time in seconds
 * @param bucket - The S3 bucket name
 * @param clientConfig - Optional S3 client config (endpoint/region)
 */
export async function signPreviewAssetUrl(
  key: string,
  allowedPrefix: string,
  expiresSeconds: number = config.SIGNED_URL_TTL_SECONDS,
  bucket: string = config.S3_BUCKET,
  clientConfig?: { endpoint: string; region: string }
): Promise<string> {
  if (!validateTileKeyAgainstPrefix(key, allowedPrefix)) {
    throw new Error(`Key '${key}' is not within allowed prefix '${allowedPrefix}'`);
  }

  return getSignedUrlForKey(key, expiresSeconds, bucket, clientConfig);
}

/**
 * Delete all preview objects for a slide from S3
 *
 * Lists all objects with prefix `previews/{slideId}/` and deletes them in batches.
 * Returns the count of deleted objects.
 */
export async function deletePreviewObjects(
  slideId: string,
  bucket: string = config.S3_BUCKET,
  clientConfig?: { endpoint: string; region: string }
): Promise<{ deleted: number }> {
  const endpoint = clientConfig?.endpoint ?? config.S3_ENDPOINT;
  const region = clientConfig?.region ?? config.S3_REGION;
  const client = getS3ClientForConfig(endpoint, region);
  const prefix = `previews/${slideId}/`;

  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listResponse = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const objects = listResponse.Contents;
    if (!objects || objects.length === 0) break;

    await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: objects.map(o => ({ Key: o.Key! })),
        Quiet: true,
      },
    }));

    deleted += objects.length;
    continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
  } while (continuationToken);

  return { deleted };
}

export default {
  getSignedUrlForKey,
  signPreviewAssetUrl,
  deletePreviewObjects,
  isValidKey,
  validateTileKeyAgainstPrefix,
  extractSlideIdFromKey,
};
