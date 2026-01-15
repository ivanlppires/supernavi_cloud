import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import config from '../../config/index.js';
import {
  isValidKey,
  validateTileKeyAgainstPrefix,
  extractSlideIdFromKey,
} from './validation.js';

// Re-export validation functions
export { isValidKey, validateTileKeyAgainstPrefix, extractSlideIdFromKey };

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
