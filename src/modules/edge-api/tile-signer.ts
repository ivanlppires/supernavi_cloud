import { FastifyInstance } from 'fastify';
import { prisma } from '../../db/index.js';
import config from '../../config/index.js';
import { getSignedUrlForKey } from '../wasabi/wasabiSigner.js';

export async function tileSignerRoutes(fastify: FastifyInstance) {
  // GET /api/v1/slides/:slideId/dzi.xml
  // Returns DZI XML for OpenSeadragon. No auth required - READY gate is sufficient.
  fastify.get<{ Params: { slideId: string } }>(
    '/api/v1/slides/:slideId/dzi.xml',
    async (request, reply) => {
      const { slideId } = request.params;

      const slide = await prisma.slideRead.findUnique({ where: { slideId } });
      if (!slide || slide.cloudStatus !== 'READY') {
        return reply.code(404).send({ error: 'Slide not found or not ready' });
      }

      const tileSize = 256;
      const overlap = 0;
      const format = 'jpg';

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
  Format="${format}"
  Overlap="${overlap}"
  TileSize="${tileSize}">
  <Size Width="${slide.width}" Height="${slide.height}"/>
</Image>`;

      reply.header('Content-Type', 'application/xml');
      reply.header('Cache-Control', 'public, max-age=3600');
      return xml;
    },
  );

  // GET /api/v1/tiles/:slideId/:level/:file
  // 302 redirect to presigned Wasabi URL.
  // :file = {col}_{row}.jpg (matches vips dzsave output)
  fastify.get<{ Params: { slideId: string; level: string; file: string } }>(
    '/api/v1/tiles/:slideId/:level/:file',
    async (request, reply) => {
      const { slideId, level, file } = request.params;

      // Input validation: level must be numeric, file must match tile pattern
      if (!/^\d+$/.test(level)) {
        return reply.code(400).send({ error: 'Invalid level' });
      }
      if (!/^\d+_\d+\.jpe?g$/.test(file)) {
        return reply.code(400).send({ error: 'Invalid tile filename' });
      }

      const slide = await prisma.slideRead.findUnique({ where: { slideId } });
      if (!slide || slide.cloudStatus !== 'READY' || !slide.s3Prefix) {
        return reply.code(404).send({ error: 'Slide not ready' });
      }

      // S3 key: labs/{labId}/slides/{slideId}/dzi/{level}/{col}_{row}.jpg
      const s3Key = `${slide.s3Prefix}${level}/${file}`;

      const signedUrl = await getSignedUrlForKey(s3Key, config.SIGNED_URL_TTL_SECONDS);

      reply.header('Cache-Control', 'private, max-age=60');
      return reply.redirect(signedUrl);
    },
  );

  // GET /api/v1/slides/:slideId/thumb
  // 302 redirect to presigned thumbnail URL
  fastify.get<{ Params: { slideId: string } }>(
    '/api/v1/slides/:slideId/thumb',
    async (request, reply) => {
      const { slideId } = request.params;

      const slide = await prisma.slideRead.findUnique({ where: { slideId } });
      if (!slide || !slide.s3Prefix) {
        return reply.code(404).send({ error: 'Slide not found' });
      }

      const s3Key = `${slide.s3Prefix}thumb.jpg`;
      const signedUrl = await getSignedUrlForKey(s3Key, 300);

      return reply.redirect(signedUrl);
    },
  );
}
