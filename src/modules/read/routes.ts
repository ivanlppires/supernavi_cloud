import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../db/index.js';
import { getSignedUrlForKey, extractSlideIdFromKey } from '../wasabi/wasabiSigner.js';
import config from '../../config/index.js';
import { authenticate } from '../auth/routes.js';
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

      // Generate signed URLs for thumb and manifest using previewAsset's endpoint/region
      const clientConfig = {
        endpoint: previewAsset.wasabiEndpoint,
        region: previewAsset.wasabiRegion,
      };

      const [thumbUrl, manifestUrl] = await Promise.all([
        getSignedUrlForKey(
          previewAsset.thumbKey,
          config.SIGNED_URL_TTL_SECONDS,
          previewAsset.wasabiBucket,
          clientConfig
        ),
        getSignedUrlForKey(
          previewAsset.manifestKey,
          config.SIGNED_URL_TTL_SECONDS,
          previewAsset.wasabiBucket,
          clientConfig
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

      // Use previewAsset's endpoint/region for signing
      const clientConfig = {
        endpoint: previewAsset.wasabiEndpoint,
        region: previewAsset.wasabiRegion,
      };

      const url = await getSignedUrlForKey(
        key,
        expires_seconds,
        previewAsset.wasabiBucket,
        clientConfig
      );

      request.log.info({
        slide_id: slideId,
        key,
        endpoint: previewAsset.wasabiEndpoint,
        region: previewAsset.wasabiRegion,
        bucket: previewAsset.wasabiBucket,
      }, 'Signed tile URL');

      const response: TileSignResponse = { url };
      return reply.send(response);
    } catch (err) {
      request.log.error({ error: err, key }, 'Failed to sign tile URL');
      return reply.status(500).send({ error: 'Failed to sign URL' });
    }
  });

  /**
   * GET /api/v1/tiles/proxy
   * Redirects to a presigned URL for tile access.
   * This allows OpenSeadragon to use a stable URL that redirects to Wasabi.
   */
  fastify.get('/api/v1/tiles/proxy', async (
    request: FastifyRequest<{ Querystring: { key?: string; expires_seconds?: string } }>,
    reply: FastifyReply
  ) => {
    const { key, expires_seconds } = request.query;

    // Validate key is provided
    if (!key || typeof key !== 'string') {
      return reply.status(400).send({ error: 'Missing required query parameter: key' });
    }

    // Security: Validate key format to prevent path traversal
    // Must start with "previews/", contain "/tiles/", end with valid extension, no ".."
    const validExtensions = /\.(jpg|jpeg|png)$/i;
    if (!key.startsWith('previews/')) {
      return reply.status(400).send({ error: 'Invalid key: must start with "previews/"' });
    }
    // Support both /tiles/ (legacy) and /preview_tiles/ (rebased preview)
    if (!key.includes('/tiles/') && !key.includes('/preview_tiles/')) {
      return reply.status(400).send({ error: 'Invalid key: must contain "/tiles/" or "/preview_tiles/"' });
    }
    if (!validExtensions.test(key)) {
      return reply.status(400).send({ error: 'Invalid key: must end with .jpg, .jpeg, or .png' });
    }
    if (key.includes('..')) {
      return reply.status(400).send({ error: 'Invalid key: path traversal not allowed' });
    }

    // Parse expires_seconds (default 300)
    const expiresSeconds = expires_seconds ? parseInt(expires_seconds, 10) : 300;
    if (isNaN(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > 3600) {
      return reply.status(400).send({ error: 'expires_seconds must be between 60 and 3600' });
    }

    // Extract slide_id from key
    const slideId = extractSlideIdFromKey(key);
    if (!slideId) {
      return reply.status(403).send({ error: 'Invalid key format - cannot determine slide_id' });
    }

    try {
      // Verify that we have a preview for this slide
      const previewAsset = await prisma.previewAsset.findUnique({
        where: { slideId },
      });

      if (!previewAsset) {
        return reply.status(403).send({ error: 'No preview found for this slide' });
      }

      // Validate the key is within the allowed prefix
      const allowedPrefixes = [
        previewAsset.wasabiPrefix,
        previewAsset.lowTilesPrefix,
        previewAsset.thumbKey.substring(0, previewAsset.thumbKey.lastIndexOf('/')),
      ];

      const isAllowed = allowedPrefixes.some((prefix) => key.startsWith(prefix));

      if (!isAllowed) {
        return reply.status(403).send({ error: 'Key is not within allowed preview prefix' });
      }

      // Use previewAsset's endpoint/region for signing
      const clientConfig = {
        endpoint: previewAsset.wasabiEndpoint,
        region: previewAsset.wasabiRegion,
      };

      // Generate presigned URL
      const presignedUrl = await getSignedUrlForKey(
        key,
        expiresSeconds,
        previewAsset.wasabiBucket,
        clientConfig
      );

      // Redirect to the presigned URL
      return reply.status(302).redirect(presignedUrl);
    } catch (err) {
      request.log.error({ error: err, key }, 'Failed to generate presigned URL for proxy');
      return reply.status(500).send({ error: 'Failed to generate presigned URL' });
    }
  });
  // ==========================================================================
  // Slide linking/unlinking (authenticated via JWT)
  // ==========================================================================

  /**
   * GET /api/v1/slides/unlinked
   * Returns slides not linked to any case (have preview, last 7 days)
   */
  fastify.get('/api/v1/slides/unlinked', {
    preHandler: authenticate,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    try {
      const slides = await prisma.slideRead.findMany({
        where: {
          caseId: null,
          hasPreview: true,
          updatedAt: { gte: since },
        },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });

      return reply.send({
        slides: slides.map(s => ({
          slideId: s.slideId,
          filename: s.svsFilename,
          thumbUrl: `/preview/${s.slideId}/thumb.jpg`,
          width: s.width,
          height: s.height,
          createdAt: s.updatedAt.toISOString(),
        })),
      });
    } catch (err) {
      request.log.error({ error: err }, 'Failed to fetch unlinked slides');
      return reply.status(500).send({ error: 'Failed to fetch unlinked slides' });
    }
  });

  /**
   * POST /api/v1/slides/:slideId/link
   * Link a slide to a case by setting case_id
   */
  fastify.post<{
    Params: { slideId: string };
    Body: { caseId: string };
  }>('/api/v1/slides/:slideId/link', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { slideId } = request.params;
    const { caseId } = request.body;

    if (!caseId) {
      return reply.status(400).send({ error: 'caseId is required' });
    }

    try {
      const [slide, caseData] = await Promise.all([
        prisma.slideRead.findUnique({ where: { slideId } }),
        prisma.caseRead.findUnique({ where: { caseId } }),
      ]);

      if (!slide) {
        return reply.status(404).send({ error: 'Slide not found' });
      }
      if (!caseData) {
        return reply.status(404).send({ error: 'Case not found' });
      }

      await prisma.slideRead.update({
        where: { slideId },
        data: {
          caseId,
          confirmedCaseLink: true,
          // Propagate externalCaseBase so the extension also sees this slide
          ...(caseData.patientRef ? { externalCaseBase: caseData.patientRef } : {}),
        },
      });

      await prisma.viewerAuditLog.create({
        data: {
          slideId,
          action: 'slide_linked',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] || null,
          metadata: { source: 'viewer-frontend', caseId },
        },
      });

      request.log.info({ slideId, caseId }, 'Slide linked to case');
      return reply.send({ ok: true, slideId, caseId });
    } catch (err) {
      request.log.error({ error: err }, 'Failed to link slide');
      return reply.status(500).send({ error: 'Failed to link slide' });
    }
  });

  /**
   * POST /api/v1/slides/:slideId/unlink
   * Remove a slide from its case
   */
  fastify.post<{
    Params: { slideId: string };
  }>('/api/v1/slides/:slideId/unlink', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { slideId } = request.params;

    try {
      const slide = await prisma.slideRead.findUnique({ where: { slideId } });
      if (!slide) {
        return reply.status(404).send({ error: 'Slide not found' });
      }

      const previousCaseId = slide.caseId;

      await prisma.slideRead.update({
        where: { slideId },
        data: {
          caseId: null,
          externalCaseId: null,
          externalCaseBase: null,
          confirmedCaseLink: false,
        },
      });

      await prisma.viewerAuditLog.create({
        data: {
          slideId,
          action: 'slide_unlinked',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] || null,
          metadata: { source: 'viewer-frontend', previousCaseId },
        },
      });

      request.log.info({ slideId, previousCaseId }, 'Slide unlinked from case');
      return reply.send({ ok: true, slideId });
    } catch (err) {
      request.log.error({ error: err }, 'Failed to unlink slide');
      return reply.status(500).send({ error: 'Failed to unlink slide' });
    }
  });
}

export default readRoutes;
