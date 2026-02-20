import { FastifyInstance } from 'fastify';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { authenticateEdgeKey } from './auth.js';
import { slideInitSchema, slideReadySchema } from './schemas.js';
import { extractTarArchive } from './tar-extractor.js';
import { prisma } from '../../db/index.js';
import config from '../../config/index.js';

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

export async function edgeApiRoutes(fastify: FastifyInstance) {
  // POST /edge/slides/init
  // Edge calls this before uploading tiles. Returns the S3 prefix to upload to.
  fastify.post('/edge/slides/init', {
    preHandler: authenticateEdgeKey,
  }, async (request, _reply) => {
    const body = slideInitSchema.parse(request.body);
    const labId = (request as any).labId as string;
    const slideId = body.sha256;
    const s3Prefix = `labs/${labId}/slides/${slideId}/dzi/`;

    // Idempotent: if already READY, return existing data
    const existing = await prisma.slideRead.findUnique({ where: { slideId } });
    if (existing?.cloudStatus === 'READY') {
      return {
        slideId,
        labId,
        s3Prefix: existing.s3Prefix,
        status: 'READY',
        alreadyReady: true,
        supportedUploadModes: ['tar', 'individual'],
      };
    }

    await prisma.slideRead.upsert({
      where: { slideId },
      create: {
        slideId,
        labId,
        svsFilename: body.filename,
        width: body.width,
        height: body.height,
        mpp: body.mpp ?? 0,
        scanner: body.scanner,
        cloudStatus: 'UPLOADED',
        tileCount: body.expectedTileCount,
        s3Prefix,
        updatedAt: new Date(),
      },
      update: {
        labId,
        svsFilename: body.filename,
        width: body.width,
        height: body.height,
        mpp: body.mpp ?? 0,
        scanner: body.scanner,
        cloudStatus: 'PROCESSING',
        tileCount: body.expectedTileCount,
        s3Prefix,
        updatedAt: new Date(),
      },
    });

    return { slideId, labId, s3Prefix, status: 'PROCESSING', supportedUploadModes: ['tar', 'individual'] };
  });

  // POST /edge/slides/:slideId/ready
  // Edge calls this after uploading all tiles + tile_manifest.json.
  // Cloud verifies manifest exists, tile count matches, then marks READY.
  fastify.post<{ Params: { slideId: string } }>('/edge/slides/:slideId/ready', {
    preHandler: authenticateEdgeKey,
  }, async (request, reply) => {
    const { slideId } = request.params;
    const body = slideReadySchema.parse(request.body);
    const labId = (request as any).labId as string;

    const slide = await prisma.slideRead.findUnique({ where: { slideId } });
    if (!slide) {
      return reply.code(404).send({ error: 'Slide not found' });
    }
    if (slide.labId !== labId) {
      return reply.code(403).send({ error: 'Slide does not belong to this lab' });
    }

    // Tar archive mode: edge uploaded a single tar file, cloud extracts in background
    if (body.archive && body.archiveKey) {
      // Verify tar archive exists in S3
      try {
        await getS3().send(new HeadObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: body.archiveKey,
        }));
      } catch {
        return reply.code(409).send({
          error: 'tiles.tar not found in S3',
          archiveKey: body.archiveKey,
        });
      }

      // Mark as EXTRACTING and start background extraction
      await prisma.slideRead.update({
        where: { slideId },
        data: {
          cloudStatus: 'EXTRACTING',
          tileCount: body.tileCount,
          updatedAt: new Date(),
        },
      });

      // Fire-and-forget: extract tiles in background
      extractTarArchive(slideId, slide.s3Prefix!, body.archiveKey).catch(err => {
        console.error(`[TAR-EXTRACT] Background extraction failed for ${slideId.substring(0, 12)}: ${err.message}`);
      });

      return { ok: true, status: 'EXTRACTING', slideId };
    }

    // Individual tile mode: verify manifest and tile count
    const manifestKey = `${slide.s3Prefix}tile_manifest.json`;
    try {
      await getS3().send(new HeadObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: manifestKey,
      }));
    } catch {
      return reply.code(409).send({
        error: 'tile_manifest.json not found in S3',
        s3Prefix: slide.s3Prefix,
      });
    }

    if (slide.tileCount && body.tileCount !== slide.tileCount) {
      return reply.code(409).send({
        error: `Tile count mismatch: expected ${slide.tileCount}, got ${body.tileCount}`,
      });
    }

    await prisma.slideRead.update({
      where: { slideId },
      data: {
        cloudStatus: 'READY',
        hasPreview: true,
        tileCount: body.tileCount,
        updatedAt: new Date(),
      },
    });

    return { ok: true, status: 'READY', slideId };
  });
}
