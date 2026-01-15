import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../db/index.js';
import { getSignedUrlForKey, extractSlideIdFromKey } from '../wasabi/wasabiSigner.js';
import config from '../../config/index.js';
import {
  paginationSchema,
  tileSignRequestSchema,
  type CaseListResponse,
  type CaseDetail,
  type PreviewResponse,
  type TileSignResponse,
} from './schemas.js';

export async function readRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/cases
   * Returns paginated list of cases with slide counts
   */
  fastify.get('/api/v1/cases', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = paginationSchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid query parameters',
        details: parseResult.error.format(),
      });
    }

    const { limit, offset } = parseResult.data;

    try {
      const [cases, total] = await Promise.all([
        prisma.caseRead.findMany({
          take: limit,
          skip: offset,
          orderBy: { updatedAt: 'desc' },
          include: {
            _count: {
              select: { slides: true },
            },
          },
        }),
        prisma.caseRead.count(),
      ]);

      const response: CaseListResponse = {
        cases: cases.map((c) => ({
          case_id: c.caseId,
          title: c.title,
          patient_ref: c.patientRef,
          status: c.status,
          updated_at: c.updatedAt.toISOString(),
          slides_count: c._count.slides,
        })),
        total,
        limit,
        offset,
      };

      return reply.send(response);
    } catch (err) {
      request.log.error({ error: err }, 'Failed to fetch cases');
      return reply.status(500).send({ error: 'Failed to fetch cases' });
    }
  });

  /**
   * GET /api/v1/cases/:case_id
   * Returns case details with slides
   */
  fastify.get('/api/v1/cases/:case_id', async (
    request: FastifyRequest<{ Params: { case_id: string } }>,
    reply: FastifyReply
  ) => {
    const { case_id } = request.params;

    try {
      const caseData = await prisma.caseRead.findUnique({
        where: { caseId: case_id },
        include: {
          slides: {
            orderBy: { updatedAt: 'desc' },
          },
        },
      });

      if (!caseData) {
        return reply.status(404).send({ error: 'Case not found' });
      }

      const response: CaseDetail = {
        case_id: caseData.caseId,
        title: caseData.title,
        patient_ref: caseData.patientRef,
        status: caseData.status,
        created_at: caseData.createdAt.toISOString(),
        updated_at: caseData.updatedAt.toISOString(),
        slides: caseData.slides.map((s) => ({
          slide_id: s.slideId,
          svs_filename: s.svsFilename,
          width: s.width,
          height: s.height,
          mpp: s.mpp,
          scanner: s.scanner,
          has_preview: s.hasPreview,
          updated_at: s.updatedAt.toISOString(),
        })),
      };

      return reply.send(response);
    } catch (err) {
      request.log.error({ error: err }, 'Failed to fetch case');
      return reply.status(500).send({ error: 'Failed to fetch case' });
    }
  });

  /**
   * GET /api/v1/slides/:slide_id/preview
   * Returns preview info with signed URLs for thumb and manifest
   */
  fastify.get('/api/v1/slides/:slide_id/preview', async (
    request: FastifyRequest<{ Params: { slide_id: string } }>,
    reply: FastifyReply
  ) => {
    const { slide_id } = request.params;

    try {
      const previewAsset = await prisma.previewAsset.findUnique({
        where: { slideId: slide_id },
      });

      if (!previewAsset) {
        return reply.status(404).send({ error: 'Preview not found for this slide' });
      }

      // Generate signed URLs for thumb and manifest
      const [thumbUrl, manifestUrl] = await Promise.all([
        getSignedUrlForKey(
          previewAsset.thumbKey,
          config.SIGNED_URL_TTL_SECONDS,
          previewAsset.wasabiBucket
        ),
        getSignedUrlForKey(
          previewAsset.manifestKey,
          config.SIGNED_URL_TTL_SECONDS,
          previewAsset.wasabiBucket
        ),
      ]);

      const response: PreviewResponse = {
        slide_id: previewAsset.slideId,
        case_id: previewAsset.caseId,
        thumb_url: thumbUrl,
        manifest_url: manifestUrl,
        tiles: {
          strategy: 'signed-per-tile',
          max_preview_level: previewAsset.maxPreviewLevel,
          tile_size: previewAsset.tileSize,
          format: previewAsset.format,
          endpoint: '/api/v1/tiles/sign',
        },
      };

      return reply.send(response);
    } catch (err) {
      request.log.error({ error: err }, 'Failed to fetch preview');
      return reply.status(500).send({ error: 'Failed to fetch preview' });
    }
  });

  /**
   * POST /api/v1/tiles/sign
   * Signs a tile URL after validating the key belongs to a known preview
   */
  fastify.post('/api/v1/tiles/sign', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = tileSignRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parseResult.error.format(),
      });
    }

    const { key, expires_seconds } = parseResult.data;

    // Extract slide_id from key
    const slideId = extractSlideIdFromKey(key);
    if (!slideId) {
      return reply.status(403).send({
        error: 'Invalid key format - cannot determine slide_id',
      });
    }

    try {
      // Verify that we have a preview for this slide and the key is within allowed prefix
      const previewAsset = await prisma.previewAsset.findUnique({
        where: { slideId },
      });

      if (!previewAsset) {
        return reply.status(403).send({
          error: 'No preview found for this slide',
        });
      }

      // Validate the key is within the allowed prefix
      const allowedPrefixes = [
        previewAsset.wasabiPrefix,
        previewAsset.lowTilesPrefix,
        previewAsset.thumbKey.substring(0, previewAsset.thumbKey.lastIndexOf('/')),
      ];

      const isAllowed = allowedPrefixes.some((prefix) => key.startsWith(prefix));

      if (!isAllowed) {
        return reply.status(403).send({
          error: 'Key is not within allowed preview prefix',
        });
      }

      const url = await getSignedUrlForKey(
        key,
        expires_seconds,
        previewAsset.wasabiBucket
      );

      const response: TileSignResponse = { url };
      return reply.send(response);
    } catch (err) {
      request.log.error({ error: err, key }, 'Failed to sign tile URL');
      return reply.status(500).send({ error: 'Failed to sign URL' });
    }
  });
}

export default readRoutes;
