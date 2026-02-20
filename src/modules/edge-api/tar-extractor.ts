/**
 * Tar Archive Extractor - extracts tile archives uploaded by edge agents.
 *
 * Flow:
 *   1. Stream tiles.tar from S3 (GetObject)
 *   2. Parse tar entries (tar-stream)
 *   3. Upload individual tiles to S3 at high concurrency (intra-region)
 *   4. Delete tiles.tar from S3
 *   5. Update cloudStatus → READY
 *
 * Runs as a background task (non-blocking for the /ready response).
 */

import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import tar from 'tar-stream';
import config from '../../config/index.js';
import { prisma } from '../../db/index.js';

const EXTRACT_CONCURRENCY = 128;

let _s3: S3Client | undefined;
function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
  }
  return _s3;
}

/**
 * Collect all data from a Readable stream into a Buffer.
 */
function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Extract a tar archive from S3 and re-upload individual tiles.
 * This function is meant to be called in the background (fire-and-forget).
 */
export async function extractTarArchive(
  slideId: string,
  s3Prefix: string,
  archiveKey: string,
): Promise<void> {
  const s3 = getS3();
  const bucket = config.S3_BUCKET;
  const startTime = Date.now();

  console.log(`[TAR-EXTRACT] Starting extraction for ${slideId.substring(0, 12)} from ${archiveKey}`);

  try {
    // Step 1: Stream tar from S3
    const getResult = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: archiveKey,
    }));

    if (!getResult.Body) {
      throw new Error('Empty response body from S3');
    }

    // Step 2: Parse tar and collect entries
    const extract = tar.extract();
    const uploadQueue: { key: string; body: Buffer }[] = [];

    const parseComplete = new Promise<void>((resolve, reject) => {
      extract.on('entry', async (header, stream, next) => {
        try {
          // Skip directories and non-jpg files
          if (header.type !== 'file' || !header.name.endsWith('.jpg')) {
            stream.resume();
            next();
            return;
          }

          const body = await streamToBuffer(stream as unknown as Readable);

          // Convert tar path: ./14/3_2.jpg → {s3Prefix}14/3_2.jpg
          const relativePath = header.name.replace(/^\.\//, '');
          const s3Key = `${s3Prefix}${relativePath}`;

          uploadQueue.push({ key: s3Key, body });
          next();
        } catch (err) {
          next(err as Error);
        }
      });

      extract.on('finish', resolve);
      extract.on('error', reject);
    });

    // Pipe S3 body → tar extractor
    const bodyStream = getResult.Body as Readable;
    bodyStream.pipe(extract);

    await parseComplete;

    console.log(`[TAR-EXTRACT] Parsed ${uploadQueue.length} tiles from archive, uploading...`);

    // Step 3: Upload individual tiles at high concurrency
    let uploaded = 0;
    let index = 0;

    async function worker() {
      while (index < uploadQueue.length) {
        const i = index++;
        const { key, body } = uploadQueue[i];

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await s3.send(new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: body,
              ContentType: 'image/jpeg',
              CacheControl: 'public, max-age=31536000, immutable',
            }));
            uploaded++;
            break;
          } catch (err) {
            if (attempt === 3) {
              console.error(`[TAR-EXTRACT] Failed to upload ${key} after 3 attempts`);
            } else {
              await new Promise(r => setTimeout(r, 500 * attempt));
            }
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: EXTRACT_CONCURRENCY }, worker),
    );

    console.log(`[TAR-EXTRACT] Uploaded ${uploaded}/${uploadQueue.length} tiles`);

    // Step 4: Delete tar archive from S3
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: bucket,
        Key: archiveKey,
      }));
      console.log(`[TAR-EXTRACT] Deleted archive ${archiveKey}`);
    } catch (err) {
      console.warn(`[TAR-EXTRACT] Failed to delete archive (non-fatal): ${(err as Error).message}`);
    }

    // Step 5: Mark slide as READY
    await prisma.slideRead.update({
      where: { slideId },
      data: {
        cloudStatus: 'READY',
        hasPreview: true,
        updatedAt: new Date(),
      },
    });

    const elapsed = Date.now() - startTime;
    console.log(`[TAR-EXTRACT] Complete for ${slideId.substring(0, 12)}: ${uploaded} tiles in ${(elapsed / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`[TAR-EXTRACT] Failed for ${slideId.substring(0, 12)}: ${(err as Error).message}`);

    // Mark as failed so edge can retry
    await prisma.slideRead.update({
      where: { slideId },
      data: {
        cloudStatus: 'FAILED',
        updatedAt: new Date(),
      },
    }).catch(() => {});
  }
}
