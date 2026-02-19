import { FastifyInstance } from 'fastify';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { authenticateEdgeKey } from './auth.js';
import { slideInitSchema, slideReadySchema } from './schemas.js';
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
  }, async (request, reply) => {
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

    return { slideId, labId, s3Prefix, status: 'PROCESSING' };
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

    // Verify tile_manifest.json exists in S3
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

    // Verify tile count matches expected
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
