import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../../config/index.js';

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
  }
  return s3Client;
}

/**
 * Validates that a key is safe (no path traversal, etc.)
 */
export function isValidKey(key: string): boolean {
  // Must not be empty
  if (!key || key.trim() === '') {
    return false;
  }

  // Must not contain path traversal
  if (key.includes('..')) {
    return false;
  }

  // Must not start with /
  if (key.startsWith('/')) {
    return false;
  }

  // Must not contain null bytes or other control characters
  if (/[\x00-\x1f]/.test(key)) {
    return false;
  }

  return true;
}

/**
 * Validates that a tile key belongs to the expected prefix
 */
export function validateTileKeyAgainstPrefix(
  key: string,
  allowedPrefix: string
): boolean {
  if (!isValidKey(key)) {
    return false;
  }

  // Normalize prefix (ensure it ends without /)
  const normalizedPrefix = allowedPrefix.endsWith('/')
    ? allowedPrefix.slice(0, -1)
    : allowedPrefix;

  // Key must start with the allowed prefix
  return key.startsWith(normalizedPrefix + '/') || key.startsWith(normalizedPrefix);
}

/**
 * Extracts slide_id from a tile key like "previews/<slide_id>/tiles/..."
 */
export function extractSlideIdFromKey(key: string): string | null {
  // Expected format: previews/<slide_id>/...
  const match = key.match(/^previews\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Generates a presigned URL for a given S3 key
 */
export async function getSignedUrlForKey(
  key: string,
  expiresSeconds: number = config.SIGNED_URL_TTL_SECONDS,
  bucket: string = config.S3_BUCKET
): Promise<string> {
  if (!isValidKey(key)) {
    throw new Error(`Invalid key: ${key}`);
  }

  const client = getS3Client();
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
 */
export async function signPreviewAssetUrl(
  key: string,
  allowedPrefix: string,
  expiresSeconds: number = config.SIGNED_URL_TTL_SECONDS,
  bucket: string = config.S3_BUCKET
): Promise<string> {
  if (!validateTileKeyAgainstPrefix(key, allowedPrefix)) {
    throw new Error(`Key '${key}' is not within allowed prefix '${allowedPrefix}'`);
  }

  return getSignedUrlForKey(key, expiresSeconds, bucket);
}

export default {
  getSignedUrlForKey,
  signPreviewAssetUrl,
  isValidKey,
  validateTileKeyAgainstPrefix,
  extractSlideIdFromKey,
};
