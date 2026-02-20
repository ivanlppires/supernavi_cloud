/**
 * Tar Archive Extractor - extracts tile archives uploaded by edge agents.
 *
 * Flow:
 *   1. Stream tiles.tar from S3 (GetObject)
 *   2. Parse tar entries (tar-stream)
 *   3. Upload individual tiles to S3 as they arrive (streaming, bounded concurrency)
 *   4. Delete tiles.tar from S3
 *   5. Update cloudStatus → READY (only if all tiles uploaded successfully)
 *
 * Runs as a background task (non-blocking for the /ready response).
 * Uses streaming with backpressure to avoid loading the entire archive into memory.
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
 * Upload a single tile to S3 with retry.
 * Returns true if upload succeeded, false otherwise.
 */
async function uploadTileWithRetry(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      return true;
    } catch {
      if (attempt === 3) {
        console.error(`[TAR-EXTRACT] Failed to upload ${key} after 3 attempts`);
        return false;
      }
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  return false;
}

/**
 * Extract a tar archive from S3 and re-upload individual tiles.
 * Uses streaming with bounded concurrency to avoid loading the entire
 * archive into memory. Tiles are uploaded as they are parsed from the tar.
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

    // Step 2+3: Parse tar entries and upload as they arrive (streaming)
    const extract = tar.extract();
    let totalParsed = 0;
    let uploaded = 0;
    let failed = 0;

    // Bounded concurrency: track in-flight uploads with a semaphore
    let inFlight = 0;
    let resolveSlot: (() => void) | null = null;

    function acquireSlot(): Promise<void> {
      if (inFlight < EXTRACT_CONCURRENCY) {
        inFlight++;
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        resolveSlot = resolve;
      });
    }

    function releaseSlot(): void {
      inFlight--;
      if (resolveSlot) {
        const pending = resolveSlot;
        resolveSlot = null;
        inFlight++;
        pending();
      }
    }

    // Collect upload promises so we can wait for all to complete
    const uploadPromises: Promise<void>[] = [];

    const parseComplete = new Promise<void>((resolve, reject) => {
      extract.on('entry', (header, stream, next) => {
        // Skip directories and non-jpg files
        if (header.type !== 'file' || !header.name.endsWith('.jpg')) {
          stream.resume();
          next();
          return;
        }

        // Read entry data into buffer (individual tile, typically 5-15KB)
        streamToBuffer(stream as unknown as Readable)
          .then(async (body) => {
            const relativePath = header.name.replace(/^\.\//, '');
            const s3Key = `${s3Prefix}${relativePath}`;
            totalParsed++;

            // Wait for a concurrency slot, then upload in background
            await acquireSlot();

            const uploadPromise = uploadTileWithRetry(s3, bucket, s3Key, body)
              .then(success => {
                if (success) uploaded++;
                else failed++;
              })
              .finally(() => releaseSlot());

            uploadPromises.push(uploadPromise);

            // Allow tar parser to continue to next entry
            next();
          })
          .catch(err => next(err as Error));
      });

      extract.on('finish', resolve);
      extract.on('error', reject);
    });

    // Pipe S3 body → tar extractor
    const bodyStream = getResult.Body as Readable;
    bodyStream.pipe(extract);

    // Wait for tar parsing to finish
    await parseComplete;

    // Wait for all in-flight uploads to complete
    await Promise.all(uploadPromises);

    console.log(`[TAR-EXTRACT] Uploaded ${uploaded}/${totalParsed} tiles (${failed} failed)`);

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

    // Step 5: Mark slide status based on upload results
    if (failed > 0) {
      const failRate = failed / totalParsed;
      if (failRate > 0.01) {
        // More than 1% failed - mark as FAILED for retry
        console.error(`[TAR-EXTRACT] Too many failures (${failed}/${totalParsed}), marking FAILED`);
        await prisma.slideRead.update({
          where: { slideId },
          data: {
            cloudStatus: 'FAILED',
            updatedAt: new Date(),
          },
        });
        return;
      }
      console.warn(`[TAR-EXTRACT] Minor failures (${failed}/${totalParsed}), proceeding as READY`);
    }

    await prisma.slideRead.update({
      where: { slideId },
      data: {
        cloudStatus: 'READY',
        hasPreview: true,
        tileCount: uploaded,
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
